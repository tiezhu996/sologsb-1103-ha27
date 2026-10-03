import { createPinia, setActivePinia } from 'pinia'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import 'fake-indexeddb/auto'

import { clearAllData } from '@/utils/db'
import { useSessionStore } from '@/stores/sessionStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useCueStore } from '@/stores/cueStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSheetStore } from '@/stores/sheetStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { parseConsolePacket, buildUnitPlan, unitsFromPlan } from '@/utils/consolePacket'

let store: ReturnType<typeof useConsoleStore>
let sessionId: string
let cueId: string

function packetText(): string {
  return JSON.stringify({
    format: 'gbcuesheet-console-return',
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: [
      {
        sessionRef: '1',
        cues: [
          { cueNo: 'Q1', label: '控制台改的提示语', levels: [{ channel: 1, intensity: 90 }] },
          { cueNo: 'Q7', label: '控制台新增', fadeInSec: 2, levels: [{ channel: 9, intensity: 55 }] }
        ]
      },
      { sessionRef: '不存在的场次', cues: [{ cueNo: 'Q1', label: '写不进来' }] }
    ]
  })
}

beforeEach(async () => {
  await clearAllData()
  const pinia = createPinia()
  setActivePinia(pinia)
  await Promise.all([
    useSessionStore().hydrate(),
    useFixtureStore().hydrate(),
    useCueStore().hydrate(),
    useLevelStore().hydrate(),
    useConsoleStore().hydrate()
  ])

  const sessions = useSessionStore()
  const fixtures = useFixtureStore()
  const cues = useCueStore()
  const levels = useLevelStore()

  sessionId = (
    await sessions.createSession({
      title: '第一场',
      order: 1,
      scriptPage: 'P1',
      plannedStart: '',
      plannedEnd: '',
      stageNote: ''
    })
  ).id
  await fixtures.addFixture({ sessionId, channel: 1, position: '面光', fixtureType: '成像灯', gel: 'R02', patchNote: '' })
  const cue = await cues.addCue({
    sessionId,
    cueNo: 'Q1',
    label: '本地提示语',
    trigger: '手动',
    fadeInSec: 3,
    fadeOutSec: 3,
    holdSec: 5,
    note: ''
  })
  cueId = cue.id
  const fixture = fixtures.fixturesOfSession(sessionId)[0]
  await levels.upsertLevel(cueId, fixture.id, { intensity: 40, colorTempK: 3200, focusNote: '' })

  store = useConsoleStore()
})

test('解析非法包给出明确错误', () => {
  assert.equal(parseConsolePacket('not json').ok, false)
  assert.match(parseConsolePacket('{"format":"x"}').error, /格式标识/)
  const bad = JSON.stringify({
    format: 'gbcuesheet-console-return',
    version: 1,
    sessions: [{ sessionRef: '1', cues: [{ cueNo: 'Q1', levels: [{ channel: 999 }] }] }]
  })
  assert.match(parseConsolePacket(bad).error, /通道号/)
  const badVersion = JSON.stringify({ format: 'gbcuesheet-console-return', version: 9, sessions: [] })
  assert.match(parseConsolePacket(badVersion).error, /版本/)
})

test('正常导入：逐项对账，冲突保留两来源，本地值未被覆盖', async () => {
  const result = await store.startImport({ raw: packetText() })
  assert.equal(result.duplicated, false)
  assert.equal(result.batch?.status, 'pending')

  const items = store.itemsOfBatch(result.batch!.id)
  const conflict = items.filter((i) => i.status === 'conflict')
  assert.equal(conflict.some((i) => i.kind === 'cue-field' && i.field === 'label'), true)
  assert.equal(conflict.some((i) => i.kind === 'channel' && i.channel === 1), true)
  assert.equal(items.some((i) => i.kind === 'cue' && i.status === 'console-only' && i.cueNo === 'Q7'), true)
  assert.equal(items.some((i) => i.status === 'unmatched' && i.channel === 9), true)
  const unmapped = items.find((i) => i.sessionId === null)
  assert.ok(unmapped)

  const cues = useCueStore()
  assert.equal(cues.cueById(cueId)!.label, '本地提示语')
})

test('采用控制台值只更新映射场次；排演表快照不动', async () => {
  const sheetStore = useSheetStore()
  await sheetStore.createSheet({ sessionId, cueIds: [cueId], note: '旧版' })
  const beforeLabel = sheetStore.sheetsOfSession(sessionId)[0].cueLines[0].label

  const result = await store.startImport({ raw: packetText() })
  const items = store.itemsOfBatch(result.batch!.id)
  const labelConflict = items.find((i) => i.status === 'conflict' && i.kind === 'cue-field' && i.field === 'label' && i.sessionId !== null)!
  const channelConflict = items.find((i) => i.status === 'conflict' && i.kind === 'channel' && i.sessionId !== null)!
  assert.ok(labelConflict, '应存在已映射场次的 label 冲突项')
  assert.ok(channelConflict, '应存在已映射场次的通道冲突项')

  // 未映射场次的 Cue 记为 unmatched（不可裁决写入）
  const unmapped = items.find((i) => i.sessionId === null && i.status === 'unmatched')!
  assert.ok(unmapped, '应存在未映射场次的不可写入项')
  assert.equal((await store.resolveItem(unmapped.id, 'accept')).ok, false)

  await store.resolveItem(labelConflict.id, 'console')
  await store.resolveItem(channelConflict.id, 'console')

  const cues = useCueStore()
  const levels = useLevelStore()
  assert.equal(cues.cueById(cueId)!.label, '控制台改的提示语')
  const fixture = useFixtureStore().fixturesOfSession(sessionId)[0]
  assert.equal(levels.levelOf(cueId, fixture.id)!.intensity, 90)
  assert.equal(sheetStore.sheetsOfSession(sessionId)[0].cueLines[0].label, beforeLabel)
})

test('控制台独有 Cue 采纳后新建到映射场次；无配接通道不可写', async () => {
  const result = await store.startImport({ raw: packetText() })
  const items = store.itemsOfBatch(result.batch!.id)
  const q7Channel = items.find((i) => i.kind === 'channel' && i.channel === 9 && i.cueNo === 'Q7')!
  assert.equal(q7Channel.status, 'unmatched')

  const q7Cue = items.find((i) => i.kind === 'cue' && i.cueNo === 'Q7')!
  const write = await store.resolveItem(q7Cue.id, 'accept')
  assert.equal(write.ok, true)
  const cues = useCueStore()
  assert.equal(cues.cuesOfSession(sessionId).some((c) => c.cueNo === 'Q7'), true)
})

test('同内容回传包重复粘贴不重复写入（幂等）', () => {
  // 幂等判定针对「同一个回传包文本」：内容哈希包含 exportedAt，
  // 两次粘贴必须完全一致才视为同一批（再粘一次不重复写入）
  const text = packetText()
  return Promise.resolve().then(async () => {
    const first = await store.startImport({ raw: text })
    const countAfterFirst = store.items.length
    const second = await store.startImport({ raw: text })
    assert.equal(second.duplicated, true)
    assert.equal(second.batch!.id, first.batch!.id)
    assert.equal(store.items.length, countAfterFirst)
    assert.equal(store.batches.length, 1)
  })
})

function bigPacketText(): string {
  // 25 条 Cue，超过单分片 20 个单元：第 1 片落库后中断，第 2 片尚未对账
  const cues = Array.from({ length: 25 }, (_, index) => ({ cueNo: `Q${index + 1}`, label: `控制台 ${index + 1}` }))
  return JSON.stringify({
    format: 'gbcuesheet-console-return',
    version: 1,
    sessions: [{ sessionRef: '1', cues }]
  })
}

test('导入在分片后中断：检查点保留，重试不重复产出', async () => {
  const result = await store.startImport({ raw: bigPacketText(), failAtChunk: 1 })
  assert.equal(result.batch!.status, 'failed')
  assert.equal(result.batch!.processedUnits, 20)
  assert.equal(result.batch!.totalUnits, 25)
  const retainedItems = store.itemsOfBatch(result.batch!.id).length
  assert.ok(retainedItems > 0)

  const retried = await store.retryImport(result.batch!.id)
  assert.notEqual(retried!.status, 'failed')
  assert.equal(retried!.processedUnits, retried!.totalUnits)
  // 已核对进度保留，重试只补齐剩余 5 个单元，不重复产出
  const allItems = store.itemsOfBatch(result.batch!.id)
  const ordinalSet = new Set(allItems.map((i) => i.ordinal))
  assert.equal(ordinalSet.size, allItems.length)
})

test('全部裁决完成后批次自动完结', async () => {
  const result = await store.startImport({ raw: packetText() })
  const pending = store.pendingItemsOfBatch(result.batch!.id)
  for (const item of pending) {
    // 控制台独有 Cue 采纳；冲突保留本地；unmatched 不在可裁决集合
    const res =
      item.status === 'console-only'
        ? await store.resolveItem(item.id, 'accept')
        : await store.resolveItem(item.id, 'local')
    assert.ok(res.ok, `${item.label} 裁决失败：${res.message}`)
  }
  const leftover = store.pendingItemsOfBatch(result.batch!.id)
  assert.equal(leftover.length, 0, `仍有待裁决项：${leftover.map((i) => i.label).join('、')}`)
  assert.equal(store.batchById(result.batch!.id)!.status, 'applied')
})

test('冻结单元清单：重试单元顺序与首跑一致', () => {
  const parsed = parseConsolePacket(packetText())
  assert.equal(parsed.ok, true)
  const cues = useCueStore()
  const plan = buildUnitPlan(parsed.packet!, [{ sessionRef: '1', sessionId }, { sessionRef: '不存在的场次', sessionId: null }], {
    cues: cues.cues
  })
  const units = unitsFromPlan(parsed.packet!, plan, { cues: cues.cues })
  assert.equal(units.length, plan.length)
  assert.equal(units[0].packetCue?.cueNo, 'Q1')
  assert.equal(units[0].localCue?.id, cueId)
})
