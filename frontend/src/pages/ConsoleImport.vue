<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NInput,
  NProgress,
  NSelect,
  NTag,
  NTooltip,
  useDialog,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import { useImportStore } from '@/stores/importStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import type { ConsolePacketCue, ImportEntry, ImportEntryStatus, ImportPacket } from '@/types/import'
import { buildSamplePacket, displayValue, IMPORT_FIELD_LABELS } from '@/utils/consolePacket'
import { formatDateTime } from '@/utils/fade'

const message = useMessage()
const dialog = useDialog()
const importStore = useImportStore()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const fixtureStore = useFixtureStore()
const levelStore = useLevelStore()

const packetText = ref('')
const selectedPacketId = ref<string | null>(null)
const importing = ref(false)
const applying = ref(false)
const reconciling = ref<string | null>(null)

const packets = computed(() => importStore.packetsSorted)
const selectedPacket = computed<ImportPacket | null>(() =>
  selectedPacketId.value ? importStore.packetById(selectedPacketId.value) : null
)

const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

function sessionLabel(packet: ImportPacket): string {
  if (!packet.targetSessionId) return '未指定'
  const session = sessionStore.sessionById(packet.targetSessionId)
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}

const entries = computed(() => (selectedPacket.value ? importStore.entriesOfPacket(selectedPacket.value.id) : []))
const counts = computed(() => (selectedPacket.value ? importStore.countsOfPacket(selectedPacket.value.id) : null))
const groups = computed(() => (selectedPacket.value ? importStore.groupedEntriesOfPacket(selectedPacket.value.id) : []))

const STATUS_META: Record<ImportEntryStatus, { label: string; type: 'warning' | 'default' | 'success' | 'error' }> = {
  pending: { label: '待处理', type: 'warning' },
  unmapped: { label: '通道未配接', type: 'error' },
  resolved: { label: '已确认', type: 'default' },
  applied: { label: '已应用', type: 'success' }
}

const STAGE_LABEL: Record<ImportPacket['stage'], string> = {
  reconciling: '对账中断 · 可重试',
  'pending-review': '待人工处理',
  applying: '应用中断 · 可续跑',
  applied: '已全部处理'
}

function stageTagType(stage: ImportPacket['stage']): 'warning' | 'default' | 'error' | 'success' {
  if (stage === 'applied') return 'success'
  if (stage === 'pending-review') return 'warning'
  return 'error'
}

async function handlePaste(): Promise<void> {
  if (!packetText.value.trim()) {
    message.warning('请先粘贴控制台回传包内容')
    return
  }
  importing.value = true
  try {
    const result = await importStore.pastePacket(packetText.value)
    if (result.status === 'invalid') {
      message.error(result.message)
      return
    }
    if (result.status === 'duplicate') {
      message.warning(result.message)
      if (result.packet) selectedPacketId.value = result.packet.id
      return
    }
    message.success(result.message)
    if (result.packet) selectedPacketId.value = result.packet.id
    packetText.value = ''
  } finally {
    importing.value = false
  }
}

async function handleTargetChange(value: string | number | Array<string | number> | null): Promise<void> {
  if (!selectedPacket.value || typeof value !== 'string') return
  await importStore.setTargetSession(selectedPacket.value.id, value)
  await retryReconcile()
}

async function retryReconcile(): Promise<void> {
  if (!selectedPacket.value) return
  reconciling.value = selectedPacket.value.id
  try {
    await importStore.runReconciliation(selectedPacket.value.id)
    message.success('对账已完成（已核对的进度继续保留）')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '对账失败，可从检查点重试')
  } finally {
    reconciling.value = null
  }
}

async function quickDecide(decision: 'console' | 'local'): Promise<void> {
  if (!selectedPacket.value) return
  const count = await importStore.decidePending(selectedPacket.value.id, decision)
  message.info(`已把 ${count} 条待处理项批量确认为「${decision === 'console' ? '采用控制台' : '保留本地'}」`)
}

async function handleApply(): Promise<void> {
  if (!selectedPacket.value) return
  applying.value = true
  try {
    const result = await importStore.applyResolved(selectedPacket.value.id)
    if (result.completed) message.success(`全部处理完成，本次写入 ${result.applied} 条`)
    else if (result.blocked > 0) message.warning(result.message ?? '部分条目被阻塞，补齐数据后可重试')
    else message.info(result.message ?? `已应用 ${result.applied} 条`)
  } finally {
    applying.value = false
  }
}

async function decideEntry(entry: ImportEntry, decision: 'console' | 'local' | 'ignore'): Promise<void> {
  await importStore.decideEntry(entry.id, decision)
}

async function resetEntry(entry: ImportEntry): Promise<void> {
  await importStore.resetEntry(entry.id)
}

function confirmRemove(packet: ImportPacket): void {
  dialog.warning({
    title: '删除回传包记录',
    content: `将删除回传包 ${packet.packetId} 及其对账进度，不影响已写入本地的 Cue 与通道电平。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await importStore.removePacket(packet.id)
      if (selectedPacketId.value === packet.id) selectedPacketId.value = null
      message.success('回传包记录已删除')
    }
  })
}

function fieldLabel(entry: ImportEntry): string {
  return entry.field ? IMPORT_FIELD_LABELS[entry.field] : kindLabel(entry.kind)
}

function kindLabel(kind: ImportEntry['kind']): string {
  switch (kind) {
    case 'cue-add':
      return '新增 Cue'
    case 'cue-field':
      return 'Cue 差异'
    case 'cue-local-only':
      return '本地独有 Cue'
    case 'level-add':
      return '新增通道电平'
    case 'level-field':
      return '通道电平差异'
    case 'level-local-only':
      return '本地独有通道电平'
  }
}

function decisionLabel(decision: ImportEntry['decision']): string {
  if (decision === 'console') return '采用控制台'
  if (decision === 'local') return '保留本地'
  if (decision === 'ignore') return '忽略'
  return '未决定'
}

/* ---------------- 生成示例回传包 ---------------- */
function fillSample(): void {
  const first = sessionStore.sortedSessions[0]
  if (!first) {
    message.warning('请先创建场次，才能基于本地数据生成示例回传包')
    return
  }
  const cues = cueStore.sortedCuesOfSession(first.id).slice(0, 3)
  const packetCues: ConsolePacketCue[] = cues.map((cue, index) => {
    const levels = levelStore.levelsOfCue(cue.id).slice(0, 4).map((level) => {
      const fixture = fixtureStore.fixtureById(level.fixtureId)
      return {
        channel: fixture?.channel ?? index + 1,
        intensity: Math.min(100, level.intensity + 10),
        colorTempK: level.colorTempK
      }
    })
    return {
      cueNo: cue.cueNo,
      label: index === 0 ? `${cue.label || 'Cue'}（控制台调整）` : cue.label,
      fadeInSec: cue.fadeInSec + 1,
      levels
    }
  })
  // 额外带一条本地没有的 Cue，演示新增对账
  packetCues.push({ cueNo: 'Q99', label: '控制台新增 Cue', fadeInSec: 2, fadeOutSec: 2, holdSec: 3, levels: [] })
  packetText.value = buildSamplePacket({
    packetId: `DEMO-${Date.now()}`,
    sessionOrder: first.order,
    sessionTitle: first.title,
    scope: 'partial',
    cues: packetCues
  })
  message.success('已生成示例回传包，可直接点击「导入并对账」')
}

function packetTime(packet: ImportPacket): string {
  return packet.exportedAt ? formatDateTime(packet.exportedAt) : formatDateTime(packet.pastedAt)
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">控制台回传包导入</h1>
        <p class="page__subtitle">
          把离线改完的控制台回传包粘进来，系统按场次 / Cue 编号 / 通道逐项对账：值不同会同时保留本地与控制台两个来源等待处理，绝不先覆盖。
        </p>
      </div>
    </header>

    <section class="panel">
      <h2 class="panel__title">
        粘贴回传包
        <span class="panel__title-tag">同一包（packetId / 内容指纹）再粘一次不重复写入</span>
      </h2>
      <NInput
        v-model:value="packetText"
        type="textarea"
        :rows="8"
        placeholder='粘贴控制台导出的 JSON，形如 {"format":"gbcuesheet-console-packet", ...}'
        class="import-textarea"
      />
      <div class="import-actions">
        <NButton type="primary" :loading="importing" @click="handlePaste">导入并对账</NButton>
        <NButton quaternary @click="fillSample">填入示例回传包</NButton>
        <NButton quaternary @click="packetText = ''">清空</NButton>
      </div>
    </section>

    <section class="panel">
      <div class="packet-head">
        <h2 class="panel__title">回传包记录<span class="panel__title-tag">共 {{ packets.length }} 个</span></h2>
      </div>

      <BlankHint
        v-if="packets.length === 0"
        title="还没有导入过回传包"
        description="演出前在灯光控制台上离线改 Cue，导出回传包后粘贴到上方文本框。导入进度与已核对决定都保存在浏览器本地，中断后可从检查点重试。"
        tip="排演表始终沿用生成时的快照版本，导入不会改写历史排演表。"
      />

      <div v-else class="packet-list">
        <article
          v-for="packet in packets"
          :key="packet.id"
          class="packet-card"
          :class="{ 'packet-card--active': selectedPacketId === packet.id }"
          @click="selectedPacketId = packet.id"
        >
          <div class="packet-card__row">
            <span class="packet-card__id mono">{{ packet.packetId }}</span>
            <NTag size="small" :type="stageTagType(packet.stage)" :bordered="false">
              {{ STAGE_LABEL[packet.stage] }}
            </NTag>
          </div>
          <div class="packet-card__meta">
            <span>场次：{{ sessionLabel(packet) }}</span>
            <span>{{ packet.scope === 'full' ? '整场快照' : '仅改动' }}</span>
            <span>Cue {{ packet.cueCount }} · 电平 {{ packet.levelCount }}</span>
            <span class="mono">{{ packetTime(packet) }}</span>
          </div>
          <div v-if="packet.error" class="packet-card__error">{{ packet.error }}</div>
        </article>
      </div>
    </section>

    <template v-if="selectedPacket">
      <section class="panel">
        <h2 class="panel__title">
          对账工作台
          <span class="panel__title-tag">确认后的控制台值只更新指定场次，不影响其他场次与历史排演表</span>
        </h2>

        <div class="workbench-toolbar">
          <span class="workbench-toolbar__label">写入场次</span>
          <NSelect
            :value="selectedPacket.targetSessionId"
            :options="sessionOptions"
            placeholder="指定写入场次"
            style="width: 260px"
            @update:value="handleTargetChange"
          />
          <NButton
            size="small"
            :loading="reconciling === selectedPacket.id"
            @click="retryReconcile"
          >
            {{ selectedPacket.stage === 'reconciling' ? '从检查点重试对账' : '按当前本地数据重新对账' }}
          </NButton>
          <span class="toolbar__spacer" />
          <NButton size="small" quaternary type="error" @click="confirmRemove(selectedPacket)">删除记录</NButton>
        </div>

        <NAlert
          v-if="!selectedPacket.targetSessionId"
          type="warning"
          :bordered="false"
          class="workbench-alert"
        >
          尚未指定写入场次。请在上方选择目标场次，系统会自动对账；控制台值只会写入该场次。
        </NAlert>
        <NAlert v-else-if="selectedPacket.error" type="error" :bordered="false" class="workbench-alert">
          {{ selectedPacket.error }}
        </NAlert>

        <div v-if="counts" class="progress-box">
          <div class="progress-box__head">
            <span>处理进度 {{ counts.applied }} / {{ counts.total }}</span>
            <span class="muted">
              待处理 {{ counts.pending }} · 未配接 {{ counts.unmapped }} · 已确认 {{ counts.resolved }}
            </span>
          </div>
          <NProgress
            type="line"
            :percentage="counts.percent"
            :height="10"
            :show-indicator="false"
            color="#f2b544"
          />
        </div>

        <div v-if="entries.length > 0" class="bulk-bar">
          <span class="muted">批量处理剩余待处理项：</span>
          <NButton size="small" @click="quickDecide('console')">全部采用控制台</NButton>
          <NButton size="small" @click="quickDecide('local')">全部保留本地</NButton>
          <span class="toolbar__spacer" />
          <NButton
            type="primary"
            size="small"
            :loading="applying"
            :disabled="counts === null || counts.resolved === 0"
            @click="handleApply"
          >
            应用已确认（{{ counts?.resolved ?? 0 }}）
          </NButton>
        </div>

        <BlankHint
          v-else-if="selectedPacket.targetSessionId && selectedPacket.stage !== 'reconciling'"
          title="没有需要对账的差异"
          description="回传包与指定场次当前的本地数据逐项一致（或差异已在此前处理完）。"
        />

        <div v-if="groups.length > 0" class="entry-groups">
          <div v-for="group in groups" :key="group.cueNo" class="entry-group">
            <p class="entry-group__title mono">{{ group.cueNo }}</p>
            <div
              v-for="entry in group.items"
              :key="entry.id"
              class="entry-row"
              :class="[`entry-row--${entry.status}`, { 'entry-row--decided': entry.status === 'resolved' }]"
            >
              <div class="entry-row__main">
                <span class="entry-row__field">{{ fieldLabel(entry) }}</span>
                <span v-if="entry.channel !== null" class="entry-row__channel mono">CH{{ entry.channel }}</span>
                <div class="entry-row__values">
                  <span class="entry-value entry-value--local">
                    <em>本地</em>{{ displayValue(entry.localValue) }}
                  </span>
                  <span class="entry-row__arrow">⇄</span>
                  <span class="entry-value entry-value--console">
                    <em>控制台</em>{{ displayValue(entry.consoleValue) }}
                  </span>
                </div>
              </div>

              <div class="entry-row__side">
                <NTag size="tiny" :type="STATUS_META[entry.status].type" :bordered="false">
                  {{ STATUS_META[entry.status].label }}
                </NTag>
                <span v-if="entry.status === 'resolved'" class="entry-row__decision muted">{{ decisionLabel(entry.decision) }}</span>
                <NTooltip v-if="entry.message" trigger="hover">
                  <template #trigger>
                    <NTag size="tiny" type="error" :bordered="false">原因</NTag>
                  </template>
                  {{ entry.message }}
                </NTooltip>

                <template v-if="entry.status !== 'applied'">
                  <NButton
                    size="tiny"
                    :type="entry.decision === 'console' ? 'primary' : 'default'"
                    :disabled="entry.status === 'unmapped'"
                    @click="decideEntry(entry, 'console')"
                  >
                    采用控制台
                  </NButton>
                  <NButton
                    size="tiny"
                    :type="entry.decision === 'local' ? 'primary' : 'default'"
                    @click="decideEntry(entry, 'local')"
                  >
                    保留本地
                  </NButton>
                  <NButton
                    size="tiny"
                    quaternary
                    :type="entry.decision === 'ignore' ? 'warning' : 'default'"
                    @click="decideEntry(entry, 'ignore')"
                  >
                    忽略
                  </NButton>
                  <NButton v-if="entry.status === 'resolved'" size="tiny" quaternary @click="resetEntry(entry)">
                    撤销
                  </NButton>
                </template>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.import-textarea {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 12px;
}

.import-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.packet-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}

.packet-card {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.16s ease, background 0.16s ease;
}

.packet-card:hover {
  background: rgba(255, 255, 255, 0.05);
}

.packet-card--active {
  border-color: rgba(242, 181, 68, 0.6);
  background: rgba(242, 181, 68, 0.07);
}

.packet-card__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.packet-card__id {
  font-weight: 600;
  color: #f2b544;
  font-size: 13px;
  word-break: break-all;
}

.packet-card__meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.packet-card__error {
  font-size: 12px;
  color: #ff8f8f;
}

.workbench-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.workbench-toolbar__label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.workbench-alert {
  margin-top: 12px;
}

.progress-box {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.progress-box__head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.entry-groups {
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.entry-group__title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #f2b544;
}

.entry-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.02);
  margin-bottom: 6px;
}

.entry-row--applied {
  opacity: 0.62;
}

.entry-row--unmapped {
  border-color: rgba(255, 143, 143, 0.45);
  background: rgba(255, 143, 143, 0.06);
}

.entry-row--decided {
  border-color: rgba(63, 191, 159, 0.4);
}

.entry-row__main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.entry-row__field {
  min-width: 96px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.82);
}

.entry-row__channel {
  font-size: 12px;
  color: #4ea1f2;
}

.entry-row__values {
  display: flex;
  align-items: center;
  gap: 10px;
}

.entry-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.entry-value em {
  font-style: normal;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 6px;
}

.entry-value--local {
  background: rgba(78, 161, 242, 0.12);
}

.entry-value--local em {
  background: rgba(78, 161, 242, 0.3);
}

.entry-value--console {
  background: rgba(242, 181, 68, 0.12);
}

.entry-value--console em {
  background: rgba(242, 181, 68, 0.32);
  color: #1a1408;
}

.entry-row__arrow {
  color: rgba(255, 255, 255, 0.35);
}

.entry-row__side {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.entry-row__decision {
  font-size: 11px;
}
</style>
