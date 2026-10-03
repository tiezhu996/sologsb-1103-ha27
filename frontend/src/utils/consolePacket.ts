import type { CueTrigger } from '@/types/cue'
import { isValidCueNo, normalizeCueNo } from '@/utils/cueOrder'
import { DMX_CHANNEL_MAX, DMX_CHANNEL_MIN } from '@/types/fixture'
import {
  CONSOLE_PACKET_FORMAT,
  PACKET_SCOPES,
  type ConsolePacket,
  type ConsolePacketCue,
  type ConsolePacketLevel,
  type ImportEntryField,
  type PacketScope
} from '@/types/import'

/** 回传包解析结果 */
export interface ParsedPacket {
  ok: boolean
  /** 解析 / 校验失败原因 */
  error: string | null
  packet: ConsolePacket | null
}

/** 触发方式取值集合，用于校验控制台字段 */
const TRIGGER_VALUES = new Set<CueTrigger>(['手动', '跟音乐', '跟台词'])

/** 字段中文标签（对账列表与详情展示） */
export const IMPORT_FIELD_LABELS: Record<NonNullable<ImportEntryField>, string> = {
  cueNo: '编号',
  label: '提示语',
  trigger: '触发方式',
  fadeInSec: '渐亮时长',
  fadeOutSec: '渐暗时长',
  holdSec: '保持时长',
  note: '备注',
  intensity: '亮度',
  colorTempK: '色温',
  focusNote: '对焦说明'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  return undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const num = asFiniteNumber(value)
  if (num === undefined || num < 0) return undefined
  return Math.round(num * 10) / 10
}

function asTrigger(value: unknown): CueTrigger | undefined {
  if (typeof value === 'string' && TRIGGER_VALUES.has(value as CueTrigger)) return value as CueTrigger
  return undefined
}

/** 校验中途的结构性错误，附带面向用户的原因 */
class PacketValidationError extends Error {}

/**
 * 解析并校验粘贴的回传包文本。
 * 容忍尾随空白；严格校验格式标识、覆盖范围、Cue 编号与通道号。
 */
export function parseConsolePacket(raw: string): ParsedPacket {
  try {
    const packet = parsePacketOrThrow(raw)
    return { ok: true, error: null, packet }
  } catch (error) {
    const message = error instanceof PacketValidationError ? error.message : '回传包解析失败'
    return { ok: false, error: message, packet: null }
  }
}

function parsePacketOrThrow(raw: string): ConsolePacket {
  const text = raw.trim()
  if (!text) throw new PacketValidationError('回传包内容为空')

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new PacketValidationError('不是合法的 JSON，请粘贴控制台导出的完整回传包')
  }
  if (!isObject(json)) throw new PacketValidationError('回传包结构应为一个对象')
  if (json.format !== CONSOLE_PACKET_FORMAT) {
    throw new PacketValidationError(`格式标识不符（应为 ${CONSOLE_PACKET_FORMAT}）`)
  }

  const packetId = asString(json.packetId)?.trim()
  if (!packetId) throw new PacketValidationError('缺少回传包标识 packetId')

  const scope = asString(json.scope)
  if (!scope || !(PACKET_SCOPES as readonly string[]).includes(scope)) {
    throw new PacketValidationError(`覆盖范围 scope 必须是 ${PACKET_SCOPES.join(' / ')} 之一`)
  }

  const sessionOrderRaw = asFiniteNumber(json.sessionOrder)
  const sessionOrder = sessionOrderRaw === undefined || sessionOrderRaw < 1 ? null : Math.round(sessionOrderRaw)
  const sessionTitle = asString(json.sessionTitle)?.trim() || null
  if (sessionOrder === null && !sessionTitle) {
    throw new PacketValidationError('回传包需至少携带 sessionOrder 或 sessionTitle 之一用于对账场次')
  }

  if (!Array.isArray(json.cues)) throw new PacketValidationError('回传包缺少 cues 数组')

  const cueNosSeen = new Set<string>()
  const cues: ConsolePacketCue[] = []

  for (let index = 0; index < json.cues.length; index += 1) {
    const item = json.cues[index]
    if (!isObject(item)) throw new PacketValidationError(`第 ${index + 1} 条 Cue 不是对象`)
    const cueNoRaw = asString(item.cueNo)
    if (!cueNoRaw || !isValidCueNo(cueNoRaw)) {
      throw new PacketValidationError(`第 ${index + 1} 条 Cue 编号非法（需形如 Q12 / Q12.5）`)
    }
    const cueNo = normalizeCueNo(cueNoRaw)
    if (cueNosSeen.has(cueNo)) throw new PacketValidationError(`回传包内 Cue 编号重复：${cueNo}`)
    cueNosSeen.add(cueNo)

    const cue: ConsolePacketCue = { cueNo }
    if (item.label !== undefined) cue.label = asString(item.label) ?? ''
    if (item.trigger !== undefined) {
      const trigger = asTrigger(item.trigger)
      if (!trigger) throw new PacketValidationError(`${cueNo} 的触发方式取值非法`)
      cue.trigger = trigger
    }
    if (item.fadeInSec !== undefined) {
      const value = asNonNegativeNumber(item.fadeInSec)
      if (value === undefined) throw new PacketValidationError(`${cueNo} 的渐亮时长非法`)
      cue.fadeInSec = value
    }
    if (item.fadeOutSec !== undefined) {
      const value = asNonNegativeNumber(item.fadeOutSec)
      if (value === undefined) throw new PacketValidationError(`${cueNo} 的渐暗时长非法`)
      cue.fadeOutSec = value
    }
    if (item.holdSec !== undefined) {
      const value = asNonNegativeNumber(item.holdSec)
      if (value === undefined) throw new PacketValidationError(`${cueNo} 的保持时长非法`)
      cue.holdSec = value
    }
    if (item.note !== undefined) cue.note = asString(item.note) ?? ''

    if (item.levels !== undefined) {
      if (!Array.isArray(item.levels)) throw new PacketValidationError(`${cueNo} 的 levels 应为数组`)
      const channelsSeen = new Set<number>()
      const levels: ConsolePacketLevel[] = []
      for (let levelIndex = 0; levelIndex < item.levels.length; levelIndex += 1) {
        const levelItem = item.levels[levelIndex]
        if (!isObject(levelItem)) throw new PacketValidationError(`${cueNo} 第 ${levelIndex + 1} 个通道电平不是对象`)
        const channel = asFiniteNumber(levelItem.channel)
        if (
          channel === undefined ||
          !Number.isInteger(channel) ||
          channel < DMX_CHANNEL_MIN ||
          channel > DMX_CHANNEL_MAX
        ) {
          throw new PacketValidationError(`${cueNo} 第 ${levelIndex + 1} 个通道号需为 ${DMX_CHANNEL_MIN}-${DMX_CHANNEL_MAX} 的整数`)
        }
        if (channelsSeen.has(channel)) throw new PacketValidationError(`${cueNo} 内通道 CH${channel} 重复`)
        channelsSeen.add(channel)

        const level: ConsolePacketLevel = { channel }
        if (levelItem.intensity !== undefined) {
          const intensity = asFiniteNumber(levelItem.intensity)
          if (intensity === undefined || intensity < 0 || intensity > 100) {
            throw new PacketValidationError(`${cueNo} CH${channel} 亮度需在 0-100 之间`)
          }
          level.intensity = Math.round(intensity)
        }
        if (levelItem.colorTempK !== undefined) {
          const kelvin = asFiniteNumber(levelItem.colorTempK)
          if (kelvin === undefined || kelvin <= 0) throw new PacketValidationError(`${cueNo} CH${channel} 色温非法`)
          level.colorTempK = Math.round(kelvin)
        }
        if (levelItem.focusNote !== undefined) level.focusNote = asString(levelItem.focusNote) ?? ''
        levels.push(level)
      }
      cue.levels = levels
    }
    cues.push(cue)
  }

  const packet: ConsolePacket = {
    format: CONSOLE_PACKET_FORMAT,
    packetId,
    scope: scope as PacketScope,
    sessionOrder: sessionOrder ?? undefined,
    sessionTitle: sessionTitle ?? undefined,
    cues
  }
  const exportedAt = asString(json.exportedAt)?.trim()
  if (exportedAt) packet.exportedAt = exportedAt
  const consoleName = asString(json.consoleName)?.trim()
  if (consoleName) packet.consoleName = consoleName
  return packet
}

/** 空值 / 未填写字段的统一展示 */
export function displayValue(value: string | null): string {
  if (value === null) return '—'
  const trimmed = value.trim()
  return trimmed === '' ? '（空）' : trimmed
}

/** Cue 标量字段序列化为可对账 / 展示的文本 */
export function formatCueFieldValue(field: ImportEntryField, value: unknown): string | null {
  if (value === undefined || value === null) return null
  switch (field) {
    case 'fadeInSec':
    case 'fadeOutSec':
    case 'holdSec':
      return `${value}s`
    default:
      return String(value)
  }
}

/** 通道电平标量字段序列化为可对账 / 展示的文本 */
export function formatLevelFieldValue(field: ImportEntryField, value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (field === 'intensity') return `${value}%`
  if (field === 'colorTempK') return `${value}K`
  return String(value)
}

/** 对象键按字典序排序，保证同内容不同键序得到一致的序列化结果 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** FNV-1a 32 位哈希，输出 16 进制串，作为回传包内容指纹 */
export function hashContent(value: unknown): string {
  const text = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 参与去重指纹的规范化内容：不含 packetId / 导出时间，同一份控制台数据换标识再粘也判重 */
export function packetFingerprint(packet: ConsolePacket): string {
  return hashContent({
    format: packet.format,
    sessionOrder: packet.sessionOrder ?? null,
    sessionTitle: packet.sessionTitle ?? null,
    scope: packet.scope,
    cues: packet.cues.map((cue) => ({
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
  })
}

/** 统计回传包内通道电平条数 */
export function countPacketLevels(packet: ConsolePacket): number {
  return packet.cues.reduce((sum, cue) => sum + (cue.levels?.length ?? 0), 0)
}

/** 用当前本地数据生成一份示例回传包，方便演示粘贴导入流程 */
export function buildSamplePacket(input: {
  packetId: string
  sessionOrder: number | null
  sessionTitle: string | null
  scope: PacketScope
  cues: ConsolePacketCue[]
  consoleName?: string
}): string {
  const packet: ConsolePacket = {
    format: CONSOLE_PACKET_FORMAT,
    packetId: input.packetId,
    exportedAt: new Date().toISOString(),
    consoleName: input.consoleName ?? '离线灯光控制台（示例）',
    sessionOrder: input.sessionOrder ?? undefined,
    sessionTitle: input.sessionTitle ?? undefined,
    scope: input.scope,
    cues: input.cues
  }
  return JSON.stringify(packet, null, 2)
}
