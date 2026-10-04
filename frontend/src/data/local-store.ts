import {
  appendWorkflowEvent,
  baselineFor,
  eventsFor,
  resetWorkflow,
  setRowStatusProvider,
} from './crosssection/event-store'
import { CROSSSECTION_KEY, foldStatus, type CrossSectionStatus, type WorkflowEventType } from './crosssection/workflow'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

// 断面测量的状态单一来源在事件台账：把行字段当前落库状态提供给台账做历史基线引导，
// 业务入口永远不应该直接写行里的 status。
setRowStatusProvider((id) => {
  const row = (allRows()[CROSSSECTION_KEY] ?? []).find((item) => Number(item.id) === id)
  return row ? String(row.status) : undefined
})

/**
 * 断面测量行投影：业务字段照原样取，status/pending/abnormal 一律由事件流归并得到。
 * 这是断面测量状态唯一允许被读到的方式，行字段里的旧状态值不再作数。
 */
function projectCrossSectionRow(row: EntryRow): EntryRow {
  const status = foldStatus(eventsFor(Number(row.id)), baselineFor(Number(row.id)))
  return { ...row, status, pending: status !== '已校核', abnormal: status === '需重测' }
}

export function listRows(key: string): EntryRow[] {
  const rows = allRows()[key] ?? []
  if (key === CROSSSECTION_KEY) {
    return rows.map(projectCrossSectionRow)
  }
  return rows
}

/**
 * 断面测量记录落库：业务字段（断面名称、起点距、河底高程等）正常保存，
 * 但 status/pending/abnormal 三个状态字段不允许由写入方决定——
 * 它们只从事件流归并，旧值保留在原始存储里仅作历史基线，读取时一律投影覆盖。
 */
function stripWorkflowState(incoming: EntryRow, previous: EntryRow | undefined): EntryRow {
  // 写入方带来的状态字段一律丢弃；落库保留上一版的原始状态作历史基线，读取时再由事件流投影覆盖。
  const fields: Omit<EntryRow, 'status' | 'pending' | 'abnormal'> = { ...incoming }
  delete fields.status
  delete fields.pending
  delete fields.abnormal
  const state = previous
    ? { status: previous.status, pending: previous.pending, abnormal: previous.abnormal }
    : { status: '已测量', pending: true, abnormal: false }
  return { ...fields, ...state } as EntryRow
}

export function saveRows(key: string, rows: EntryRow[]): void {
  let nextRows = rows
  if (key === CROSSSECTION_KEY) {
    const previous = allRows()[key] ?? []
    nextRows = rows.map((row) =>
      stripWorkflowState(row, previous.find((item) => Number(item.id) === Number(row.id))),
    )
  }
  const next = { ...allRows(), [key]: nextRows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  if (key === CROSSSECTION_KEY) {
    // 回到示例数据时事件台账一并清空，基线随示例状态重新引导，结论仍与历史一致。
    resetWorkflow()
  }
  saveRows(key, rows)
  return rows
}

/** 断面测量校核事件入口：服务层通过这里追加事件，其他写入路径全部不碰状态。 */
export function appendCrossSectionEvent(
  id: number,
  event: {
    type: WorkflowEventType
    status: CrossSectionStatus
    requestId: string
    source: string
    at: string
  },
) {
  return appendWorkflowEvent(id, event)
}

export function storageKey(): string {
  return STORAGE_KEY
}
