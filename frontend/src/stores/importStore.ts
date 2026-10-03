import { defineStore } from 'pinia'
import { computed, isProxy, ref, toRaw } from 'vue'
import type {
  ApplyEntriesResult,
  ImportEntry,
  ImportEntryDecision,
  ImportPacket,
  ImportPacketCounts
} from '@/types/import'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import {
  countPacketLevels,
  packetFingerprint,
  parseConsolePacket
} from '@/utils/consolePacket'
import { buildReconciliation, type ReconcileDraft } from '@/utils/importReconcile'
import { useCueStore, type CuePatch } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { ConsolePacket, ImportEntryField } from '@/types/import'

/** 粘贴回传包的结果：dup 命中已存在的记录（不重复写入） */
export interface PasteResult {
  status: 'created' | 'duplicate' | 'invalid'
  message: string
  packet: ImportPacket | null
}

/** 完整回传包内容存放在 appMeta 的键前缀 */
const PAYLOAD_KEY_PREFIX = 'import-packet-payload:'

/** 已落库但序号失效的历史条目，排到所有现行条目之后 */
function sortEntries(entries: ImportEntry[]): ImportEntry[] {
  return [...entries].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
}

/** 递归剥离 Vue 响应式代理（toRaw 只处理一层，嵌套的 consoleCue / consoleLevel 也需还原） */
function deepToRaw<T>(value: T): T {
  const unproxied = isProxy(value) ? toRaw(value) : value
  if (Array.isArray(unproxied)) return unproxied.map((item) => deepToRaw(item)) as unknown as T
  if (unproxied && typeof unproxied === 'object') {
    const result: Record<string, unknown> = {}
    Object.keys(unproxied as Record<string, unknown>).forEach((key) => {
      result[key] = deepToRaw((unproxied as Record<string, unknown>)[key])
    })
    return result as T
  }
  return unproxied
}

/** 写入 IndexedDB 前深度剥离 Vue 响应式代理（结构化克隆要求纯对象） */
function plain<T>(value: T): T {
  return structuredClone(deepToRaw(value))
}

function emptyCounts(): ImportPacketCounts {
  return { total: 0, pending: 0, unmapped: 0, resolved: 0, applied: 0, done: false, percent: 100 }
}

function countEntries(entries: ImportEntry[]): ImportPacketCounts {
  if (entries.length === 0) return emptyCounts()
  const pending = entries.filter((entry) => entry.status === 'pending').length
  const unmapped = entries.filter((entry) => entry.status === 'unmapped').length
  const resolved = entries.filter((entry) => entry.status === 'resolved').length
  const applied = entries.filter((entry) => entry.status === 'applied').length
  const total = entries.length
  return {
    total,
    pending,
    unmapped,
    resolved,
    applied,
    done: applied === total,
    percent: Math.round((applied / total) * 100)
  }
}

/**
 * 控制台回传包导入仓库。
 *
 * 负责：粘贴去重（packetId / 内容指纹）、逐项对账（检查点可中断重试）、
 * 人工处理决定（保留两个来源、绝不先覆盖）、确认后按条目幂等应用（失败可续跑）。
 */
export const useImportStore = defineStore('import', () => {
  const packets = ref<ImportPacket[]>([])
  const entries = ref<ImportEntry[]>([])
  const hydrated = ref(false)

  const packetsSorted = computed(() => [...packets.value].sort((a, b) => b.pastedAt - a.pastedAt))

  function packetById(id: string): ImportPacket | null {
    return packets.value.find((packet) => packet.id === id) ?? null
  }

  /** packetId 或内容指纹命中即视为同一回传包（再粘一次不重复写入） */
  function findDuplicate(packetId: string, contentHash: string): ImportPacket | null {
    return (
      packets.value.find((packet) => packet.packetId === packetId || packet.contentHash === contentHash) ?? null
    )
  }

  function entriesOfPacket(packetId: string): ImportEntry[] {
    return sortEntries(entries.value.filter((entry) => entry.packetId === packetId))
  }

  function countsOfPacket(packetId: string): ImportPacketCounts {
    return countEntries(entriesOfPacket(packetId))
  }

  /** 按 Cue 编号分组的条目，供对账工作台展示 */
  function groupedEntriesOfPacket(packetId: string): Array<{ cueNo: string; items: ImportEntry[] }> {
    const groups = new Map<string, ImportEntry[]>()
    entriesOfPacket(packetId).forEach((entry) => {
      const list = groups.get(entry.cueNo)
      if (list) list.push(entry)
      else groups.set(entry.cueNo, [entry])
    })
    return Array.from(groups.entries()).map(([cueNo, items]) => ({ cueNo, items }))
  }

  async function hydrate(): Promise<void> {
    const [packetRecords, entryRecords] = await Promise.all([db.importPackets.toArray(), db.importEntries.toArray()])
    packets.value = packetRecords
    entries.value = entryRecords
    hydrated.value = true
  }

  async function readPayload(recordId: string): Promise<ConsolePacket | null> {
    const raw = await db.appMeta.get(PAYLOAD_KEY_PREFIX + recordId)
    if (!raw) return null
    try {
      return JSON.parse(raw.value) as ConsolePacket
    } catch {
      return null
    }
  }

  async function writePayload(recordId: string, packet: ConsolePacket): Promise<void> {
    await db.appMeta.put({
      key: PAYLOAD_KEY_PREFIX + recordId,
      value: JSON.stringify(packet),
      updatedAt: Date.now()
    })
  }

  async function removePayload(recordId: string): Promise<void> {
    await db.appMeta.delete(PAYLOAD_KEY_PREFIX + recordId)
  }

  /** 粘贴回传包：校验 → 去重 → 落库；自动匹配场次后立即对账 */
  async function pastePacket(raw: string): Promise<PasteResult> {
    const parsed = parseConsolePacket(raw)
    if (!parsed.ok || !parsed.packet) {
      return { status: 'invalid', message: parsed.error ?? '回传包无法识别', packet: null }
    }
    const packet = parsed.packet
    const contentHash = packetFingerprint(packet)
    const duplicate = findDuplicate(packet.packetId, contentHash)
    if (duplicate) {
      return {
        status: 'duplicate',
        message: `该回传包已导入过（${duplicate.stage === 'applied' ? '已全部处理' : '处理中'}），未重复写入`,
        packet: duplicate
      }
    }

    const now = Date.now()
    const record: ImportPacket = {
      id: createId('pkt'),
      packetId: packet.packetId,
      contentHash,
      sessionOrder: packet.sessionOrder ?? null,
      sessionTitle: packet.sessionTitle ?? null,
      targetSessionId: null,
      scope: packet.scope,
      consoleName: packet.consoleName ?? '',
      exportedAt: packet.exportedAt ?? null,
      cueCount: packet.cues.length,
      levelCount: countPacketLevels(packet),
      stage: 'reconciling',
      error: null,
      pastedAt: now,
      updatedAt: now
    }

    // 自动按演出序号匹配本地场次；匹配不到则留待人工指定
    const sessionStore = useSessionStore()
    if (record.sessionOrder !== null) {
      const matched = sessionStore.sortedSessions.find((session) => session.order === record.sessionOrder)
      if (matched) record.targetSessionId = matched.id
    }

    await db.transaction('rw', db.importPackets, db.appMeta, async () => {
      await db.importPackets.put(plain(record))
      await writePayload(record.id, packet)
    })
    packets.value = [...packets.value, record]

    if (record.targetSessionId) {
      try {
        await runReconciliation(record.id)
      } catch (error) {
        // 对账失败停在 reconciling 检查点，用户可从页面重试
        console.error('[gbcuesheet] 回传包对账失败：', error)
      }
    }

    return {
      status: 'created',
      message: record.targetSessionId ? '回传包已导入并完成逐项对账' : '回传包已导入，请先指定写入场次再开始对账',
      packet: record
    }
  }

  /** 指定 / 更换写入场次（仅影响本回传包，不触碰其他场次） */
  async function setTargetSession(recordId: string, sessionId: string | null): Promise<void> {
    const record = packetById(recordId)
    if (!record || record.targetSessionId === sessionId) return
    await persistPacket({ ...record, targetSessionId: sessionId, stage: 'reconciling', error: null, updatedAt: Date.now() })
    // 更换目标场次：旧场次的对账条目全部作废，避免把别的场次的差异带进新场次
    const oldEntryIds = entriesOfPacket(recordId).map((entry) => entry.id)
    if (oldEntryIds.length > 0) {
      await db.importEntries.bulkDelete(oldEntryIds)
      const oldIdSet = new Set(oldEntryIds)
      entries.value = entries.value.filter((entry) => !oldIdSet.has(entry.id))
    }
  }

  async function persistPacket(next: ImportPacket): Promise<void> {
    packets.value = packets.value.map((packet) => (packet.id === next.id ? next : packet))
    await db.importPackets.put(plain(next))
  }

  /**
   * 从检查点执行（或续跑）逐项对账。
   * 已核对（applied / resolved / pending 中保留的决定）进度按 entryKey 保留；
   * 仅补算本地现状新增的差异、清掉已不成立的未决条目。
   */
  async function runReconciliation(recordId: string): Promise<void> {
    const record = packetById(recordId)
    if (!record) throw new Error('回传包记录不存在')
    if (!record.targetSessionId) {
      await persistPacket({ ...record, stage: 'reconciling', error: '请先指定写入场次', updatedAt: Date.now() })
      throw new Error('请先指定写入场次')
    }

    const payload = await readPayload(recordId)
    if (!payload) {
      await persistPacket({ ...record, stage: 'reconciling', error: '回传包内容缺失，无法对账', updatedAt: Date.now() })
      throw new Error('回传包内容缺失')
    }

    const sessionStore = useSessionStore()
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    const targetId = record.targetSessionId
    if (!sessionStore.sessionById(targetId)) {
      await persistPacket({ ...record, stage: 'reconciling', targetSessionId: null, error: '指定场次已不存在，请重新选择', updatedAt: Date.now() })
      throw new Error('指定场次已不存在')
    }

    await persistPacket({ ...record, stage: 'reconciling', error: null, updatedAt: Date.now() })

    const sessionCueIds = new Set(cueStore.cuesOfSession(targetId).map((cue) => cue.id))
    const result = buildReconciliation({
      packetRecordId: recordId,
      packet: payload,
      sessionOrder: record.sessionOrder,
      localCues: cueStore.cuesOfSession(targetId),
      localFixtures: fixtureStore.fixturesOfSession(targetId),
      localLevels: levelStore.levels.filter((level) => sessionCueIds.has(level.cueId)),
      now: Date.now()
    })

    const existing = entriesOfPacket(recordId)
    // 已核对（applied，含「保留本地 / 忽略」这类差异仍在的收口项）也按 entryKey 复用，
    // 保证重新对账不会把已经人工处理完的差异再次变回待处理
    const existingByKey = new Map(existing.map((entry) => [entry.entryKey, entry]))

    const merged: Array<{ draft: ReconcileDraft; reuse?: ImportEntry }> = []
    result.entries.forEach((draft) => {
      merged.push({ draft, reuse: existingByKey.get(draft.entryKey) })
    })

    const draftKeys = new Set(result.entries.map((draft) => draft.entryKey))
    // 现行差异已消失：未决条目直接清除；已应用条目作为历史留痕保留（序号后置）
    const vanishedApplied = existing.filter((entry) => entry.status === 'applied' && !draftKeys.has(entry.entryKey))
    const staleNonApplied = existing.filter((entry) => entry.status !== 'applied' && !draftKeys.has(entry.entryKey))

    // 现行条目按自然顺序编号；历史已应用条目（其差异已消失）排在后面但保留留痕
    const liveCount = merged.length
    const toUpsert: ImportEntry[] = []
    merged.forEach(({ draft, reuse }, index) => {
      if (reuse) {
        const next: ImportEntry = {
          ...reuse,
          sessionOrder: draft.sessionOrder,
          cueNo: draft.cueNo,
          channel: draft.channel,
          localValue: draft.localValue,
          consoleValue: draft.consoleValue,
          localCueId: draft.localCueId ?? reuse.localCueId,
          localFixtureId: draft.localFixtureId !== undefined ? draft.localFixtureId : reuse.localFixtureId,
          consoleCue: draft.consoleCue ?? reuse.consoleCue,
          consoleLevel: draft.consoleLevel ?? reuse.consoleLevel,
          consoleData: draft.consoleData ?? reuse.consoleData,
          message: reuse.status === 'applied' ? reuse.message : draft.message,
          seq: index + 1,
          updatedAt: Date.now()
        }
        // 通道配接补齐后，仅对未决的 unmapped 回到 pending；已确认 / 已应用项维持决定
        if (next.status === 'unmapped' && draft.status === 'pending') {
          next.status = 'pending'
          next.decision = null
        }
        toUpsert.push(next)
      } else {
        toUpsert.push({ ...draft, id: createId('imp'), seq: index + 1 })
      }
    })
    vanishedApplied.forEach((entry, index) => {
      toUpsert.push({ ...entry, seq: liveCount + index + 1 })
    })

    const staleIds = staleNonApplied.map((entry) => entry.id)

    // 按 Cue 分组分块落库：每提交一组即同步内存，构成检查点；
    // 中途异常时已落库并已进内存的分组不会在续跑时重复生成
    const uniqueCueOrder = Array.from(new Set(result.entries.map((draft) => draft.cueNo)))
    for (const cueNo of uniqueCueOrder) {
      const group = toUpsert.filter((entry) => entry.cueNo === cueNo && entry.seq <= liveCount)
      await db.importEntries.bulkPut(plain(group))
      const groupIds = new Set(group.map((entry) => entry.id))
      entries.value = [
        ...entries.value.filter((entry) => !groupIds.has(entry.id)),
        ...group
      ]
    }

    // 重新对账后已不成立、且尚未应用的条目直接清除；已应用条目保留留痕（序号后置）
    const historicalApplied = toUpsert.filter((entry) => entry.seq > liveCount)
    await db.transaction('rw', db.importEntries, async () => {
      if (staleIds.length > 0) await db.importEntries.bulkDelete(staleIds)
      if (historicalApplied.length > 0) await db.importEntries.bulkPut(plain(historicalApplied))
    })

    const staleIdSet = new Set(staleIds)
    const upsertById = new Map(toUpsert.map((entry) => [entry.id, entry]))
    entries.value = entries.value
      .filter((entry) => entry.packetId !== recordId || !staleIdSet.has(entry.id))
      .map((entry) => (entry.packetId === recordId ? (upsertById.get(entry.id) ?? entry) : entry))
    const keepIds = new Set(entries.value.filter((entry) => entry.packetId === recordId).map((entry) => entry.id))
    toUpsert.forEach((entry) => {
      if (!keepIds.has(entry.id)) entries.value.push(entry)
    })

    const refreshed = packetById(recordId)
    const counts = countEntries(entriesOfPacket(recordId))
    const nextStage = counts.done ? 'applied' : 'pending-review'
    await persistPacket({
      ...(refreshed ?? record),
      stage: nextStage,
      error: null,
      updatedAt: Date.now()
    })
  }

  /** 记录一条人工处理决定（两个来源仍保留，仅把决定落到条目上） */
  async function decideEntry(entryId: string, decision: Exclude<ImportEntryDecision, null>): Promise<void> {
    const target = entries.value.find((entry) => entry.id === entryId)
    if (!target || target.status === 'applied') return
    const now = Date.now()
    const next: ImportEntry = { ...target, decision, status: 'resolved', resolvedAt: now, updatedAt: now }
    await db.importEntries.put(plain(next))
    entries.value = entries.value.map((entry) => (entry.id === entryId ? next : entry))
  }

  /** 撤销决定，回到待处理（两来源继续并存） */
  async function resetEntry(entryId: string): Promise<void> {
    const target = entries.value.find((entry) => entry.id === entryId)
    if (!target || target.status === 'applied') return
    const pendingStatus = target.kind === 'level-add' && target.localFixtureId === null ? 'unmapped' : 'pending'
    const next: ImportEntry = {
      ...target,
      decision: null,
      status: pendingStatus,
      resolvedAt: undefined,
      updatedAt: Date.now()
    }
    await db.importEntries.put(plain(next))
    entries.value = entries.value.map((entry) => (entry.id === entryId ? next : entry))
  }

  /** 批量给当前待处理条目下决定（不影响已确认 / 已应用） */
  async function decidePending(recordId: string, decision: Exclude<ImportEntryDecision, null>): Promise<number> {
    const targets = entriesOfPacket(recordId).filter((entry) => entry.status === 'pending')
    const now = Date.now()
    const nextEntries = targets.map((entry) => ({
      ...entry,
      decision,
      status: 'resolved' as const,
      resolvedAt: now,
      updatedAt: now
    }))
    if (nextEntries.length > 0) await db.importEntries.bulkPut(plain(nextEntries))
    const idSet = new Set(nextEntries.map((entry) => entry.id))
    entries.value = entries.value.map((entry) => idSet.has(entry.id) ? nextEntries.find((item) => item.id === entry.id) ?? entry : entry)
    return nextEntries.length
  }

  /**
   * 应用所有「已确认」条目。按工作单元顺序逐条幂等执行；
   * 单条失败不影响已应用进度，记录阻塞原因，可修复本地数据后续跑。
   */
  async function applyResolved(recordId: string): Promise<ApplyEntriesResult> {
    const record = packetById(recordId)
    if (!record) return { applied: 0, waiting: 0, blocked: 0, completed: false, message: '回传包记录不存在' }
    if (!record.targetSessionId) {
      return { applied: 0, waiting: 0, blocked: 0, completed: false, message: '请先指定写入场次' }
    }

    const sessionStore = useSessionStore()
    if (!sessionStore.sessionById(record.targetSessionId)) {
      await persistPacket({ ...record, stage: 'pending-review', error: '指定场次已不存在，请重新选择', updatedAt: Date.now() })
      return { applied: 0, waiting: 0, blocked: 0, completed: false, message: '指定场次已不存在' }
    }

    await persistPacket({ ...record, stage: 'applying', error: null, updatedAt: Date.now() })

    let appliedCount = 0
    let blockedCount = 0
    const queue = entriesOfPacket(recordId).filter((entry) => entry.status === 'resolved')

    for (const entry of queue) {
      try {
        await applyOne(entry, record.targetSessionId)
        appliedCount += 1
      } catch (error) {
        blockedCount += 1
        // 保留 resolved 决定以便续跑，并记下阻塞原因；修复本地数据（补齐 Cue / 通道）后可再次应用
        const message = error instanceof Error ? error.message : '应用失败'
        const next: ImportEntry = { ...entry, status: 'resolved', message, updatedAt: Date.now() }
        await db.importEntries.put(plain(next))
        entries.value = entries.value.map((item) => (item.id === entry.id ? next : item))
      }
    }

    const after = entriesOfPacket(recordId)
    const waiting = after.filter((entry) => entry.status === 'pending' || entry.status === 'unmapped').length
    const completed = countEntries(after).done
    const refreshed = packetById(recordId)
    let message: string | null = null
    if (waiting > 0) message = `还有 ${waiting} 条待人工处理`
    else if (blockedCount > 0) message = `${blockedCount} 条被阻塞（Cue / 通道缺失），补齐本地数据后可重试`
    await persistPacket({
      ...(refreshed ?? record),
      stage: completed ? 'applied' : 'pending-review',
      error: blockedCount > 0 ? message : null,
      updatedAt: Date.now()
    })

    return { applied: appliedCount, waiting, blocked: blockedCount, completed, message }
  }

  /** 标记单条条目为已应用并落库（与对应业务写操作同一次 IndexedDB 事务） */
  async function markApplied(entry: ImportEntry): Promise<void> {
    const now = Date.now()
    const next: ImportEntry = { ...entry, status: 'applied', appliedAt: now, updatedAt: now }
    await db.importEntries.put(plain(next))
    entries.value = entries.value.map((item) => (item.id === entry.id ? next : item))
  }

  /** 幂等应用单条已确认条目 */
  async function applyOne(entry: ImportEntry, targetSessionId: string): Promise<void> {
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()

    if (entry.decision === 'ignore' || entry.decision === 'local') {
      // 保留本地 / 忽略：不写业务数据，仅把条目收口为已处理
      await markApplied(entry)
      return
    }

    // decision === 'console'
    switch (entry.kind) {
      case 'cue-field': {
        const cue = resolveCue(entry, targetSessionId, cueStore)
        const patch = cueFieldPatch(entry.field, entry.consoleData)
        if (!cue) throw new Error(`${entry.cueNo} 在指定场次不存在`)
        if (patch) await cueStore.updateCue(cue.id, patch)
        await markApplied(entry)
        return
      }
      case 'cue-add': {
        const packetCue = entry.consoleCue
        if (!packetCue) throw new Error('控制台 Cue 快照缺失')
        const existing = cueStore.cuesOfSession(targetSessionId).find((cue) => cue.cueNo === entry.cueNo)
        let cueId = existing?.id
        if (!existing) {
          const created = await cueStore.addCue({
            sessionId: targetSessionId,
            cueNo: packetCue.cueNo,
            label: packetCue.label ?? '',
            trigger: packetCue.trigger ?? '手动',
            fadeInSec: packetCue.fadeInSec ?? 3,
            fadeOutSec: packetCue.fadeOutSec ?? 3,
            holdSec: packetCue.holdSec ?? 0,
            note: packetCue.note ?? ''
          })
          cueId = created.id
        }
        // 新建 Cue 携带的通道电平一并写入；通道未配接则跳过（不阻塞 Cue 落库）
        for (const packetLevel of packetCue.levels ?? []) {
          const fixture = fixtureStore.fixturesOfSession(targetSessionId).find((item) => item.channel === packetLevel.channel)
          if (!fixture || !cueId) continue
          await levelStore.upsertLevel(cueId, fixture.id, {
            intensity: packetLevel.intensity ?? 70,
            colorTempK: packetLevel.colorTempK ?? 3200,
            focusNote: packetLevel.focusNote ?? ''
          })
        }
        await markApplied(entry)
        return
      }
      case 'cue-local-only': {
        const cue = resolveCue(entry, targetSessionId, cueStore)
        if (cue) await cueStore.removeCue(cue.id)
        await markApplied(entry)
        return
      }
      case 'level-field': {
        const cue = resolveCue(entry, targetSessionId, cueStore)
        if (!cue) throw new Error(`${entry.cueNo} 在指定场次不存在`)
        const fixtureId = entry.localFixtureId ?? fixtureStore
          .fixturesOfSession(targetSessionId)
          .find((item) => item.channel === entry.channel)?.id
        if (!fixtureId) throw new Error(`${entry.cueNo} CH${entry.channel ?? '?'} 未在指定场次配接`)
        await levelStore.upsertLevel(cue.id, fixtureId, levelFieldPatch(entry.field, entry.consoleData))
        await markApplied(entry)
        return
      }
      case 'level-add': {
        const cue = resolveCue(entry, targetSessionId, cueStore)
        if (!cue) throw new Error(`${entry.cueNo} 在指定场次不存在`)
        const packetLevel = entry.consoleLevel
        if (!packetLevel) throw new Error('控制台通道电平快照缺失')
        const fixture =
          fixtureStore.fixtureById(entry.localFixtureId ?? '') ??
          fixtureStore.fixturesOfSession(targetSessionId).find((item) => item.channel === packetLevel.channel) ??
          null
        if (!fixture) throw new Error(`${entry.cueNo} CH${packetLevel.channel} 未在指定场次配接，请先配接后重试`)
        await levelStore.upsertLevel(cue.id, fixture.id, {
          intensity: packetLevel.intensity ?? 70,
          colorTempK: packetLevel.colorTempK ?? 3200,
          focusNote: packetLevel.focusNote ?? ''
        })
        await markApplied(entry)
        return
      }
      case 'level-local-only': {
        const cue = resolveCue(entry, targetSessionId, cueStore)
        if (cue && entry.localFixtureId) await levelStore.removeLevel(cue.id, entry.localFixtureId)
        await markApplied(entry)
        return
      }
    }
  }

  /** 删除回传包记录及其全部对账条目（不改变业务数据） */
  async function removePacket(recordId: string): Promise<void> {
    await db.transaction('rw', db.importPackets, db.importEntries, db.appMeta, async () => {
      await db.importPackets.delete(recordId)
      await db.importEntries.where('packetId').equals(recordId).delete()
      await removePayload(recordId)
    })
    packets.value = packets.value.filter((packet) => packet.id !== recordId)
    entries.value = entries.value.filter((entry) => entry.packetId !== recordId)
  }

  /** 场次删除时级联：丢弃以该场次为写入目标的回传包与条目 */
  async function removeBySession(sessionId: string): Promise<void> {
    const targets = packets.value.filter((packet) => packet.targetSessionId === sessionId)
    for (const target of targets) {
      // 已全部应用的历史记录留痕也随场次级联清理，避免悬挂引用
      await removePacket(target.id)
    }
  }

  return {
    packets,
    entries,
    hydrated,
    packetsSorted,
    packetById,
    findDuplicate,
    entriesOfPacket,
    countsOfPacket,
    groupedEntriesOfPacket,
    hydrate,
    pastePacket,
    setTargetSession,
    runReconciliation,
    decideEntry,
    resetEntry,
    decidePending,
    applyResolved,
    removePacket,
    removeBySession
  }
})

/** 按编号解析条目锁定的 Cue：优先 stored id，回退到当前场次同编号 */
function resolveCue(
  entry: ImportEntry,
  sessionId: string,
  cueStore: ReturnType<typeof useCueStore>
): { id: string } | null {
  if (entry.localCueId) {
    const direct = cueStore.cueById(entry.localCueId)
    if (direct && direct.sessionId === sessionId) return direct
  }
  return cueStore.cuesOfSession(sessionId).find((cue) => cue.cueNo === entry.cueNo) ?? null
}

function cueFieldPatch(field: ImportEntryField, value: string | number | undefined): CuePatch | null {
  if (value === undefined) return null
  switch (field) {
    case 'label':
      return { label: String(value) }
    case 'trigger':
      return { trigger: String(value) as CuePatch['trigger'] }
    case 'fadeInSec':
      return { fadeInSec: Number(value) }
    case 'fadeOutSec':
      return { fadeOutSec: Number(value) }
    case 'holdSec':
      return { holdSec: Number(value) }
    case 'note':
      return { note: String(value) }
    default:
      return null
  }
}

function levelFieldPatch(
  field: ImportEntryField,
  value: string | number | undefined
): { intensity?: number; colorTempK?: number; focusNote?: string } {
  if (value === undefined) return {}
  switch (field) {
    case 'intensity':
      return { intensity: Number(value) }
    case 'colorTempK':
      return { colorTempK: Number(value) }
    case 'focusNote':
      return { focusNote: String(value) }
    default:
      return {}
  }
}
