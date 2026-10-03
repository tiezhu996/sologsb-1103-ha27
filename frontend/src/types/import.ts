import type { CueTrigger } from '@/types/cue'

/**
 * 控制台回传包导入（Console Packet Import）
 *
 * 演出前灯光控制台离线改 Cue，再把控制台「回传包」粘回本地 Cue 表。
 * 两边可能都动过同一场次 / Cue 编号 / 通道：
 * - 导入时逐项对账，值不同就同时保留「本地值 / 控制台值」两个来源等待人工处理，绝不先覆盖；
 * - 确认后的控制台值只写入指定场次，排演表沿用生成时的快照版本；
 * - 同一回传包再粘一次按 packetId / 内容指纹去重，不重复写入；
 * - 导入（对账 / 应用）失败后从检查点重试，已核对、已应用的进度继续保留；
 * - 旧数据没有任何对账记录时，按本地版本兼容显示（不标记来源）。
 */

/** 回传包覆盖范围：full 为整场快照（本地独有项需确认删除），partial 仅携带改动 */
export const PACKET_SCOPES = ['full', 'partial'] as const
export type PacketScope = (typeof PACKET_SCOPES)[number]

/** 回传包中的一条通道电平（控制台侧，只带改动过的字段） */
export interface ConsolePacketLevel {
  /** DMX 通道号，场次内通道的自然键 */
  channel: number
  intensity?: number
  colorTempK?: number
  focusNote?: string
}

/** 回传包中的一条 Cue（控制台侧） */
export interface ConsolePacketCue {
  /** Cue 编号，场次内 Cue 的自然键，形如 Q12 / Q12.5 */
  cueNo: string
  label?: string
  trigger?: CueTrigger
  fadeInSec?: number
  fadeOutSec?: number
  holdSec?: number
  note?: string
  levels?: ConsolePacketLevel[]
}

/** 控制台回传包：从离线控制台导出、再粘贴进本地的数据包 */
export interface ConsolePacket {
  /** 格式标识，固定值，用于识别粘贴内容 */
  format: typeof CONSOLE_PACKET_FORMAT
  /** 回传包标识，由控制台生成；同标识重复粘贴视为同一包 */
  packetId: string
  /** 控制台导出时间（ISO 字符串，可选） */
  exportedAt?: string
  /** 导出台灯光控制台名称（可选，仅展示） */
  consoleName?: string
  /** 演出序号，场次的自然键；与本地场次对账时优先使用 */
  sessionOrder?: number
  /** 场次名称，演出序号缺失 / 不匹配时辅助人工指定 */
  sessionTitle?: string
  /** 覆盖范围 */
  scope: PacketScope
  cues: ConsolePacketCue[]
}

export const CONSOLE_PACKET_FORMAT = 'gbcuesheet-console-packet' as const

/** 对账条目类别 */
export const IMPORT_ENTRY_KINDS = [
  /** 控制台有、本地无的 Cue：待确认新建 */
  'cue-add',
  /** 同一 Cue 编号两边都有、某个字段值不同 */
  'cue-field',
  /** full 包中本地有、控制台无的 Cue：待确认删除或保留 */
  'cue-local-only',
  /** 控制台有、本地无的通道电平：待确认新建 */
  'level-add',
  /** 同一 Cue + 通道两边都有、某个字段值不同 */
  'level-field',
  /** full 包中本地有、控制台无的通道电平：待确认删除或保留 */
  'level-local-only'
] as const
export type ImportEntryKind = (typeof IMPORT_ENTRY_KINDS)[number]

/** 对账条目涉及的字段；新增 / 删除类条目不绑定具体字段 */
export type ImportEntryField =
  | 'cueNo'
  | 'label'
  | 'trigger'
  | 'fadeInSec'
  | 'fadeOutSec'
  | 'holdSec'
  | 'note'
  | 'intensity'
  | 'colorTempK'
  | 'focusNote'
  | null

/**
 * 条目状态：
 * - pending：待人工处理（保留着两个来源，未决）
 * - unmapped：控制台通道在指定场次找不到对应灯位通道，暂时无法落值
 * - resolved：已选择来源（控制台 / 本地 / 忽略），等待应用
 * - applied：已应用完成（含「保留本地 / 忽略」这类空操作）
 */
export const IMPORT_ENTRY_STATUSES = ['pending', 'unmapped', 'resolved', 'applied'] as const
export type ImportEntryStatus = (typeof IMPORT_ENTRY_STATUSES)[number]

/** 处理决定：采用控制台值 / 保留本地值 / 忽略本条 */
export const IMPORT_ENTRY_DECISIONS = ['console', 'local', 'ignore'] as const
export type ImportEntryDecision = (typeof IMPORT_ENTRY_DECISIONS)[number] | null

/** 一条逐项对账记录 */
export interface ImportEntry {
  /** 主键 */
  id: string
  /** 所属回传包本地记录 id */
  packetId: string
  /** 对账时的演出序号（来自回传包头） */
  sessionOrder: number | null
  /** Cue 编号（冗余，便于分组展示） */
  cueNo: string
  /** DMX 通道号；Cue 级条目为 null */
  channel: number | null
  kind: ImportEntryKind
  field: ImportEntryField
  /** 本地来源值（展示文本）；本地没有时为 null */
  localValue: string | null
  /** 控制台来源值（展示文本）；本地独有的删除候选为 null */
  consoleValue: string | null
  status: ImportEntryStatus
  decision: ImportEntryDecision
  /** 稳定的工作单元序号：对账结果按场次内顺序编号，失败重试后不变 */
  seq: number
  /** 同包内去重的自然键，重试对账时据此跳过已核对项（检查点） */
  entryKey: string
  /** cue-add 暂存的控制台 Cue 全量快照，应用新建时使用 */
  consoleCue?: ConsolePacketCue
  /** level-add 暂存的控制台通道电平快照，应用新建时使用 */
  consoleLevel?: ConsolePacketLevel
  /** cue-field / level-field 采用控制台值时写入的原始值（展示串不便于回填） */
  consoleData?: string | number
  /** local-only 条目在对账时锁定的本地对象 id（Cue id；电平条目同样记其 Cue id） */
  localCueId?: string
  /** level 条目在对账时锁定的本地灯位通道 id（找不到时为 null，条目置为 unmapped） */
  localFixtureId?: string | null
  /** unmapped / 阻塞原因等补充说明 */
  message?: string
  resolvedAt?: number
  appliedAt?: number
  createdAt: number
  updatedAt: number
}

/**
 * 回传包导入阶段：
 * - reconciling：对账进行中（异常中断停留在此，可重试）
 * - pending-review：对账完成，存在等待人工处理 / 已确认待应用的条目
 * - applying：应用进行中（异常中断停留在此，可重试）
 * - applied：全部条目处理完毕
 */
export type ImportStage = 'reconciling' | 'pending-review' | 'applying' | 'applied'

/** 回传包本地记录：一个粘贴进系统的控制台回传包及其导入进度 */
export interface ImportPacket {
  /** 主键 */
  id: string
  /** 回传包自带标识（同标识重复粘贴直接去重） */
  packetId: string
  /** 规范化内容指纹：packetId 缺失时也能识别「同一个包再粘一次」 */
  contentHash: string
  /** 回传包声明的演出序号与场次名 */
  sessionOrder: number | null
  sessionTitle: string | null
  /** 指定写入的本地场次 id；未匹配时为 null，需人工指定后才能应用 */
  targetSessionId: string | null
  scope: PacketScope
  consoleName: string
  exportedAt: string | null
  /** 包内 Cue / 通道电平条数 */
  cueCount: number
  levelCount: number
  stage: ImportStage
  /** 最近一次失败原因，成功后清空 */
  error: string | null
  pastedAt: number
  updatedAt: number
}

/** 一个回传包的条目计数 */
export interface ImportPacketCounts {
  total: number
  pending: number
  unmapped: number
  resolved: number
  applied: number
  /** 是否全部处理完成 */
  done: boolean
  /** 进度百分比 0-100 */
  percent: number
}

/** 应用一批已确认条目的结果 */
export interface ApplyEntriesResult {
  /** 本次实际写入的条目数 */
  applied: number
  /** 仍待人工处理的条目数 */
  waiting: number
  /** 因缺 Cue / 缺通道而阻塞、需修复后重试的条目数 */
  blocked: number
  /** 是否整包完成 */
  completed: boolean
  /** 阻塞 / 失败说明 */
  message: string | null
}
