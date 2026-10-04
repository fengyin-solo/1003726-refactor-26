<template>
  <section class="page" data-module="crosssection">
    <header class="page-head">
      <div>
        <h2>断面测量管理</h2>
        <p class="page-desc">维护断面测量记录，围绕记录编号、站点编号、断面名称、测量方法做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记断面测量记录</button>
        <button class="btn" type="button" @click="exportRows">导出断面测量清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>核对清单</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="checklistOf(row).length">
              <button
                v-for="action in checklistOf(row)"
                :key="action"
                class="link"
                type="button"
                :disabled="busyKey === actionKey(row, action)"
                @click="runAction(action, row)"
              >
                {{ busyKey === actionKey(row, action) ? '处理中…' : action }}
              </button>
            </template>
            <span v-else class="muted-text">流程已闭环，无可办动作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无断面测量数据，可先登记断面测量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条断面测量记录</span>
      <span v-if="lastMessage" :class="lastOk ? 'ok-text' : 'error-text'">{{ lastMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  allowedActionsFor,
  createRequestId,
  downloadEntries,
  listEntries,
  moduleMeta,
  submitCrossSectionAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crosssection')
const columns = ["记录编号", "站点编号", "断面名称", "测量方法", "起点距", "河底高程", "测量日期", "记录状态"]
const statuses = ["已测量", "待校核", "已校核", "需重测"]
const stats = [{"label": "本月测量次数", "value": 0}, {"label": "待校核记录", "value": 0}, {"label": "需重测记录", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const lastMessage = ref('')
const lastOk = ref(true)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 当前正在处理的「记录+动作」：同一点击在拿到处理结果前禁用，并发也只有一个结果。
const busyKey = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 核对清单跟着状态走：清单不在页面里自己判断，统一取状态机投影出的可办动作，越级动作不出现。
function checklistOf(row: EntryRow): string[] {
  return allowedActionsFor(String(row.status))
}

function actionKey(row: EntryRow, action: string): string {
  return `${row.id}::${action}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  lastOk.value = false
  lastMessage.value = '断面测量记录登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  const key = actionKey(row, action)
  if (busyKey.value === key) {
    return
  }
  busyKey.value = key
  // 一次点击一个凭据；即使并发/重试重放，同一凭据也只产生一次处理结果。
  const requestId = createRequestId()
  try {
    // 入口只提交事件，状态由服务端归并；返回的 page 即落库结果，直接采用。
    const result = await submitCrossSectionAction(Number(row.id), action, {
      requestId,
      source: '断面测量管理',
    })
    lastOk.value = result.ok
    lastMessage.value = result.deduped ? `${result.message}（状态「${result.status}」）` : result.message
    rows.value = result.page.items
    total.value = result.page.total
  } catch (error) {
    lastOk.value = false
    lastMessage.value = error instanceof Error ? error.message : '断面测量动作提交失败'
    reload()
  } finally {
    busyKey.value = ''
  }
}

function reload() {
  lastMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    lastOk.value = false
    lastMessage.value = error instanceof Error ? error.message : '断面测量列表读取失败'
  }
}

onMounted(reload)
</script>
