/**
 * 断面测量校核流的事件台账：只追加（append-only）的持久化层。
 *
 * 行记录（断面名称、起点距、河底高程等业务字段）仍在 local-store，
 * 状态不允许再写进行字段；这里只存两样东西：
 *  - events：每条记录不可变的事件流，当前状态全部由它归并得到；
 *  - baselines：没有事件历史的既有记录，用其「既有落库状态」钉一条基线，
 *    归并时从基线开始 fold，从而兼容历史结论（历史重测/校核结论不变）。
 */

import { SEED_ROWS } from '../seed'
import type { WorkflowEvent, WorkflowEventType } from './workflow'
import { asStatus } from './workflow'

const LEDGER_KEY = 'hydrology-monitor-station:crosssection-workflow'

type Ledger = {
  events: Record<string, WorkflowEvent[]>
  baselines: Record<string, string>
}

/** 由 local-store 注入：读取某条记录当前行里的落库状态（仅用于历史基线引导）。 */
let statusProvider: ((id: number) => string | undefined) | null = null

export function setRowStatusProvider(provider: (id: number) => string | undefined): void {
  statusProvider = provider
}

function seedBaselines(): Record<string, string> {
  const baselines: Record<string, string> = {}
  for (const row of SEED_ROWS.crosssection ?? []) {
    baselines[String(row.id)] = asStatus(row.status)
  }
  return baselines
}

function readLedger(): Ledger {
  const fallback: Ledger = { events: {}, baselines: seedBaselines() }
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>
    return {
      events: parsed.events ?? {},
      baselines: { ...seedBaselines(), ...(parsed.baselines ?? {}) },
    }
  } catch {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Ledger | null = null

function ledger(): Ledger {
  if (cache === null) {
    cache = readLedger()
  }
  ensureRows()
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage && cache) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(cache))
  }
}

/** 新出现的行（含重置后播种的行）补基线；已有事件历史的行保持既有基线不动。 */
function ensureRows(): void {
  if (!cache || !statusProvider) {
    return
  }
  for (const row of SEED_ROWS.crosssection ?? []) {
    const key = String(row.id)
    if (!(key in cache.events) && !(key in cache.baselines)) {
      cache.baselines[key] = asStatus(statusProvider(row.id) ?? row.status)
    }
  }
}

function sorted(events: WorkflowEvent[]): WorkflowEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq)
}

export function eventsFor(id: number): WorkflowEvent[] {
  return sorted(ledger().events[String(id)] ?? [])
}

export function baselineFor(id: number): ReturnType<typeof asStatus> {
  return asStatus(ledger().baselines[String(id)])
}

export function hasRequest(id: number, requestId: string): boolean {
  return eventsFor(id).some((event) => event.requestId === requestId)
}

export function appendEvent(
  id: number,
  event: {
    type: WorkflowEventType
    status: WorkflowEvent['status']
    requestId: string
    source: string
    at: string
  },
): WorkflowEvent[] {
  const key = String(id)
  const data = ledger()
  const list = data.events[key] ?? []
  // 基线在首次落事件时钉死：此后无论行字段如何变化，结论都只由事件流决定。
  if (!(key in data.baselines)) {
    data.baselines[key] = asStatus(statusProvider?.(id))
  }
  const stored: WorkflowEvent = { ...event, seq: list.length ? Math.max(...list.map((item) => item.seq)) + 1 : 1 }
  const next = [...list, stored]
  data.events[key] = next
  persist()
  return sorted(next)
}

/** 重置断面测量模块时同步清空台账，基线随示例数据重新引导。 */
export function resetWorkflow(): void {
  cache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(LEDGER_KEY)
  }
}

export function workflowStorageKey(): string {
  return LEDGER_KEY
}

/** 供 local-store 转发使用的显式别名，避免数据层直接依赖事件追加内部命名。 */
export { appendEvent as appendWorkflowEvent }
