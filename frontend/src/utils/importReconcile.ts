import type { Cue } from '@/types/cue'
import type { Fixture } from '@/types/fixture'
import type { CueLevel } from '@/types/level'
import type {
  ConsolePacket,
  ConsolePacketCue,
  ConsolePacketLevel,
  ImportEntry,
  ImportEntryField
} from '@/types/import'
import { sortFixturesByChannel } from '@/utils/patch'
import { compareCueNo, normalizeCueNo } from '@/utils/cueOrder'
import { formatCueFieldValue, formatLevelFieldValue } from '@/utils/consolePacket'

/** 参与逐字段对账的 Cue 标量字段定义 */
type CueScalarField = 'label' | 'trigger' | 'fadeInSec' | 'fadeOutSec' | 'holdSec' | 'note'

const CUE_SCALAR_FIELDS: CueScalarField[] = ['label', 'trigger', 'fadeInSec', 'fadeOutSec', 'holdSec', 'note']

/** 参与逐字段对账的通道电平标量字段定义 */
type LevelScalarField = 'intensity' | 'colorTempK' | 'focusNote'

const LEVEL_SCALAR_FIELDS: LevelScalarField[] = ['intensity', 'colorTempK', 'focusNote']

/** 对账输入：指定场次的本地现状 */
export interface ReconcileInput {
  packetRecordId: string
  packet: ConsolePacket
  sessionOrder: number | null
  localCues: Cue[]
  localFixtures: Fixture[]
  localLevels: CueLevel[]
  now: number
}

/** 尚未分配稳定位次的条目草稿（位次由 store 在检查点落库时统一编号） */
export type ReconcileDraft = Omit<ImportEntry, 'id' | 'seq'>

/** 对账结果 */
export interface ReconcileResult {
  /** 按工作单元顺序排好的条目草稿 */
  entries: ReconcileDraft[]
  /** 控制台携带但在指定场次找不到对应灯位通道的通道号 */
  unmappedChannels: number[]
}

function sameScalar(a: unknown, b: unknown): boolean {
  return a === b
}

function cueFieldValue(cue: Pick<Cue, CueScalarField>, field: CueScalarField): string | null {
  return formatCueFieldValue(field, cue[field])
}

function packetCueFieldValue(cue: ConsolePacketCue, field: CueScalarField): string | null {
  const value = cue[field]
  if (value === undefined) return null
  return formatCueFieldValue(field, value)
}

function levelFieldValue(level: Pick<CueLevel, LevelScalarField>, field: LevelScalarField): string | null {
  return formatLevelFieldValue(field, level[field])
}

function packetLevelFieldValue(level: ConsolePacketLevel, field: LevelScalarField): string | null {
  const value = level[field]
  if (value === undefined) return null
  return formatLevelFieldValue(field, value)
}

/**
 * 逐项对账（纯函数）：把控制台回传包与指定场次的本地现状逐条比对。
 *
 * 规则：
 * - 同一 Cue 编号两边都有 → 仅对回传包携带的字段逐字段比对，值不同生成一条 cue-field；
 * - 控制台有、本地无 → cue-add（暂存整条控制台 Cue，应用时新建）；
 * - full 包中本地有、控制台无 → cue-local-only（待确认删除 / 保留），partial 包不产生此类条目；
 * - 同一 Cue + 通道两边都有 → 对携带字段逐字段比对，值不同生成 level-field；
 * - 控制台有、本地无 → level-add；找不到对应灯位通道时生成 unmapped 的 level-add；
 * - full 包中本地有、控制台无 → level-local-only。
 *
 * 不写入数据库、不依赖 store，便于在检查点重试时反复重算并与既有条目按 entryKey 合并。
 */
export function buildReconciliation(input: ReconcileInput): ReconcileResult {
  const { packetRecordId, packet, localCues, localFixtures, localLevels, now } = input
  const localCueByNo = new Map<string, Cue>()
  localCues.forEach((cue) => {
    const key = normalizeCueNo(cue.cueNo)
    if (!localCueByNo.has(key)) localCueByNo.set(key, cue)
  })

  const fixtureByChannel = new Map<number, Fixture>()
  sortFixturesByChannel(localFixtures).forEach((fixture) => {
    if (!fixtureByChannel.has(fixture.channel)) fixtureByChannel.set(fixture.channel, fixture)
  })

  const drafts: ReconcileDraft[] = []
  const unmappedChannels = new Set<number>()
  const packetCueNos = new Set<string>()

  const pushEntry = (entry: Omit<ReconcileDraft, 'packetId'>): void => {
    drafts.push({ ...entry, packetId: packetRecordId })
  }

  const orderedPacketCues = [...packet.cues].sort((a, b) => compareCueNo(a.cueNo, b.cueNo))

  orderedPacketCues.forEach((packetCue) => {
    const cueNo = normalizeCueNo(packetCue.cueNo)
    packetCueNos.add(cueNo)
    const localCue = localCueByNo.get(cueNo) ?? null

    if (!localCue) {
      pushEntry({
        sessionOrder: input.sessionOrder,
        cueNo,
        channel: null,
        kind: 'cue-add',
        field: null,
        localValue: null,
        consoleValue: '新建 Cue',
        status: 'pending',
        decision: null,
        entryKey: `cue-add:${cueNo}`,
        consoleCue: { ...packetCue, cueNo, levels: packetCue.levels ? packetCue.levels.map((level) => ({ ...level })) : [] },
        createdAt: now,
        updatedAt: now
      })
      return
    }

    CUE_SCALAR_FIELDS.forEach((field) => {
      if (!(field in packetCue)) return
      const localValue = cueFieldValue(localCue, field)
      const consoleValue = packetCueFieldValue(packetCue, field)
      if (sameScalar(localValue, consoleValue)) return
      pushEntry({
        sessionOrder: input.sessionOrder,
        cueNo,
        channel: null,
        kind: 'cue-field',
        field: field as ImportEntryField,
        localValue,
        consoleValue,
        status: 'pending',
        decision: null,
        entryKey: `cue-field:${cueNo}:${field}`,
        localCueId: localCue.id,
        consoleData: packetCue[field] as string | number,
        createdAt: now,
        updatedAt: now
      })
    })

    const packetLevels = packetCue.levels ?? []
    if (packetLevels.length > 0) {
      const localLevelsOfCue = localLevels.filter((level) => level.cueId === localCue.id)
      const localLevelByFixture = new Map<string, CueLevel>()
      localLevelsOfCue.forEach((level) => {
        if (!localLevelByFixture.has(level.fixtureId)) localLevelByFixture.set(level.fixtureId, level)
      })
      const localLevelByChannel = new Map<number, CueLevel>()
      localLevelsOfCue.forEach((level) => {
        const fixture = localFixtures.find((item) => item.id === level.fixtureId)
        if (fixture && !localLevelByChannel.has(fixture.channel)) localLevelByChannel.set(fixture.channel, level)
      })
      const packetChannels = new Set<number>()

      packetLevels.forEach((packetLevel) => {
        packetChannels.add(packetLevel.channel)
        const fixture = fixtureByChannel.get(packetLevel.channel) ?? null
        const localLevel = fixture ? (localLevelByFixture.get(fixture.id) ?? localLevelByChannel.get(packetLevel.channel) ?? null) : null

        if (!fixture) unmappedChannels.add(packetLevel.channel)

        if (!localLevel) {
          pushEntry({
            sessionOrder: input.sessionOrder,
            cueNo,
            channel: packetLevel.channel,
            kind: 'level-add',
            field: null,
            localValue: null,
            consoleValue: '新建通道电平',
            status: fixture ? 'pending' : 'unmapped',
            decision: null,
            entryKey: `level-add:${cueNo}:CH${packetLevel.channel}`,
            localCueId: localCue.id,
            localFixtureId: fixture?.id ?? null,
            consoleLevel: { ...packetLevel },
            message: fixture ? undefined : `指定场次未配接 CH${packetLevel.channel}，请先在灯位通道配置台配接后重试`,
            createdAt: now,
            updatedAt: now
          })
          return
        }

        LEVEL_SCALAR_FIELDS.forEach((field) => {
          if (!(field in packetLevel)) return
          const localValue = levelFieldValue(localLevel, field)
          const consoleValue = packetLevelFieldValue(packetLevel, field)
          if (sameScalar(localValue, consoleValue)) return
          pushEntry({
            sessionOrder: input.sessionOrder,
            cueNo,
            channel: packetLevel.channel,
            kind: 'level-field',
            field: field as ImportEntryField,
            localValue,
            consoleValue,
            status: 'pending',
            decision: null,
            entryKey: `level-field:${cueNo}:CH${packetLevel.channel}:${field}`,
            localCueId: localCue.id,
            localFixtureId: fixture?.id ?? null,
            consoleData: packetLevel[field] as string | number,
            createdAt: now,
            updatedAt: now
          })
        })
      })

      // full 包：本地有、控制台快照里没有的通道电平 → 待确认删除 / 保留
      if (packet.scope === 'full') {
        localLevelsOfCue.forEach((localLevel) => {
          const fixture = localFixtures.find((item) => item.id === localLevel.fixtureId)
          if (!fixture) return
          if (packetChannels.has(fixture.channel)) return
          pushEntry({
            sessionOrder: input.sessionOrder,
            cueNo,
            channel: fixture.channel,
            kind: 'level-local-only',
            field: null,
            localValue: '本地通道电平',
            consoleValue: null,
            status: 'pending',
            decision: null,
            entryKey: `level-local-only:${cueNo}:CH${fixture.channel}`,
            localCueId: localCue.id,
            localFixtureId: fixture.id,
            createdAt: now,
            updatedAt: now
          })
        })
      }
    }
  })

  // full 包：本地有、控制台快照里没有的 Cue → 待确认删除 / 保留
  if (packet.scope === 'full') {
    localCues
      .slice()
      .sort((a, b) => compareCueNo(a.cueNo, b.cueNo))
      .forEach((localCue) => {
        const cueNo = normalizeCueNo(localCue.cueNo)
        if (packetCueNos.has(cueNo)) return
        pushEntry({
          sessionOrder: input.sessionOrder,
          cueNo,
          channel: null,
          kind: 'cue-local-only',
          field: null,
          localValue: '本地 Cue',
          consoleValue: null,
          status: 'pending',
          decision: null,
          entryKey: `cue-local-only:${cueNo}`,
          localCueId: localCue.id,
          createdAt: now,
          updatedAt: now
        })
      })
  }

  return { entries: drafts, unmappedChannels: Array.from(unmappedChannels).sort((a, b) => a - b) }
}
