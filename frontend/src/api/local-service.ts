import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  appendCrossSectionEvent,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import { baselineFor, eventsFor, hasRequest } from '@/data/crosssection/event-store'
import {
  allowedActions as workflowAllowed,
  CROSSSECTION_KEY,
  submitEvent,
  type CrossSectionStatus,
  type SubmitOutcome,
  type WorkflowEventType,
} from '@/data/crosssection/workflow'
import type {
  ActionResult,
  CrossSectionActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 断面测量校核事件台账适配器：归并规则在 workflow.ts，持久化在 event-store.ts。
 * 这里是唯一允许向台账追加事件的出口，service 之外的任何入口都改不到状态。
 */
const workflowStore = {
  eventsFor,
  hasRequest,
  appendEvent: (
    id: number,
    event: {
      type: WorkflowEventType
      status: CrossSectionStatus
      requestId: string
      source: string
      at: string
    },
  ) => appendCrossSectionEvent(id, event),
}

// 每条断面记录一把处理锁：同一条记录的并发提交排队串行处理，不同记录互不阻塞。
const recordLocks = new Map<number, Promise<void>>()

function withRecordLock<T>(id: number, task: () => T): Promise<T> {
  const previous = recordLocks.get(id) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  recordLocks.set(
    id,
    previous.then(() => gate),
  )
  return previous.then(() => {
    try {
      return task()
    } finally {
      release()
    }
  })
}

/** 生成动作凭据：一次点击一个 id；同一动作因并发/重试重放时由调用方沿用同一 id。 */
export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 断面测量三个入口（提交校核 / 确认校核 / 安排重测）的统一提交口。
 * 入口只提交事件，状态由台账归并；动作完成后先归并事件、再返回列表，
 * 返回的 page 就是落库结果，调用方无需再猜。
 */
export function submitCrossSectionAction(
  id: number,
  action: string,
  options: { requestId?: string; source?: string } = {},
): Promise<CrossSectionActionResult> {
  moduleMeta(CROSSSECTION_KEY)
  const exists = (allRows()[CROSSSECTION_KEY] ?? []).some((row) => Number(row.id) === id)
  if (!exists) {
    return Promise.resolve({
      ok: false,
      message: `没有找到编号为 ${id} 的断面测量记录`,
      status: '已测量',
      allowed: [],
      requestId: options.requestId ?? '',
      deduped: false,
      page: listEntries(CROSSSECTION_KEY),
    })
  }

  const requestId = options.requestId || createRequestId()
  return withRecordLock(id, () => {
    const outcome: SubmitOutcome = submitEvent(workflowStore, {
      id,
      action,
      requestId,
      baseline: baselineFor(id),
      source: options.source ?? '断面测量管理',
    })
    // 无论成功还是被拒绝，都先按事件台账重新归并，再读列表查看落库结果。
    const page = listEntries(CROSSSECTION_KEY)
    return {
      ok: outcome.ok,
      message: outcome.message,
      requestId,
      status: outcome.status,
      allowed: workflowAllowed(outcome.status),
      deduped: outcome.ok ? outcome.deduped : false,
      page,
    }
  })
}

/** 某条断面记录当前状态下可执行的动作（各入口核对清单的唯一出处）。 */
export function crossSectionChecklist(id: number): { status: string; allowed: WorkflowEventType[] } {
  const row = listRows(CROSSSECTION_KEY).find((item) => Number(item.id) === id)
  const status = row ? String(row.status) : '已测量'
  return { status, allowed: workflowAllowed(status as never) }
}

/** 页面按状态取核对清单：只暴露合法动作，越级动作不渲染、提交也会被拒绝。 */
export function allowedActionsFor(status: string): WorkflowEventType[] {
  return workflowAllowed(status as never)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === CROSSSECTION_KEY) {
    // 断面测量的状态已收拢到事件台账，禁止再用通用入口直接改字段。
    return {
      ok: false,
      message: '断面测量记录请通过校核事件入口提交，不允许直接修改状态字段',
    }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 断面测量用事件归并投影后的列表统计，其余模块沿用原始行。
    const entries = meta.key === CROSSSECTION_KEY ? listRows(meta.key) : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
