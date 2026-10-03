import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ConsoleBatch,
  ConsoleImportResult,
  ConsoleSessionMapping,
  ReconcileItem,
  ReconcileResolution
} from '@/types/console'
import { CONSOLE_IMPORT_CHUNK_SIZE, type ConsoleCueSnapshot } from '@/types/console'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import {
  buildDefaultMappings,
  buildItemsForUnit,
  buildUnitPlan,
  hashPacketContent,
  parseConsolePacket,
  unitsFromPlan,
  type ReconcileUnitContext
} from '@/utils/consolePacket'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'

/** 开始导入的入参 */
export interface StartImportInput {
  /** 粘贴的回传包原文 */
  raw: string
  /** 人工确认的场次映射；不传时按 sessionRef 自动猜测 */
  mappings?: ConsoleSessionMapping[]
  note?: string
  /**
   * 仅用于演示检查点：处理到第 N 个分片时抛错中断。
   * 真实导入不传，分片落库本身失败也会走同一条失败路径。
   */
  failAtChunk?: number
}

/** 可写入裁决的状态 */
const ACTIONABLE_STATUSES = new Set<ReconcileItem['status']>(['conflict', 'console-only'])

/**
 * 落库前去响应式：批次记录里带有嵌套数组（场次映射、单元清单），
 * 直接 put 响应式对象在部分 IndexedDB 实现下结构化克隆会失败，统一转成纯快照。
 */
function plainSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 控制台回传包仓库：
 * - 粘贴文本 → 解析校验 → 内容哈希判重（同包重复粘贴不重复写入）
 * - 分片对账，检查点落库；失败后从检查点重试，已对账进度保留
 * - 逐项裁决保留两个来源，确认后的控制台值只更新映射场次，不触碰排演表快照
 */
export const useConsoleStore = defineStore('console', () => {
  const batches = ref<ConsoleBatch[]>([])
  const items = ref<ReconcileItem[]>([])
  const hydrated = ref(false)
  /** 分片处理中标记，防止重复触发 */
  const running = ref(false)

  const batchesSorted = computed(() =>
    [...batches.value].sort((a, b) => b.importedAt - a.importedAt || b.updatedAt - a.updatedAt)
  )

  function batchById(id: string): ConsoleBatch | null {
    return batches.value.find((batch) => batch.id === id) ?? null
  }

  function itemsOfBatch(batchId: string): ReconcileItem[] {
    return items.value
      .filter((item) => item.batchId === batchId)
      .sort((a, b) => a.ordinal - b.ordinal)
  }

  function pendingItemsOfBatch(batchId: string): ReconcileItem[] {
    return itemsOfBatch(batchId).filter((item) => item.resolution === null && ACTIONABLE_STATUSES.has(item.status))
  }

  function countsOfBatch(batchId: string): {
    total: number
    identical: number
    conflict: number
    consoleOnly: number
    localOnly: number
    unmatched: number
    pending: number
  } {
    const list = itemsOfBatch(batchId)
    return {
      total: list.length,
      identical: list.filter((item) => item.status === 'identical').length,
      conflict: list.filter((item) => item.status === 'conflict').length,
      consoleOnly: list.filter((item) => item.status === 'console-only').length,
      localOnly: list.filter((item) => item.status === 'local-only').length,
      unmatched: list.filter((item) => item.status === 'unmatched').length,
      pending: pendingItemsOfBatch(batchId).length
    }
  }

  function findBatchByHash(contentHash: string): ConsoleBatch | null {
    return batches.value.find((batch) => batch.contentHash === contentHash) ?? null
  }

  async function hydrate(): Promise<void> {
    const [allBatches, allItems] = await Promise.all([db.consoleBatches.toArray(), db.consoleItems.toArray()])
    batches.value = allBatches
    items.value = allItems
    // 上次会话在分片落库间隙退出：processing 视为中断，保留检查点等待重试
    const stale = allBatches.filter((batch) => batch.status === 'processing')
    for (const batch of stale) {
      await db.consoleBatches.put(
        plainSnapshot({
          ...batch,
          status: 'failed',
          errorMessage: '导入在对账过程中中断，可从检查点重试',
          updatedAt: Date.now()
        })
      )
    }
    if (stale.length > 0) batches.value = await db.consoleBatches.toArray()
    hydrated.value = true
  }

  /**
   * 粘贴回传包并开始导入。
   * 内容哈希相同视为同一批：直接返回既有批次，不再产生任何对账项（幂等）。
   */
  async function startImport(input: StartImportInput): Promise<ConsoleImportResult> {
    const parsed = parseConsolePacket(input.raw)
    if (!parsed.ok || !parsed.packet) {
      return {
        duplicated: false,
        batch: null,
        message: parsed.error ?? '回传包解析失败'
      }
    }
    const packet = parsed.packet
    const sessionStore = useSessionStore()
    const cueStore = useCueStore()
    const contentHash = await hashPacketContent(packet)

    const existed = findBatchByHash(contentHash)
    if (existed) {
      return {
        duplicated: true,
        batch: existed,
        message: '该回传包内容此前已导入，沿用既有对账进度，未重复写入'
      }
    }

    const mappings = input.mappings ?? buildDefaultMappings(packet, sessionStore.sortedSessions)
    const unitPlan = buildUnitPlan(packet, mappings, { cues: cueStore.cues })
    const now = Date.now()
    const batch: ConsoleBatch = {
      id: createId('imp'),
      contentHash,
      sourceText: input.raw.trim(),
      exportedAt: packet.exportedAt && !Number.isNaN(new Date(packet.exportedAt).getTime()) ? new Date(packet.exportedAt).toISOString() : null,
      note: input.note ?? packet.note ?? '',
      status: 'processing',
      sessionMappings: mappings,
      // 单元总数在分片展开后（含本地独有 Cue）回填，先按回传包内 Cue 数估算进度分母
      totalUnits: unitPlan.length,
      unitPlan,
      processedUnits: 0,
      errorMessage: null,
      importedAt: now,
      updatedAt: now,
      appliedAt: null
    }
    await db.consoleBatches.put(plainSnapshot(batch))
    batches.value = [...batches.value, batch]

    await runImportChunks(batch.id, input.failAtChunk)
    const refreshed = batchById(batch.id)
    if (!refreshed) return { duplicated: false, batch: null, message: '导入批次丢失' }
    return {
      duplicated: false,
      batch: refreshed,
      message:
        refreshed.status === 'failed'
          ? `对账中断：${refreshed.errorMessage}（已完成 ${refreshed.processedUnits}/${refreshed.totalUnits}，可从检查点重试）`
          : '对账完成，等待逐项裁决'
    }
  }

  /**
   * 分片对账主循环（首次导入与失败重试共用）。
   * 每个分片结束即把新增对账项与 processedUnits 检查点落库，
   * 中断后重试只处理尚未对账的单元，已核对进度继续保留。
   */
  async function runImportChunks(batchId: string, failAtChunk?: number): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || running.value) return
    running.value = true
    try {
      const parsed = parseConsolePacket(batch.sourceText)
      if (!parsed.ok || !parsed.packet) {
        await markFailed(batchId, parsed.error ?? '回传包解析失败')
        return
      }
      const packet = parsed.packet
      const cueStore = useCueStore()
      const fixtureStore = useFixtureStore()
      const levelStore = useLevelStore()

      // 按创建批次时冻结的单元清单恢复，检查点与单元顺序严格对应
      const units = unitsFromPlan(packet, batch.unitPlan, { cues: cueStore.cues })

      let chunkIndex = Math.floor(batchById(batchId)!.processedUnits / CONSOLE_IMPORT_CHUNK_SIZE)
      let index = batchById(batchId)!.processedUnits
      while (index < units.length) {
        const end = Math.min(index + CONSOLE_IMPORT_CHUNK_SIZE, units.length)
        const chunk = units.slice(index, end)

        const newItems: ReconcileItem[] = []
        for (const unit of chunk) {
          const fixtures = unit.sessionId ? fixtureStore.fixturesOfSession(unit.sessionId) : []
          // 收集映射场次全部 Cue 的电平，供通道逐项对账查询
          const levelsByCue = new Map<string, ReturnType<typeof levelStore.levelsOfCue>>()
          cueStore.cuesOfSession(unit.sessionId ?? '').forEach((cue) => {
            const levels = levelStore.levelsOfCue(cue.id)
            if (levels.length > 0) levelsByCue.set(cue.id, levels)
          })
          const context: ReconcileUnitContext = {
            batchId,
            ordinalSeed: items.value.filter((item) => item.batchId === batchId).length + newItems.length,
            localCues: unit.sessionId ? cueStore.cuesOfSession(unit.sessionId) : [],
            fixtures,
            levelsByCue
          }
          newItems.push(...buildItemsForUnit(unit, context))
        }

        // 单片整体落库：对账项 + 检查点同事务，保证检查点之前的单元一定已对账
        const checkAt = Date.now()
        await db.transaction('rw', db.consoleItems, db.consoleBatches, async () => {
          if (newItems.length > 0) await db.consoleItems.bulkPut(plainSnapshot(newItems))
          await db.consoleBatches.put(plainSnapshot({ ...batchById(batchId)!, processedUnits: end, updatedAt: checkAt }))
        })
        items.value = [...items.value, ...newItems]
        patchBatch(batchId, { processedUnits: end, updatedAt: checkAt })

        index = end
        chunkIndex += 1
        if (failAtChunk !== undefined && chunkIndex === failAtChunk) {
          throw new Error(`模拟在第 ${chunkIndex} 个分片中断（检查点演示）`)
        }
      }

      // 全部单元对账完成：自动了结「两边一致」项（无需写入），
      // local-only / unmatched 保持待人工查看的未裁决但不阻塞批次完结
      const now = Date.now()
      const settled = itemsOfBatch(batchId)
        .filter((item) => item.resolution === null && item.status === 'identical')
        .map<ReconcileItem>((item) => ({ ...item, resolution: 'local', resolvedAt: now }))
      await db.transaction('rw', db.consoleItems, db.consoleBatches, async () => {
        if (settled.length > 0) await db.consoleItems.bulkPut(plainSnapshot(settled))
        await db.consoleBatches.put(plainSnapshot({ ...batchById(batchId)!, status: 'pending', errorMessage: null, updatedAt: now }))
      })
      const settledIds = new Map(settled.map((item) => [item.id, item]))
      items.value = items.value.map((item) => settledIds.get(item.id) ?? item)
      patchBatch(batchId, { status: 'pending', errorMessage: null, updatedAt: now })
      await refreshBatchCompletion(batchId)
    } catch (error) {
      await markFailed(batchId, error instanceof Error ? error.message : String(error))
    } finally {
      running.value = false
    }
  }

  /** 导入失败后从检查点重试；已核对的进度（processedUnits 与已落库对账项）保留 */
  async function retryImport(batchId: string): Promise<ConsoleBatch | null> {
    const batch = batchById(batchId)
    if (!batch) return null
    if (batch.status !== 'failed' && batch.status !== 'processing') return batch
    await patchBatch(batchId, { status: 'processing', errorMessage: null, updatedAt: Date.now() })
    await runImportChunks(batchId)
    return batchById(batchId)
  }

  async function markFailed(batchId: string, message: string): Promise<void> {
    const now = Date.now()
    await patchBatch(batchId, { status: 'failed', errorMessage: message, updatedAt: now })
  }

  /** 更新场次映射（仅在尚未完成对账时允许，修改后按新映射重建单元并重新对账） */
  async function updateMappings(batchId: string, mappings: ConsoleSessionMapping[]): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || batch.status === 'applied') return
    const parsed = parseConsolePacket(batch.sourceText)
    if (!parsed.ok || !parsed.packet) {
      await markFailed(batchId, parsed.error ?? '回传包解析失败')
      return
    }
    const cueStore = useCueStore()
    const unitPlan = buildUnitPlan(parsed.packet, mappings, { cues: cueStore.cues })
    const now = Date.now()
    await db.transaction('rw', db.consoleItems, db.consoleBatches, async () => {
      await db.consoleItems.where('batchId').equals(batchId).delete()
      await db.consoleBatches.put(plainSnapshot({
        ...batch,
        sessionMappings: mappings,
        unitPlan,
        totalUnits: unitPlan.length,
        processedUnits: 0,
        status: 'processing',
        errorMessage: null,
        updatedAt: now
      }))
    })
    items.value = items.value.filter((item) => item.batchId !== batchId)
    batches.value = batches.value.map((item) =>
      item.id === batchId
        ? { ...item, sessionMappings: mappings, unitPlan, totalUnits: unitPlan.length, processedUnits: 0, status: 'processing' }
        : item
    )
    await runImportChunks(batchId)
  }

  /**
   * 裁决单条对账项。
   * 选控制台（console / accept）会立刻把确认值写入本地，且只写映射场次；
   * 选本地（local / skip）不改动任何本地数据。排演表快照始终不在此触碰。
   */
  async function resolveItem(itemId: string, resolution: Exclude<ReconcileResolution, null>): Promise<{ ok: boolean; message: string }> {
    const target = items.value.find((item) => item.id === itemId)
    if (!target) return { ok: false, message: '对账项不存在' }

    const batch = batchById(target.batchId)
    if (!batch || batch.status === 'applied') return { ok: false, message: '批次已完结' }
    if (!ACTIONABLE_STATUSES.has(target.status)) return { ok: false, message: '该项无需裁决' }

    if (resolution === 'console' && target.status !== 'conflict') {
      return { ok: false, message: '仅冲突项可裁决为控制台值' }
    }
    if (resolution === 'accept' && target.status !== 'console-only') {
      return { ok: false, message: '仅控制台独有项可采纳' }
    }

    const apply = resolution === 'console' || resolution === 'accept'
    if (apply) {
      const writeResult = await applyItemToLocal(target)
      if (!writeResult.ok) return writeResult
    }

    const now = Date.now()
    const next: ReconcileItem = {
      ...target,
      resolution,
      resolvedAt: now,
      appliedAt: apply ? now : target.appliedAt
    }
    await db.consoleItems.put(plainSnapshot(next))
    items.value = items.value.map((item) => (item.id === itemId ? next : item))
    await refreshBatchCompletion(target.batchId)
    return { ok: true, message: apply ? '已按控制台值更新本地（仅本场次）' : '已保留本地值' }
  }

  /**
   * 把确认的控制台值写到本地，严格限定在对账项映射的场次内：
   * - cue 字段：只更新该字段；
   * - 整条新 Cue：新建到映射场次（按编号落位）；
   * - 通道电平：只写回传包给出的字段；新 Cue 未采纳时拒绝写入。
   */
  async function applyItemToLocal(item: ReconcileItem): Promise<{ ok: boolean; message: string }> {
    if (!item.sessionId) return { ok: false, message: '场次未映射，无法写入' }
    const cueStore = useCueStore()
    const levelStore = useLevelStore()

    if (item.kind === 'cue' && item.cuePayload) {
      const payload: ConsoleCueSnapshot = item.cuePayload
      const created = await cueStore.addCue({
        sessionId: item.sessionId,
        cueNo: payload.cueNo,
        label: payload.label,
        trigger: payload.trigger,
        fadeInSec: payload.fadeInSec,
        fadeOutSec: payload.fadeOutSec,
        holdSec: payload.holdSec,
        note: payload.note
      })
      await cueStore.sortByCueNo(item.sessionId)
      return { ok: true, message: `已新建 ${created.cueNo} 到映射场次` }
    }

    const localCue = cueStore.cuesOfSession(item.sessionId).find((cue) => cue.cueNo === item.cueNo) ?? null
    if (!localCue) {
      return { ok: false, message: `请先采纳新 Cue ${item.cueNo}，再写入其通道电平` }
    }

    if (item.kind === 'cue-field' && item.field) {
      const field = item.field
      const patch: Record<string, string | number> = { [field]: item.consoleValue as string | number }
      await cueStore.updateCue(localCue.id, patch as Parameters<typeof cueStore.updateCue>[1])
      return { ok: true, message: `已更新 ${item.cueNo} 的字段` }
    }

    if (item.kind === 'channel' && item.fixtureId && item.levelPayload) {
      await levelStore.upsertLevel(localCue.id, item.fixtureId, {
        intensity: item.levelPayload.intensity,
        colorTempK: item.levelPayload.colorTempK,
        focusNote: item.levelPayload.focusNote
      })
      return { ok: true, message: `已更新 ${item.cueNo} CH${item.channel} 电平` }
    }

    return { ok: false, message: '该对账项无法写入本地' }
  }

  /** 撤销裁决（恢复为待处理）；已写入本地的控制台值不自动回滚，由编辑页面再调整 */
  async function resetItem(itemId: string): Promise<void> {
    const target = items.value.find((item) => item.id === itemId)
    if (!target) return
    const next: ReconcileItem = { ...target, resolution: null, resolvedAt: null, appliedAt: null }
    await db.consoleItems.put(plainSnapshot(next))
    items.value = items.value.map((item) => (item.id === itemId ? next : item))
    await refreshBatchCompletion(target.batchId)
  }

  /** 批次内已无待裁决项时标记为 applied */
  async function refreshBatchCompletion(batchId: string): Promise<void> {
    const batch = batchById(batchId)
    if (!batch || batch.status !== 'pending') return
    const pending = pendingItemsOfBatch(batchId).length
    if (pending > 0) return
    const now = Date.now()
    await patchBatch(batchId, { status: 'applied', appliedAt: now, updatedAt: now })
  }

  async function patchBatch(batchId: string, patch: Partial<ConsoleBatch>): Promise<void> {
    const current = batchById(batchId)
    if (!current) return
    const next = { ...current, ...patch }
    batches.value = batches.value.map((batch) => (batch.id === batchId ? next : batch))
    await db.consoleBatches.put(plainSnapshot(next))
  }

  async function removeBatch(batchId: string): Promise<void> {
    await db.transaction('rw', db.consoleBatches, db.consoleItems, async () => {
      await db.consoleItems.where('batchId').equals(batchId).delete()
      await db.consoleBatches.delete(batchId)
    })
    items.value = items.value.filter((item) => item.batchId !== batchId)
    batches.value = batches.value.filter((batch) => batch.id !== batchId)
  }

  /** 删除场次时级联清理其导入批次与对账项 */
  async function removeBySession(sessionId: string): Promise<void> {
    const targetBatches = batches.value.filter((batch) => batch.sessionMappings.some((mapping) => mapping.sessionId === sessionId))
    if (targetBatches.length === 0) return
    const ids = targetBatches.map((batch) => batch.id)
    await db.transaction('rw', db.consoleBatches, db.consoleItems, async () => {
      await db.consoleItems.where('batchId').anyOf(ids).delete()
      await db.consoleBatches.bulkDelete(ids)
    })
    items.value = items.value.filter((item) => !ids.includes(item.batchId))
    batches.value = batches.value.filter((batch) => !ids.includes(batch.id))
  }

  return {
    batches,
    items,
    hydrated,
    running,
    batchesSorted,
    batchById,
    itemsOfBatch,
    pendingItemsOfBatch,
    countsOfBatch,
    findBatchByHash,
    hydrate,
    startImport,
    retryImport,
    runImportChunks,
    updateMappings,
    resolveItem,
    resetItem,
    removeBatch,
    removeBySession
  }
})
