import { CUE_TRIGGERS, type CueTrigger } from '@/types/cue'
import type { Cue } from '@/types/cue'
import type { Fixture } from '@/types/fixture'
import type { CueLevel } from '@/types/level'
import type { Session } from '@/types/session'
import { COLOR_TEMP_MAX, COLOR_TEMP_MIN, DMX_CHANNEL_MAX, DMX_CHANNEL_MIN, INTENSITY_MAX, INTENSITY_MIN } from '@/types'
import {
  CONSOLE_FIELD_LABELS,
  CONSOLE_PACKET_FORMAT,
  CONSOLE_PACKET_VERSION,
  type ConsoleCueField,
  type ConsoleCueSnapshot,
  type ConsolePacketCue,
  type ConsolePacketLevel,
  type ConsolePacketSession,
  type ConsoleReturnPacket,
  type ConsoleSessionMapping,
  type ConsoleUnitPlanEntry,
  type ReconcileItem
} from '@/types/console'
import { createId } from '@/utils/id'
import { normalizeCueNo } from '@/utils/cueOrder'

/** 解析 / 校验结果 */
export interface ParsedConsolePacket {
  ok: boolean
  packet: ConsoleReturnPacket | null
  error: string | null
}

/** 单个对账单元的本地数据上下文（由 store 按映射场次预先切片） */
export interface ReconcileUnitContext {
  batchId: string
  /** 已有对账项之后的起始次序，保证续跑次序连续 */
  ordinalSeed: number
  localCues: Cue[]
  fixtures: Fixture[]
  levelsByCue: Map<string, CueLevel[]>
}

/** 一个对账单元：回传包中的一条 Cue，或控制台缺失、仅本地存在的一条 Cue */
export interface ReconcileUnit {
  sessionId: string | null
  sessionRef: string
  packetCue: ConsolePacketCue | null
  localCue: Cue | null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析粘贴的控制台回传包文本。
 * 严格校验：结构必须可识别，逐字段取值，非法字段给出明确错误，不做静默丢弃。
 */
export function parseConsolePacket(raw: string): ParsedConsolePacket {
  const text = raw.trim()
  if (!text) return { ok: false, packet: null, error: '回传包内容为空' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, packet: null, error: '回传包不是合法 JSON，请确认复制完整' }
  }
  if (!isRecord(parsed)) return { ok: false, packet: null, error: '回传包结构无效：顶层应为对象' }
  if (parsed.format !== CONSOLE_PACKET_FORMAT) {
    return { ok: false, packet: null, error: `格式标识不匹配：应为 ${CONSOLE_PACKET_FORMAT}` }
  }
  if (parsed.version !== CONSOLE_PACKET_VERSION) {
    return { ok: false, packet: null, error: `回传包版本 ${String(parsed.version)} 不受支持，当前支持 v${CONSOLE_PACKET_VERSION}` }
  }
  if (!Array.isArray(parsed.sessions)) {
    return { ok: false, packet: null, error: '回传包缺少 sessions 场次数组' }
  }

  const sessions: ConsolePacketSession[] = []
  for (let si = 0; si < parsed.sessions.length; si += 1) {
    const segment = parsed.sessions[si]
    if (!isRecord(segment)) return { ok: false, packet: null, error: `第 ${si + 1} 个场次段落不是对象` }
    const sessionRef = typeof segment.sessionRef === 'string' ? segment.sessionRef.trim() : ''
    if (!sessionRef) return { ok: false, packet: null, error: `第 ${si + 1} 个场次段落缺少 sessionRef` }
    if (!Array.isArray(segment.cues)) return { ok: false, packet: null, error: `场次「${sessionRef}」缺少 cues 数组` }

    const cues: ConsolePacketCue[] = []
    for (let ci = 0; ci < segment.cues.length; ci += 1) {
      const cue = segment.cues[ci]
      if (!isRecord(cue)) return { ok: false, packet: null, error: `场次「${sessionRef}」第 ${ci + 1} 条 Cue 不是对象` }
      const cueNo = typeof cue.cueNo === 'string' ? normalizeCueNo(cue.cueNo) : ''
      if (!cueNo) return { ok: false, packet: null, error: `场次「${sessionRef}」第 ${ci + 1} 条 Cue 编号缺失或非法` }
      if (cue.trigger !== undefined && !CUE_TRIGGERS.includes(cue.trigger as CueTrigger)) {
        return { ok: false, packet: null, error: `${cueNo} 的触发方式「${String(cue.trigger)}」不在可选范围` }
      }
      const fadeError = checkFadeFields(cue, cueNo)
      if (fadeError) return { ok: false, packet: null, error: fadeError }

      const levels: ConsolePacketLevel[] = []
      if (cue.levels !== undefined) {
        if (!Array.isArray(cue.levels)) return { ok: false, packet: null, error: `${cueNo} 的 levels 不是数组` }
        for (let li = 0; li < cue.levels.length; li += 1) {
          const level = cue.levels[li]
          if (!isRecord(level)) return { ok: false, packet: null, error: `${cueNo} 第 ${li + 1} 个通道电平不是对象` }
          if (
            !Number.isInteger(level.channel) ||
            (level.channel as number) < DMX_CHANNEL_MIN ||
            (level.channel as number) > DMX_CHANNEL_MAX
          ) {
            return { ok: false, packet: null, error: `${cueNo} 第 ${li + 1} 个通道号无效（需 ${DMX_CHANNEL_MIN}-${DMX_CHANNEL_MAX} 整数）` }
          }
          if (
            level.intensity !== undefined &&
            (!isFiniteNumber(level.intensity) || level.intensity < INTENSITY_MIN || level.intensity > INTENSITY_MAX)
          ) {
            return { ok: false, packet: null, error: `${cueNo} CH${level.channel} 亮度需在 ${INTENSITY_MIN}-${INTENSITY_MAX} 之间` }
          }
          if (
            level.colorTempK !== undefined &&
            (!isFiniteNumber(level.colorTempK) || level.colorTempK < COLOR_TEMP_MIN || level.colorTempK > COLOR_TEMP_MAX)
          ) {
            return { ok: false, packet: null, error: `${cueNo} CH${level.channel} 色温需在 ${COLOR_TEMP_MIN}-${COLOR_TEMP_MAX}K 之间` }
          }
          levels.push({
            channel: level.channel as number,
            intensity: level.intensity as number | undefined,
            colorTempK: level.colorTempK as number | undefined,
            focusNote: typeof level.focusNote === 'string' ? level.focusNote : undefined
          })
        }
      }
      cues.push({
        cueNo,
        label: typeof cue.label === 'string' ? cue.label : undefined,
        trigger: cue.trigger as CueTrigger | undefined,
        fadeInSec: cue.fadeInSec as number | undefined,
        fadeOutSec: cue.fadeOutSec as number | undefined,
        holdSec: cue.holdSec as number | undefined,
        note: typeof cue.note === 'string' ? cue.note : undefined,
        levels
      })
    }
    sessions.push({ sessionRef, cues })
  }

  const packet: ConsoleReturnPacket = {
    format: CONSOLE_PACKET_FORMAT,
    version: CONSOLE_PACKET_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : undefined,
    note: typeof parsed.note === 'string' ? parsed.note : undefined,
    sessions
  }
  return { ok: true, packet, error: null }
}

function checkFadeFields(cue: Record<string, unknown>, cueNo: string): string | null {
  const fields: Array<['fadeInSec' | 'fadeOutSec' | 'holdSec', string]> = [
    ['fadeInSec', '渐亮时长'],
    ['fadeOutSec', '渐暗时长'],
    ['holdSec', '保持时长']
  ]
  for (const [key, label] of fields) {
    const value = cue[key]
    if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
      return `${cueNo} 的${label}需为不小于 0 的数字`
    }
  }
  return null
}

/** 把回传包规范化为稳定文本（固定键序、缺省补 null），用于内容哈希与幂等判重 */
export function canonicalizePacket(packet: ConsoleReturnPacket): string {
  const normalized = {
    format: packet.format,
    version: packet.version,
    exportedAt: packet.exportedAt ?? null,
    note: packet.note ?? null,
    sessions: packet.sessions.map((segment) => ({
      sessionRef: segment.sessionRef,
      cues: segment.cues.map((cue) => ({
        cueNo: cue.cueNo,
        label: cue.label ?? null,
        trigger: cue.trigger ?? null,
        fadeInSec: cue.fadeInSec ?? null,
        fadeOutSec: cue.fadeOutSec ?? null,
        holdSec: cue.holdSec ?? null,
        note: cue.note ?? null,
        levels: (cue.levels ?? []).map((level) => ({
          channel: level.channel,
          intensity: level.intensity ?? null,
          colorTempK: level.colorTempK ?? null,
          focusNote: level.focusNote ?? null
        }))
      }))
    }))
  }
  return JSON.stringify(normalized)
}

/** 计算回传包内容哈希（SHA-256，非安全上下文下降级为 djb2），同内容再次粘贴不重复写入 */
export async function hashPacketContent(packet: ConsoleReturnPacket): Promise<string> {
  const canonical = canonicalizePacket(packet)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const bytes = new TextEncoder().encode(canonical)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }
  return `djb2-${hashStringDjb2(canonical)}`
}

function hashStringDjb2(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

/** 依据 sessionRef（名称全等，或纯数字序号全等）猜测本地场次 */
export function guessSessionId(sessionRef: string, sessions: readonly Session[]): string | null {
  const ref = sessionRef.trim()
  if (!ref) return null
  const byTitle = sessions.find((session) => session.title === ref)
  if (byTitle) return byTitle.id
  if (/^\d+$/.test(ref)) {
    const order = Number.parseInt(ref, 10)
    const byOrder = sessions.find((session) => session.order === order)
    if (byOrder) return byOrder.id
  }
  return null
}

/** 为回传包所有场次段落生成默认映射（未猜中为 null，导入前可人工指定） */
export function buildDefaultMappings(packet: ConsoleReturnPacket, sessions: readonly Session[]): ConsoleSessionMapping[] {
  return packet.sessions.map((segment) => ({
    sessionRef: segment.sessionRef,
    sessionId: guessSessionId(segment.sessionRef, sessions)
  }))
}

/** 控制台 Cue 全字段快照：缺省字段沿用新建默认值，采纳新 Cue 时使用 */
export function buildCueSnapshot(cue: ConsolePacketCue): ConsoleCueSnapshot {
  return {
    cueNo: cue.cueNo,
    label: cue.label ?? '',
    trigger: cue.trigger ?? '手动',
    fadeInSec: cue.fadeInSec ?? 3,
    fadeOutSec: cue.fadeOutSec ?? 3,
    holdSec: cue.holdSec ?? 5,
    note: cue.note ?? ''
  }
}

/**
 * 展开对账单元：回传包内每条 Cue 一个单元；映射成功的场次再补充
 * 「控制台没给出、仅本地存在」的 Cue 单元（纯提示，默认沿用本地版本）。
 * 未映射场次的段落只展开回传 Cue（其对账项会落在 unmatched，不产生写入）。
 */
export function buildReconcileUnits(
  packet: ConsoleReturnPacket,
  mappings: readonly ConsoleSessionMapping[],
  localData: { sessions: Session[]; cues: Cue[] }
): ReconcileUnit[] {
  const units: ReconcileUnit[] = []
  const mappingByRef = new Map(mappings.map((mapping) => [mapping.sessionRef, mapping.sessionId]))

  packet.sessions.forEach((segment) => {
    const sessionId = mappingByRef.get(segment.sessionRef) ?? null
    const localCuesOfSession = sessionId ? localData.cues.filter((cue) => cue.sessionId === sessionId) : []
    const packetCueNos = new Set(segment.cues.map((cue) => cue.cueNo))

    segment.cues.forEach((packetCue) => {
      const localCue = localCuesOfSession.find((cue) => normalizeCueNo(cue.cueNo) === packetCue.cueNo) ?? null
      units.push({ sessionId, sessionRef: segment.sessionRef, packetCue, localCue })
    })

    localCuesOfSession
      .filter((cue) => !packetCueNos.has(normalizeCueNo(cue.cueNo)))
      .forEach((localCue) => {
        units.push({ sessionId, sessionRef: segment.sessionRef, packetCue: null, localCue })
      })
  })

  return units
}

/**
 * 冻结对账单元清单：批次创建时落库，检查点重试据此恢复完全一致的单元顺序，
 * 不受重试时本地 Cue 增删影响（本地 Cue 被删除则按「控制台独有」处理）。
 */
export function buildUnitPlan(
  packet: ConsoleReturnPacket,
  mappings: readonly ConsoleSessionMapping[],
  localData: { cues: Cue[] }
): ConsoleUnitPlanEntry[] {
  const mappingByRef = new Map(mappings.map((mapping) => [mapping.sessionRef, mapping.sessionId]))
  const entries: ConsoleUnitPlanEntry[] = []

  packet.sessions.forEach((segment) => {
    const sessionId = mappingByRef.get(segment.sessionRef) ?? null
    const localCuesOfSession = sessionId ? localData.cues.filter((cue) => cue.sessionId === sessionId) : []
    const packetCueNos = new Set(segment.cues.map((cue) => cue.cueNo))

    segment.cues.forEach((packetCue) => {
      const localCue = localCuesOfSession.find((cue) => normalizeCueNo(cue.cueNo) === packetCue.cueNo) ?? null
      entries.push({ sessionRef: segment.sessionRef, sessionId, cueNo: packetCue.cueNo, cueId: localCue?.id ?? null })
    })

    localCuesOfSession
      .filter((cue) => !packetCueNos.has(normalizeCueNo(cue.cueNo)))
      .forEach((localCue) => {
        entries.push({ sessionRef: segment.sessionRef, sessionId, cueNo: null, cueId: localCue.id })
      })
  })

  return entries
}

/**
 * 按冻结清单恢复对账单元（检查点重试用）：
 * 回传 Cue 从包中重取，本地 Cue 从当前 store 按 cueId / 编号重取；
 * 若本地 Cue 已被删除，则作为控制台独有单元继续对账。
 */
export function unitsFromPlan(
  packet: ConsoleReturnPacket,
  plan: readonly ConsoleUnitPlanEntry[],
  localData: { cues: Cue[] }
): ReconcileUnit[] {
  const packetCueByKey = new Map<string, ConsolePacketCue>()
  packet.sessions.forEach((segment) => {
    segment.cues.forEach((cue) => packetCueByKey.set(`${segment.sessionRef}@@@${cue.cueNo}`, cue))
  })
  const cueById = new Map(localData.cues.map((cue) => [cue.id, cue]))

  return plan.map((entry) => {
    const packetCue = entry.cueNo ? packetCueByKey.get(`${entry.sessionRef}@@@${entry.cueNo}`) ?? null : null
    let localCue = entry.cueId ? cueById.get(entry.cueId) ?? null : null
    // cueId 失效（Cue 被删后又按同号新建）时，退回按当前映射场次 + 编号匹配
    if (!localCue && packetCue && entry.sessionId) {
      localCue =
        localData.cues.find(
          (cue) => cue.sessionId === entry.sessionId && normalizeCueNo(cue.cueNo) === packetCue.cueNo
        ) ?? null
    }
    return { sessionId: entry.sessionId, sessionRef: entry.sessionRef, packetCue, localCue }
  })
}

const CUE_FIELD_KEYS: ConsoleCueField[] = ['label', 'trigger', 'fadeInSec', 'fadeOutSec', 'holdSec', 'note']

function valuesEqual(left: string | number | null, right: string | number | null): boolean {
  if (left === null || right === null) return false
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
  return left === right
}

function displayFieldValue(field: ConsoleCueField, value: string | number | null | undefined): string | number | null {
  if (value === null || value === undefined) return null
  if (field === 'fadeInSec' || field === 'fadeOutSec' || field === 'holdSec') return Number(value)
  return String(value)
}

function makeItem(
  ctx: ReconcileUnitContext,
  fields: Omit<ReconcileItem, 'id' | 'batchId' | 'ordinal' | 'resolution' | 'resolvedAt' | 'appliedAt'>,
  ordinalRef: { value: number }
): ReconcileItem {
  const item: ReconcileItem = {
    ...fields,
    id: createId('itm'),
    batchId: ctx.batchId,
    ordinal: ordinalRef.value,
    resolution: null,
    resolvedAt: null,
    appliedAt: null
  }
  ordinalRef.value += 1
  return item
}

/**
 * 为单个对账单元生成对账项（纯函数）。
 * 逐项原则：Cue 字段逐个比、通道逐个比；值不同保留两个来源并置 conflict，绝不先覆盖本地。
 */
export function buildItemsForUnit(unit: ReconcileUnit, ctx: ReconcileUnitContext): ReconcileItem[] {
  const ordinalRef = { value: ctx.ordinalSeed }

  // 控制台没给出、仅本地存在的 Cue：提示项，旧 / 本地数据按本地版本兼容显示
  if (!unit.packetCue && unit.localCue) {
    return [
      makeItem(
        ctx,
        {
          sessionId: unit.sessionId,
          cueNo: unit.localCue.cueNo,
          kind: 'cue-missing',
          label: `${unit.localCue.cueNo}（控制台未给出）`,
          localValue: unit.localCue.label || '（未填写提示语）',
          consoleValue: null,
          status: 'local-only',
          note: '回传包未包含该 Cue，默认沿用本地版本'
        },
        ordinalRef
      )
    ]
  }

  const packetCue = unit.packetCue
  if (!packetCue) return []

  const items: ReconcileItem[] = []

  if (!unit.localCue) {
    // 控制台独有 Cue：整条一项，采纳后新建到指定场次；场次未映射则不可写入
    items.push(
      makeItem(
        ctx,
        {
          sessionId: unit.sessionId,
          cueNo: packetCue.cueNo,
          kind: 'cue',
          label: `${packetCue.cueNo}（本地缺失）`,
          localValue: null,
          consoleValue: buildCueSummary(packetCue),
          status: unit.sessionId ? 'console-only' : 'unmatched',
          cuePayload: buildCueSnapshot(packetCue),
          note: unit.sessionId ? '本地没有该编号 Cue，采纳后新建到映射场次' : '场次未映射，无法写入'
        },
        ordinalRef
      )
    )

    for (const packetLevel of packetCue.levels ?? []) {
      const fixture = unit.sessionId ? ctx.fixtures.find((item) => item.channel === packetLevel.channel) ?? null : null
      items.push(
        makeItem(
          ctx,
          {
            sessionId: unit.sessionId,
            cueNo: packetCue.cueNo,
            kind: 'channel',
            channel: packetLevel.channel,
            fixtureId: fixture ? fixture.id : null,
            label: `${packetCue.cueNo} CH${packetLevel.channel} 电平`,
            localValue: null,
            consoleValue: buildConsoleLevelSummary(packetLevel),
            status: unit.sessionId === null ? 'unmatched' : fixture ? 'console-only' : 'unmatched',
            levelPayload: packetLevel,
            note:
              unit.sessionId === null
                ? '场次未映射，无法写入'
                : fixture
                  ? '随新 Cue 建立通道电平'
                  : '该通道号在本地没有配接'
          },
          ordinalRef
        )
      )
    }
    return items
  }

  // Cue 字段逐项对账：只比对回传包给出的字段
  for (const field of CUE_FIELD_KEYS) {
    if (packetCue[field] === undefined) continue
    const consoleValue = displayFieldValue(field, packetCue[field] as string | number)
    const localValue = displayFieldValue(field, unit.localCue[field])
    items.push(
      makeItem(
        ctx,
        {
          sessionId: unit.sessionId,
          cueNo: packetCue.cueNo,
          kind: 'cue-field',
          field,
          label: `${packetCue.cueNo} ${CONSOLE_FIELD_LABELS[field]}`,
          localValue,
          consoleValue,
          status: valuesEqual(localValue, consoleValue) ? 'identical' : 'conflict'
        },
        ordinalRef
      )
    )
  }

  // 通道电平逐项对账：按通道号匹配本地配接，再比对回传包给出的电平字段
  for (const packetLevel of packetCue.levels ?? []) {
    const fixture = unit.sessionId ? ctx.fixtures.find((item) => item.channel === packetLevel.channel) ?? null : null
    if (!fixture) {
      items.push(
        makeItem(
          ctx,
          {
            sessionId: unit.sessionId,
            cueNo: packetCue.cueNo,
            kind: 'channel',
            channel: packetLevel.channel,
            fixtureId: null,
            label: `${packetCue.cueNo} CH${packetLevel.channel} 电平`,
            localValue: null,
            consoleValue: buildConsoleLevelSummary(packetLevel),
            status: 'unmatched',
            levelPayload: packetLevel,
            note: unit.sessionId === null ? '场次未映射，无法写入' : '该通道号在本地没有配接'
          },
          ordinalRef
        )
      )
      continue
    }

    const localLevel = (ctx.levelsByCue.get(unit.localCue.id) ?? []).find((level) => level.fixtureId === fixture.id) ?? null
    if (!localLevel) {
      items.push(
        makeItem(
          ctx,
          {
            sessionId: unit.sessionId,
            cueNo: packetCue.cueNo,
            kind: 'channel',
            channel: packetLevel.channel,
            fixtureId: fixture.id,
            label: `${packetCue.cueNo} CH${packetLevel.channel} 电平`,
            localValue: null,
            consoleValue: buildConsoleLevelSummary(packetLevel),
            status: 'console-only',
            levelPayload: packetLevel,
            note: '本地 Cue 尚未设定该通道电平'
          },
          ordinalRef
        )
      )
      continue
    }

    items.push(
      makeItem(
        ctx,
        {
          sessionId: unit.sessionId,
          cueNo: packetCue.cueNo,
          kind: 'channel',
          channel: packetLevel.channel,
          fixtureId: fixture.id,
          label: `${packetCue.cueNo} CH${packetLevel.channel} 电平`,
          localValue: buildLocalLevelSummary(localLevel, packetLevel),
          consoleValue: buildConsoleLevelSummary(packetLevel),
          status: levelValuesEqual(packetLevel, localLevel) ? 'identical' : 'conflict',
          levelPayload: packetLevel
        },
        ordinalRef
      )
    )
  }

  return items
}

function levelValuesEqual(packetLevel: ConsolePacketLevel, localLevel: CueLevel): boolean {
  if (packetLevel.intensity !== undefined && packetLevel.intensity !== localLevel.intensity) return false
  if (packetLevel.colorTempK !== undefined && Math.round(packetLevel.colorTempK) !== localLevel.colorTempK) return false
  if (packetLevel.focusNote !== undefined && packetLevel.focusNote !== localLevel.focusNote) return false
  return true
}

function buildCueSummary(cue: ConsolePacketCue): string {
  const parts = [`提示语 ${cue.label ?? '—'}`]
  if (cue.trigger) parts.push(`触发 ${cue.trigger}`)
  if (cue.fadeInSec !== undefined) parts.push(`渐亮 ${cue.fadeInSec}s`)
  if (cue.fadeOutSec !== undefined) parts.push(`渐暗 ${cue.fadeOutSec}s`)
  if (cue.holdSec !== undefined) parts.push(`保持 ${cue.holdSec}s`)
  return parts.join(' / ')
}

function buildConsoleLevelSummary(level: ConsolePacketLevel): string {
  const parts: string[] = []
  if (level.intensity !== undefined) parts.push(`亮度 ${level.intensity}%`)
  if (level.colorTempK !== undefined) parts.push(`色温 ${level.colorTempK}K`)
  if (level.focusNote) parts.push(`对焦 ${level.focusNote}`)
  return parts.join(' / ') || '（无改动字段）'
}

function buildLocalLevelSummary(localLevel: CueLevel, packetLevel: ConsolePacketLevel): string {
  const parts: string[] = []
  if (packetLevel.intensity !== undefined) parts.push(`亮度 ${localLevel.intensity}%`)
  if (packetLevel.colorTempK !== undefined) parts.push(`色温 ${localLevel.colorTempK}K`)
  if (packetLevel.focusNote !== undefined) parts.push(`对焦 ${localLevel.focusNote || '—'}`)
  return parts.join(' / ') || '（无改动字段）'
}
