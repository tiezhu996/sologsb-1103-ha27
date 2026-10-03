import 'fake-indexeddb/auto'
import { createPinia } from 'pinia'
import { useSessionStore } from '@/stores/sessionStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useCueStore } from '@/stores/cueStore'
import { useLevelStore } from '@/stores/levelStore'
import { useImportStore } from '@/stores/importStore'
import { packetFingerprint } from '@/utils/consolePacket'
import { db } from '@/utils/db'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function makePacket(input: { id: string; order?: number; title?: string; scope?: 'full' | 'partial'; cues: unknown[] }): string {
  return JSON.stringify({
    format: 'gbcuesheet-console-packet',
    packetId: input.id,
    sessionOrder: input.order ?? 1,
    sessionTitle: input.title ?? '第一幕',
    scope: input.scope ?? 'partial',
    cues: input.cues
  })
}

async function main(): Promise<void> {
  const pinia = createPinia()
  const sessionStore = useSessionStore(pinia)
  const fixtureStore = useFixtureStore(pinia)
  const cueStore = useCueStore(pinia)
  const levelStore = useLevelStore(pinia)
  const importStore = useImportStore(pinia)

  // ---- 准备本地数据：场次 1，一个 CH1，一条 Q1（亮度 50），一条 Q2 ----
  const session = await sessionStore.createSession({
    title: '第一幕',
    order: 1,
    scriptPage: 'P1',
    plannedStart: '',
    plannedEnd: '',
    stageNote: ''
  })
  await fixtureStore.addFixture({
    sessionId: session.id,
    channel: 1,
    position: '面光',
    fixtureType: '成像灯',
    gel: '',
    patchNote: ''
  })
  await fixtureStore.addFixture({
    sessionId: session.id,
    channel: 2,
    position: '耳光',
    fixtureType: '聚光灯',
    gel: '',
    patchNote: ''
  })
  const q1 = await cueStore.addCue({
    sessionId: session.id,
    cueNo: 'Q1',
    label: '开场',
    trigger: '手动',
    fadeInSec: 3,
    fadeOutSec: 3,
    holdSec: 5,
    note: ''
  })
  const q2 = await cueStore.addCue({
    sessionId: session.id,
    cueNo: 'Q2',
    label: '过场',
    trigger: '手动',
    fadeInSec: 2,
    fadeOutSec: 2,
    holdSec: 2,
    note: ''
  })
  const fix1 = fixtureStore.fixturesOfSession(session.id).find((f) => f.channel === 1)!
  await levelStore.upsertLevel(q1.id, fix1.id, { intensity: 50, colorTempK: 3200, focusNote: '' })

  console.log('场景 1：粘贴即对账，逐项产生差异且不覆盖')
  // 控制台：Q1 改了 fadeInSec 与 CH1 亮度；新增 Q9；未携带 Q2（partial）
  const packetText = makePacket({
    id: 'PK-1',
    cues: [
      { cueNo: 'Q1', fadeInSec: 8, levels: [{ channel: 1, intensity: 90 }] },
      { cueNo: 'Q9', label: '新增', fadeInSec: 1, fadeOutSec: 1, holdSec: 1, levels: [] }
    ]
  })
  const paste = await importStore.pastePacket(packetText)
  check('粘贴成功并自动匹配场次', paste.status === 'created' && paste.packet?.targetSessionId === session.id, paste.message)
  const pkt = paste.packet!
  const entries = importStore.entriesOfPacket(pkt.id)
  const kinds = entries.map((e) => `${e.kind}:${e.field ?? ''}`)
  check('生成 cue-field（fadeInSec 3→8）', kinds.some((k) => k === 'cue-field:fadeInSec'))
  check('生成 level-field（intensity 50%→90%）', kinds.some((k) => k === 'level-field:intensity'))
  check('生成 cue-add Q9', kinds.includes('cue-add:'))
  check('partial 包不产生 local-only', !kinds.some((k) => k.includes('local-only')))
  check('本地 Q1 fadeInSec 未被覆盖（仍为 3）', cueStore.cueById(q1.id)?.fadeInSec === 3)
  check('本地 CH1 亮度未被覆盖（仍为 50）', levelStore.levelOf(q1.id, fix1.id)?.intensity === 50)

  console.log('场景 2：同一回传包再粘一次不重复写入')
  const paste2 = await importStore.pastePacket(packetText)
  check('第二次粘贴命中去重', paste2.status === 'duplicate')
  check('回传包记录只有一条', importStore.packets.length === 1)
  // 内容相同但 packetId 不同（模拟键序打乱）也应命中内容指纹
  const reordered = JSON.stringify(JSON.parse(packetText), (k, v) => v, 0)
  void reordered
  const shuffled = `{ "cues": ${JSON.stringify(JSON.parse(packetText).cues)}, "packetId":"PK-1","format":"gbcuesheet-console-packet","sessionOrder":1,"sessionTitle":"第一幕","scope":"partial" }`
  const pasteShuffled = await importStore.pastePacket(shuffled)
  // packetId 相同必然命中；再用不同 packetId 但同内容验证指纹
  const sameContentDifferentId = packetText.replace('PK-1', 'PK-1-COPY')
  const pasteFinger = await importStore.pastePacket(sameContentDifferentId)
  check('不同 packetId 但内容一致也判重', pasteFinger.status === 'duplicate')
  void pasteShuffled

  console.log('场景 3：逐项确认后应用，只写指定场次，排演表不受影响')
  const fadeEntry = entries.find((e) => e.kind === 'cue-field' && e.field === 'fadeInSec')!
  const intensityEntry = entries.find((e) => e.kind === 'level-field' && e.field === 'intensity')!
  const addEntry = entries.find((e) => e.kind === 'cue-add')!
  await importStore.decideEntry(fadeEntry.id, 'console')
  await importStore.decideEntry(intensityEntry.id, 'console')
  // cue-add 选择「保留本地」即忽略新建
  await importStore.decideEntry(addEntry.id, 'local')
  const before = importStore.entriesOfPacket(pkt.id).filter((e) => e.status === 'resolved').length
  check('三条已确认', before === 3, `resolved=${before}`)
  const applyRes = await importStore.applyResolved(pkt.id)
  check('应用 3 条', applyRes.applied === 3, JSON.stringify(applyRes))
  check('Q1 fadeInSec 更新为 8', cueStore.cueById(q1.id)?.fadeInSec === 8)
  check('CH1 亮度更新为 90', levelStore.levelOf(q1.id, fix1.id)?.intensity === 90)
  check('Q9 未被新建（保留本地=忽略）', cueStore.cuesOfSession(session.id).every((c) => c.cueNo !== 'Q9'))
  check('Q2 原样未动', cueStore.cueById(q2.id)?.fadeInSec === 2)

  console.log('场景 4：已应用进度在重新对账后保留（不回退成待处理）')
  await importStore.runReconciliation(pkt.id)
  const afterEntries = importStore.entriesOfPacket(pkt.id)
  // 应用控制台值后本地已与控制台一致；该条若保留则必须是 applied 历史，绝不复活成 pending/resolved
  const fadeAfter = afterEntries.filter((e) => e.kind === 'cue-field' && e.field === 'fadeInSec')
  check('fadeInSec 差异不复活为待处理', fadeAfter.every((e) => e.status === 'applied'), JSON.stringify(fadeAfter.map((e) => e.status)))
  // 亮度已是 90，与控制台一致 → 差异消失；cue-add 选了保留本地，差异仍在但应保持 applied 留痕
  const addStillApplied = afterEntries.find((e) => e.entryKey === 'cue-add:Q9')
  check('cue-add 保留本地后重新对账仍为 applied', addStillApplied?.status === 'applied')
  check('整包状态为 applied', importStore.packetById(pkt.id)?.stage === 'applied')

  console.log('场景 5：导入失败（通道未配接）→ 修复后从检查点续跑')
  const packetUnmapped = makePacket({
    id: 'PK-2',
    cues: [{ cueNo: 'Q1', levels: [{ channel: 77, intensity: 40 }] }]
  })
  const paste3 = await importStore.pastePacket(packetUnmapped)
  const pkt2 = paste3.packet!
  const unmappedEntry = importStore.entriesOfPacket(pkt2.id).find((e) => e.kind === 'level-add')!
  check('未配接通道标记为 unmapped', unmappedEntry.status === 'unmapped')
  // 尝试确认并应用 → 应被阻塞而非覆盖
  // unmapped 不能直接确认（UI 禁用），这里模拟配接后重新对账
  await fixtureStore.addFixture({
    sessionId: session.id,
    channel: 77,
    position: '顶排',
    fixtureType: '染色灯',
    gel: '',
    patchNote: ''
  })
  await importStore.runReconciliation(pkt2.id)
  const revived = importStore.entriesOfPacket(pkt2.id).find((e) => e.entryKey === 'level-add:Q1:CH77')!
  check('配接补齐后条目回到 pending（进度模型可续跑）', revived.status === 'pending')
  await importStore.decideEntry(revived.id, 'console')
  const apply2 = await importStore.applyResolved(pkt2.id)
  check('续跑应用成功', apply2.applied === 1, JSON.stringify(apply2))
  const fix77 = fixtureStore.fixturesOfSession(session.id).find((f) => f.channel === 77)!
  check('CH77 电平已写入 Q1', levelStore.levelOf(q1.id, fix77.id)?.intensity === 40)

  console.log('场景 5b：应用阶段失败（确认后 Cue 被删除）→ 恢复后重试，已应用进度不丢')
  const packetApply = makePacket({ id: 'PK-2B', cues: [{ cueNo: 'Q2', note: '控制台加的备注' }] })
  const paste2b = await importStore.pastePacket(packetApply)
  const pkt2b = paste2b.packet!
  const noteEntry = importStore.entriesOfPacket(pkt2b.id).find((e) => e.kind === 'cue-field' && e.field === 'note')!
  await importStore.decideEntry(noteEntry.id, 'console')
  // 在应用前把 Q2 删除，制造「确认后目标缺失」的应用失败
  await cueStore.removeCue(q2.id)
  const applyFail = await importStore.applyResolved(pkt2b.id)
  check('应用阶段被阻塞且不计为完成', applyFail.blocked === 1 && applyFail.completed === false, JSON.stringify(applyFail))
  const blocked = importStore.entriesOfPacket(pkt2b.id).find((e) => e.id === noteEntry.id)!
  check('阻塞条目仍保留 resolved 决定与原因', blocked.status === 'resolved' && blocked.decision === 'console' && !!blocked.message)
  // 恢复：用同编号重建 Q2 后续跑
  const q2Reborn = await cueStore.addCue({
    sessionId: session.id,
    cueNo: 'Q2',
    label: '过场',
    trigger: '手动',
    fadeInSec: 2,
    fadeOutSec: 2,
    holdSec: 2,
    note: ''
  })
  const applyRetry = await importStore.applyResolved(pkt2b.id)
  check('恢复后续跑成功', applyRetry.blocked === 0 && applyRetry.completed === true, JSON.stringify(applyRetry))
  check('Q2 已写入控制台备注', cueStore.cueById(q2Reborn.id)?.note === '控制台加的备注')

  console.log('场景 6：full 包产生 local-only 删除候选，忽略则不删除')
  const fullPacket = makePacket({
    id: 'PK-3',
    scope: 'full',
    cues: [{ cueNo: 'Q1', fadeInSec: 8, levels: [{ channel: 1, intensity: 90 }] }] // 无 Q2、无 CH2
  })
  const paste4 = await importStore.pastePacket(fullPacket)
  const pkt3 = paste4.packet!
  const e3 = importStore.entriesOfPacket(pkt3.id)
  check('full 包含 cue-local-only Q2', e3.some((e) => e.kind === 'cue-local-only'))
  check('full 包含 level-local-only（Q1 CH77 不在快照）', e3.some((e) => e.kind === 'level-local-only'))
  // 全部保留本地（忽略删除）
  await importStore.decidePending(pkt3.id, 'local')
  await importStore.applyResolved(pkt3.id)
  check('Q2 仍存在（删除候选被保留）', cueStore.cuesOfSession(session.id).some((c) => c.cueNo === 'Q2'))
  check('Q1 CH77 电平仍存在', levelStore.levelOf(q1.id, fix77.id) !== null)

  console.log('场景 7：删除场次级联清理回传包记录')
  const packetCountBefore = importStore.packets.length
  check('删除前有回传包记录', packetCountBefore >= 1)
  await sessionStore.removeSession(session.id)
  check('场次删除后其回传包记录被级联清理', importStore.packets.length === 0)
  check('条目也被清理', importStore.entries.length === 0)

  console.log('场景 8：非法回传包被拒绝')
  const bad = await importStore.pastePacket('{ not json')
  check('非法 JSON 被拒绝', bad.status === 'invalid')
  const badFmt = await importStore.pastePacket(JSON.stringify({ format: 'other', packetId: 'x', sessionOrder: 1, cues: [] }))
  check('格式标识不符被拒绝', badFmt.status === 'invalid')

  // 指纹稳定性：键序不同
  const a = { format: 'gbcuesheet-console-packet', packetId: 'Z', sessionOrder: 1, scope: 'partial', cues: [{ cueNo: 'Q1', fadeInSec: 5 }] }
  const b = { cues: [{ fadeInSec: 5, cueNo: 'Q1' }], scope: 'partial', sessionOrder: 1, packetId: 'Z', format: 'gbcuesheet-console-packet' }
  check('内容指纹对键序不敏感', packetFingerprint(a as never) === packetFingerprint(b as never))

  await db.close()

  if (failures > 0) {
    console.error(`\n${failures} 项检查失败`)
    process.exit(1)
  }
  console.log('\n全部检查通过 ✅')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
