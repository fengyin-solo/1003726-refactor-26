import type { StatusEvent } from './types'

// 状态事件日志：各入口只往这里提交事件，记录状态由归并得出，不再各自改字段。
// 每次读写都直接走 localStorage 不留内存缓存，连点、多标签页并发提交看到的都是同一份日志。
const EVENTS_KEY = 'hydrology-monitor-station:events'

function readEvents(): StatusEvent[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(EVENTS_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as StatusEvent[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeEvents(events: StatusEvent[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(EVENTS_KEY, JSON.stringify(events))
  }
}

export function listModuleEvents(moduleKey: string, rowId?: number): StatusEvent[] {
  return readEvents()
    .filter((event) => event.moduleKey === moduleKey && (rowId === undefined || event.rowId === rowId))
    .sort((a, b) => a.seq - b.seq)
}

// 查同一动作已归并的处理结果：幂等判定的依据，重复提交直接返回这条，不再追加。
export function findRecordedEvent(
  moduleKey: string,
  rowId: number,
  action: string,
): StatusEvent | undefined {
  const matched = listModuleEvents(moduleKey, rowId).filter((event) => event.action === action)
  return matched[matched.length - 1]
}

export function appendEvent(input: Omit<StatusEvent, 'eventId' | 'seq' | 'createdAt'>): StatusEvent {
  const events = readEvents()
  const seq = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1
  const event: StatusEvent = {
    ...input,
    eventId: `${input.moduleKey}:${input.rowId}:${input.action}:${seq}`,
    seq,
    createdAt: new Date().toISOString(),
  }
  writeEvents([...events, event])
  return event
}

export function clearModuleEvents(moduleKey: string): void {
  writeEvents(readEvents().filter((event) => event.moduleKey !== moduleKey))
}
