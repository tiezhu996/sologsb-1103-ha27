<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NEmpty,
  NInput,
  NProgress,
  NSelect,
  NSpin,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import { useConsoleStore } from '@/stores/consoleStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useCueStore } from '@/stores/cueStore'
import type { ConsoleBatch, ReconcileItem, ReconcileItemStatus } from '@/types/console'
import { CONSOLE_FIELD_LABELS } from '@/types/console'
import { formatDateTime } from '@/utils/fade'

const message = useMessage()
const dialog = useDialog()
const consoleStore = useConsoleStore()
const sessionStore = useSessionStore()
const cueStore = useCueStore()

const packetText = ref('')
const importing = ref(false)
const expandedBatch = ref<string[]>([])

const sessionSelectOptions = computed(() => [
  { label: '不映射（该段不写入）', value: '' },
  ...sessionStore.sortedSessions.map((session) => ({
    label: `${session.order}. ${session.title}`,
    value: session.id
  }))
])

const statusMeta: Record<ReconcileItemStatus, { label: string; type: 'success' | 'warning' | 'info' | 'error' | 'default' }> = {
  identical: { label: '一致', type: 'success' },
  conflict: { label: '值不同·待裁决', type: 'warning' },
  'console-only': { label: '控制台独有', type: 'info' },
  'local-only': { label: '本地独有', type: 'default' },
  unmatched: { label: '无法配接', type: 'error' }
}

const batchStatusMeta = {
  processing: { label: '对账中', type: 'info' as const },
  failed: { label: '已中断', type: 'error' as const },
  pending: { label: '待裁决', type: 'warning' as const },
  applied: { label: '已完结', type: 'success' as const }
}

/** 填入一份演示回传包（与本地场次/Cue 对照用） */
function fillSamplePacket(): void {
  const sessions = sessionStore.sortedSessions
  const first = sessions[0]
  const refText = first ? String(first.title) : '1'
  const sampleCue = first ? cueStore.sortedCuesOfSession(first.id)[0] : null
  const cueNo = sampleCue ? sampleCue.cueNo : 'Q1'
  packetText.value = JSON.stringify(
    {
      format: 'gbcuesheet-console-return',
      version: 1,
      exportedAt: new Date().toISOString(),
      note: '技术合成后控制台离线改 Cue 回传',
      sessions: [
        {
          sessionRef: refText,
          cues: [
            {
              cueNo,
              label: '国王入场，收面光（控制台改）',
              fadeInSec: sampleCue ? sampleCue.fadeInSec : 4,
              levels: [
                { channel: 1, intensity: 72, colorTempK: 3200 },
                { channel: 512, intensity: 40 }
              ]
            },
            { cueNo: 'Q99', label: '控制台新增 Cue', fadeInSec: 2, fadeOutSec: 3, holdSec: 6 }
          ]
        }
      ]
    },
    null,
    2
  )
}

async function handleImport(): Promise<void> {
  if (!packetText.value.trim()) {
    message.warning('请先粘贴控制台回传包')
    return
  }
  importing.value = true
  try {
    const result = await consoleStore.startImport({ raw: packetText.value })
    if (!result.batch) {
      message.error(result.message)
      return
    }
    if (result.duplicated) {
      message.info(result.message)
    } else if (result.batch.status === 'failed') {
      message.warning(result.message)
    } else {
      message.success(result.message)
    }
    expandedBatch.value = [result.batch.id]
    packetText.value = ''
  } finally {
    importing.value = false
  }
}

async function handleRetry(batch: ConsoleBatch): Promise<void> {
  const refreshed = await consoleStore.retryImport(batch.id)
  if (!refreshed) return
  if (refreshed.status === 'failed') message.error(`仍中断于检查点：${refreshed.errorMessage}`)
  else message.success('已从检查点继续完成对账，此前核对进度全部保留')
}

async function handleMappingChange(batch: ConsoleBatch, sessionRef: string, value: string): Promise<void> {
  const mappings = batch.sessionMappings.map((mapping) =>
    mapping.sessionRef === sessionRef ? { ...mapping, sessionId: value || null } : mapping
  )
  await consoleStore.updateMappings(batch.id, mappings)
  message.success('已按新映射重新对账')
}

function mappingSessionTitle(sessionId: string | null): string {
  if (!sessionId) return '未映射'
  const session = sessionStore.sessionById(sessionId)
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}

async function handleResolve(item: ReconcileItem, resolution: 'console' | 'local' | 'accept' | 'skip'): Promise<void> {
  const result = await consoleStore.resolveItem(item.id, resolution)
  if (result.ok) message.success(result.message)
  else message.error(result.message)
}

async function handleReset(item: ReconcileItem): Promise<void> {
  await consoleStore.resetItem(item.id)
  message.info('已恢复为待裁决；已写入本地的值请到编辑页调整')
}

/** 冲突项一键处理：全部保留本地 / 全部采用控制台（仅处理当前批次可裁决项） */
function batchResolve(batchId: string, side: 'console' | 'local'): void {
  const batch = consoleStore.batchById(batchId)
  if (!batch) return
  const pending = consoleStore.pendingItemsOfBatch(batchId)
  if (pending.length === 0) {
    message.info('没有待裁决项')
    return
  }
  dialog.warning({
    title: side === 'console' ? '全部采用控制台值？' : '全部保留本地值？',
    content:
      side === 'console'
        ? `将对 ${pending.length} 个待裁决项逐项采用控制台值，只更新各自映射场次，排演表快照不变。`
        : `将对 ${pending.length} 个待裁决项保留本地值，不写入任何控制台改动。`,
    positiveText: '确认',
    negativeText: '取消',
    onPositiveClick: async () => {
      for (const item of pending) {
        const resolution = item.status === 'conflict' ? side : side === 'console' ? 'accept' : 'skip'
        // 逐项串行裁决：单条被拦截（如新 Cue 未先采纳）不影响其余项
        // eslint-disable-next-line no-await-in-loop
        await consoleStore.resolveItem(item.id, resolution)
      }
      message.success('批量裁决完成')
    }
  })
}

function confirmRemove(batch: ConsoleBatch): void {
  dialog.error({
    title: '删除导入批次',
    content: `将删除该回传包及全部对账记录，已写入本地的确认值不会回滚。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await consoleStore.removeBatch(batch.id)
      message.success('导入批次已删除')
    }
  })
}

function resolutionLabel(item: ReconcileItem): string {
  switch (item.resolution) {
    case 'console':
      return '已采用控制台'
    case 'local':
      return '已保留本地'
    case 'accept':
      return '已采纳新建'
    case 'skip':
      return '已跳过'
    default:
      return '待裁决'
  }
}

function fieldLabel(item: ReconcileItem): string {
  if (item.kind === 'cue-field' && item.field) return CONSOLE_FIELD_LABELS[item.field]
  if (item.kind === 'cue') return '整条 Cue'
  if (item.kind === 'cue-missing') return '整条 Cue（控制台无）'
  return `CH${item.channel ?? '?'} 电平`
}

function itemsGrouped(batch: ConsoleBatch): Array<{ cueNo: string; rows: ReconcileItem[] }> {
  const rows = consoleStore.itemsOfBatch(batch.id)
  const order: string[] = []
  const map = new Map<string, ReconcileItem[]>()
  rows.forEach((item) => {
    if (!map.has(item.cueNo)) {
      map.set(item.cueNo, [])
      order.push(item.cueNo)
    }
    map.get(item.cueNo)!.push(item)
  })
  return order.map((cueNo) => ({ cueNo, rows: map.get(cueNo)! }))
}

function progressOf(batch: ConsoleBatch): number {
  if (batch.totalUnits === 0) return 0
  return Math.round((batch.processedUnits / batch.totalUnits) * 100)
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">控制台回传对账</h1>
        <p class="page__subtitle">
          把控制台离线改 Cue 后的回传包粘进来，逐项与本地 Cue 表对账：值不同会同时保留两个来源等待裁决，不会先覆盖。
        </p>
      </div>
    </header>

    <section class="panel">
      <h2 class="panel__title">粘贴回传包<span class="panel__title-tag">同内容重复粘贴不重复写入</span></h2>
      <NInput
        v-model:value="packetText"
        type="textarea"
        :rows="10"
        placeholder='{"format":"gbcuesheet-console-return","version":1,"sessions":[...]}'
        class="packet-input"
      />
      <div class="import-bar">
        <NButton size="small" quaternary @click="fillSamplePacket">填入演示包</NButton>
        <span class="toolbar__spacer" />
        <NButton type="primary" :loading="importing" @click="handleImport">开始导入对账</NButton>
      </div>
      <NAlert type="info" :bordered="false" class="rule-hint">
        确认后的控制台值只更新该回传场次映射的本地场次；历史排演表沿用生成时的快照，不受导入影响。
        旧数据没有对账记录，一律按本地版本正常显示。
      </NAlert>
    </section>

    <section class="panel">
      <h2 class="panel__title">导入批次<span class="panel__title-tag">共 {{ consoleStore.batchesSorted.length }} 批</span></h2>

      <NEmpty v-if="consoleStore.batchesSorted.length === 0" description="还没有导入过控制台回传包" class="batch-empty" />

      <NCollapse v-else v-model:expanded-names="expandedBatch" accordion class="batch-list">
        <NCollapseItem
          v-for="batch in consoleStore.batchesSorted"
          :key="batch.id"
          :name="batch.id"
          :title="`批次 ${batch.id.slice(-6)} · ${batch.exportedAt ? formatDateTime(batch.exportedAt) : '无导出时刻'}`"
        >
          <template #header-extra>
            <NTag size="small" :type="batchStatusMeta[batch.status].type" :bordered="false">
              {{ batchStatusMeta[batch.status].label }}
            </NTag>
          </template>

          <!-- 检查点进度 / 失败重试 -->
          <div v-if="batch.status === 'processing' || batch.status === 'failed'" class="checkpoint">
            <NProgress
              type="line"
              :percentage="progressOf(batch)"
              :height="10"
              :show-indicator="false"
              :status="batch.status === 'failed' ? 'error' : 'default'"
            />
            <p class="checkpoint__text">
              检查点：已对账 {{ batch.processedUnits }} / {{ batch.totalUnits }} 个单元（{{ progressOf(batch) }}%）
            </p>
            <NAlert v-if="batch.status === 'failed'" type="error" :bordered="false" class="checkpoint__error">
              {{ batch.errorMessage }}
            </NAlert>
            <NButton size="small" type="primary" :loading="consoleStore.running" @click="handleRetry(batch)">
              从检查点重试
            </NButton>
          </div>

          <!-- 场次映射：确认后的值只进所选场次 -->
          <div class="mapping">
            <p class="mapping__title">场次映射（只更新被映射的本地场次）</p>
            <div v-for="mapping in batch.sessionMappings" :key="mapping.sessionRef" class="mapping__row">
              <span class="mapping__ref mono">控制台场次：{{ mapping.sessionRef }}</span>
              <span class="mapping__arrow">→</span>
              <NSelect
                :value="mapping.sessionId ?? ''"
                :options="sessionSelectOptions"
                size="small"
                style="width: 280px"
                :disabled="batch.status === 'applied'"
                @update:value="(value: string) => handleMappingChange(batch, mapping.sessionRef, value)"
              />
            </div>
          </div>

          <!-- 汇总与批量操作 -->
          <div class="batch-summary">
            <NTag size="small" type="warning" :bordered="false">待裁决 {{ consoleStore.countsOfBatch(batch.id).pending }}</NTag>
            <NTag size="small" type="warning" :bordered="false">值不同 {{ consoleStore.countsOfBatch(batch.id).conflict }}</NTag>
            <NTag size="small" type="info" :bordered="false">控制台独有 {{ consoleStore.countsOfBatch(batch.id).consoleOnly }}</NTag>
            <NTag size="small" :bordered="false">一致 {{ consoleStore.countsOfBatch(batch.id).identical }}</NTag>
            <NTag size="small" :bordered="false">本地独有 {{ consoleStore.countsOfBatch(batch.id).localOnly }}</NTag>
            <NTag size="small" type="error" :bordered="false">无法配接 {{ consoleStore.countsOfBatch(batch.id).unmatched }}</NTag>
            <span class="toolbar__spacer" />
            <NButton
              v-if="batch.status === 'pending'"
              size="tiny"
              :disabled="consoleStore.countsOfBatch(batch.id).pending === 0"
              @click="batchResolve(batch.id, 'local')"
            >
              全部保留本地
            </NButton>
            <NButton
              v-if="batch.status === 'pending'"
              size="tiny"
              type="primary"
              :disabled="consoleStore.countsOfBatch(batch.id).pending === 0"
              @click="batchResolve(batch.id, 'console')"
            >
              全部采用控制台
            </NButton>
            <NButton size="tiny" quaternary type="error" @click="confirmRemove(batch)">删除批次</NButton>
          </div>

          <p v-if="batch.note" class="batch-note">备注：{{ batch.note }}</p>

          <!-- 逐项对账表 -->
          <div v-if="consoleStore.itemsOfBatch(batch.id).length > 0" class="item-groups">
            <div v-for="group in itemsGrouped(batch)" :key="group.cueNo" class="item-group">
              <div class="item-group__head mono">
                {{ group.cueNo }}
                <span class="muted">（{{ mappingSessionTitle(group.rows[0].sessionId) }}）</span>
              </div>
              <div
                v-for="item in group.rows"
                :key="item.id"
                class="item-row"
                :class="[`item-row--${item.status}`, { 'item-row--resolved': item.resolution !== null }]"
              >
                <div class="item-row__main">
                  <span class="item-row__field">{{ fieldLabel(item) }}</span>
                  <NTag size="tiny" :type="statusMeta[item.status].type" :bordered="false">
                    {{ statusMeta[item.status].label }}
                  </NTag>
                  <span v-if="item.note" class="item-row__note muted">{{ item.note }}</span>
                </div>
                <div class="item-row__values">
                  <div class="value-cell value-cell--local">
                    <span class="value-cell__tag">本地</span>
                    <span class="value-cell__v">{{ item.localValue ?? '—' }}</span>
                  </div>
                  <div class="value-cell value-cell--console">
                    <span class="value-cell__tag">控制台</span>
                    <span class="value-cell__v">{{ item.consoleValue ?? '—' }}</span>
                  </div>
                </div>
                <div class="item-row__actions">
                  <template v-if="item.resolution === null">
                    <template v-if="item.status === 'conflict'">
                      <NButton size="tiny" type="primary" @click="handleResolve(item, 'console')">采用控制台</NButton>
                      <NButton size="tiny" @click="handleResolve(item, 'local')">保留本地</NButton>
                    </template>
                    <template v-else-if="item.status === 'console-only'">
                      <NButton size="tiny" type="primary" @click="handleResolve(item, 'accept')">采纳</NButton>
                      <NButton size="tiny" @click="handleResolve(item, 'skip')">跳过</NButton>
                    </template>
                    <span v-else class="item-row__auto muted">
                      {{ item.status === 'identical' ? '两边一致，无需处理' : '仅提示，默认沿用本地' }}
                    </span>
                  </template>
                  <template v-else>
                    <span class="item-row__resolved">{{ resolutionLabel(item) }}</span>
                    <NButton v-if="item.status === 'conflict' || item.status === 'console-only'" size="tiny" quaternary @click="handleReset(item)">
                      撤销
                    </NButton>
                  </template>
                </div>
              </div>
            </div>
          </div>
          <NSpin v-else size="small" class="batch-spin" />
        </NCollapseItem>
      </NCollapse>
    </section>
  </div>
</template>

<style scoped>
.packet-input {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 12px;
}

.import-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.rule-hint {
  margin-top: 12px;
}

.batch-empty {
  padding: 32px 0;
}

.checkpoint {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.07);
  margin-bottom: 14px;
}

.checkpoint__text {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.checkpoint__error {
  padding: 6px 10px;
}

.mapping {
  margin-bottom: 14px;
}

.mapping__title {
  margin: 0 0 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.mapping__row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.mapping__ref {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.78);
}

.mapping__arrow {
  color: rgba(255, 255, 255, 0.4);
}

.batch-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.batch-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.item-groups {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.item-group__head {
  font-size: 13px;
  font-weight: 600;
  color: #f2b544;
  margin-bottom: 6px;
}

.item-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(260px, 1.4fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  margin-bottom: 6px;
}

.item-row--conflict {
  border-color: rgba(242, 181, 68, 0.45);
  background: rgba(242, 181, 68, 0.05);
}

.item-row--console-only {
  border-color: rgba(78, 161, 242, 0.4);
  background: rgba(78, 161, 242, 0.05);
}

.item-row--unmatched {
  border-color: rgba(224, 123, 57, 0.4);
}

.item-row--resolved {
  opacity: 0.72;
}

.item-row__main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.item-row__field {
  font-size: 13px;
  font-weight: 600;
}

.item-row__note {
  font-size: 11px;
}

.item-row__values {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.value-cell {
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  min-width: 0;
}

.value-cell__tag {
  display: inline-block;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 4px;
  margin-right: 6px;
  vertical-align: 1px;
}

.value-cell--local {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.value-cell--local .value-cell__tag {
  background: rgba(255, 255, 255, 0.12);
}

.value-cell--console {
  background: rgba(78, 161, 242, 0.08);
  border: 1px solid rgba(78, 161, 242, 0.22);
}

.value-cell--console .value-cell__tag {
  background: rgba(78, 161, 242, 0.28);
}

.value-cell__v {
  word-break: break-all;
}

.item-row__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.item-row__auto,
.item-row__resolved {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.batch-spin {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}
</style>
