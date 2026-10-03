import type { CueTrigger } from '@/types/cue'

/** 控制台回传包格式标识 */
export const CONSOLE_PACKET_FORMAT = 'gbcuesheet-console-return'
/** 当前支持的回传包版本 */
export const CONSOLE_PACKET_VERSION = 1

/** 导入检查点：每个分片处理的 Cue 单元数量 */
export const CONSOLE_IMPORT_CHUNK_SIZE = 20

/** 回传包中的单通道电平（字段缺省表示控制台未改动该项） */
export interface ConsolePacketLevel {
  /** DMX 通道号，按场次内通道号与本地灯位配接对账 */
  channel: number
  intensity?: number
  colorTempK?: number
  focusNote?: string
}

/** 回传包中的一条 Cue */
export interface ConsolePacketCue {
  /** Cue 编号，形如 `Q12` / `Q12.5`，在场次内与本地 Cue 对账 */
  cueNo: string
  label?: string
  trigger?: CueTrigger
  fadeInSec?: number
  fadeOutSec?: number
  holdSec?: number
  note?: string
  levels?: ConsolePacketLevel[]
}

/** 回传包中的一个场次段落 */
export interface ConsolePacketSession {
  /** 场次匹配线索：本地场次名称或序号（如「第一幕 · 宫廷舞会」/「1」） */
  sessionRef: string
  cues: ConsolePacketCue[]
}

/** 灯光控制台离线修改后导出的回传包（粘贴文本） */
export interface ConsoleReturnPacket {
  format: typeof CONSOLE_PACKET_FORMAT
  version: number
  /** 控制台导出时刻 ISO 字符串 */
  exportedAt?: string
  note?: string
  sessions: ConsolePacketSession[]
}

/** 导入批次的处理状态 */
export type ConsoleBatchStatus =
  | 'processing' // 对账分片进行中（检查点）
  | 'failed' // 分片处理中断，可从检查点重试
  | 'pending' // 对账完成，等待逐项裁决与写入
  | 'applied' // 已无待裁决项，确认值均已写入

/** 对账项状态 */
export type ReconcileItemStatus =
  | 'identical' // 两边一致，自动了结，无需写入
  | 'conflict' // 两边都有且值不同，保留两个来源等待裁决
  | 'console-only' // 本地缺失（Cue 或通道电平），可采纳控制台值新建
  | 'local-only' // 控制台未给出，仅本地存在，纯提示，默认沿用本地
  | 'unmatched' // 通道号在本地没有配接，无法写入

/** 对账项裁决结果 */
export type ReconcileResolution =
  | 'console' // 冲突项采用控制台值
  | 'local' // 冲突项保留本地值
  | 'accept' // 控制台独有项采纳并新建
  | 'skip' // 控制台独有项跳过
  | null // 尚未裁决

/** 对账项类型 */
export type ReconcileItemKind =
  | 'cue' // 整条 Cue（本地缺失时）
  | 'cue-field' // Cue 单个字段
  | 'channel' // Cue 下某通道电平
  | 'cue-missing' // 本地有、控制台没有的 Cue 提示项

/** 一条逐项对账记录：同一项保留本地与控制台两个来源，裁决前不覆盖本地数据 */
export interface ReconcileItem {
  /** 主键 */
  id: string
  /** 所属导入批次 */
  batchId: string
  /** 确认后允许更新的唯一场次（本地场次 id）；未匹配场次时为 null */
  sessionId: string | null
  /** 场次内对账用 Cue 编号（归一化） */
  cueNo: string
  kind: ReconcileItemKind
  /** cue-field 时的字段名 */
  field?: ConsoleCueField
  /** channel 时的 DMX 通道号 */
  channel?: number
  /** 已匹配到的本地灯位通道 id（未配接为 null） */
  fixtureId?: string | null
  /** 展示名，例如「提示语」「CH12 亮度」 */
  label: string
  /** 本地来源值（本地缺失为 null） */
  localValue: string | number | null
  /** 控制台来源值（控制台未给出为 null） */
  consoleValue: string | number | null
  status: ReconcileItemStatus
  resolution: ReconcileResolution
  /** 控制台 Cue 全字段快照（cue 项采纳新建时使用） */
  cuePayload?: ConsoleCueSnapshot
  /** 控制台通道电平快照（channel 项写入时使用） */
  levelPayload?: ConsolePacketLevel
  resolvedAt: number | null
  appliedAt: number | null
  /** 批次内稳定次序，同时作为检查点排序依据 */
  ordinal: number
  note?: string
}

/** 采纳控制台独有 Cue 时的新建字段快照 */
export interface ConsoleCueSnapshot {
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
}

/** 参与对账的 Cue 字段 */
export type ConsoleCueField = 'label' | 'trigger' | 'fadeInSec' | 'fadeOutSec' | 'holdSec' | 'note'

/** 回传包场次到本地场次的匹配关系 */
export interface ConsoleSessionMapping {
  /** 回传包中的场次线索 */
  sessionRef: string
  /** 解析出的本地场次 id；未匹配为 null（该段不写入） */
  sessionId: string | null
}

/** 冻结在批次里的对账单元定位信息 */
export interface ConsoleUnitPlanEntry {
  sessionRef: string
  sessionId: string | null
  /** 回传包 Cue 编号；控制台未给出（本地独有）时为 null */
  cueNo: string | null
  /** 本地 Cue id；回传包独有或场次未映射时为 null */
  cueId: string | null
}

/**
 * 导入批次（检查点载体）：
 * 回传包内容相同（contentHash 一致）视为同一批，重复粘贴不再写入；
 * 分片处理中断后凭 processedUnits 从检查点重试，已对账进度保留。
 */
export interface ConsoleBatch {
  /** 主键 */
  id: string
  /** 回传包规范化内容的哈希，去重键 */
  contentHash: string
  /** 原始粘贴文本，便于复查 */
  sourceText: string
  /** 控制台导出时刻 ISO 字符串 */
  exportedAt: string | null
  /** 导入备注 */
  note: string
  status: ConsoleBatchStatus
  /** 各回传场次到本地场次的映射 */
  sessionMappings: ConsoleSessionMapping[]
  /** 全部 Cue 单元数（一个 Cue 为一个对账单元） */
  totalUnits: number
  /**
   * 对账单元清单（创建批次时冻结）。
   * 检查点重试时按此清单恢复完全相同的单元顺序，
   * 避免「重试时本地数据变化导致单元位移、检查点错位」。
   */
  unitPlan: ConsoleUnitPlanEntry[]
  /** 已完成对账的单元数（检查点） */
  processedUnits: number
  /** 失败原因 */
  errorMessage: string | null
  importedAt: number
  updatedAt: number
  appliedAt: number | null
}

/** 导入结果 */
export interface ConsoleImportResult {
  /** 是否为重复粘贴（同一内容哈希已存在） */
  duplicated: boolean
  /** 解析失败时为 null，message 给出原因 */
  batch: ConsoleBatch | null
  message: string
}

/** Cue 字段的中文展示名 */
export const CONSOLE_FIELD_LABELS: Record<ConsoleCueField, string> = {
  label: '提示语',
  trigger: '触发方式',
  fadeInSec: '渐亮时长',
  fadeOutSec: '渐暗时长',
  holdSec: '保持时长',
  note: '备注'
}
