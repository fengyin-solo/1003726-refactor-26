import { MODULE_BY_KEY } from '@/data/modules'
import { appendEvent, clearModuleEvents, findRecordedEvent, listModuleEvents } from '@/data/event-store'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { decideTransition, mergeRowsWithEvents } from '@/data/status-flow'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 统一归并再落库：事件日志是唯一来源，归并结果写回后各入口看到的结论才一致。
function mergeModuleRows(key: string): EntryRow[] {
  const meta = moduleMeta(key)
  const events = listModuleEvents(key)
  if (events.length === 0) {
    return listRows(key)
  }
  const merged = mergeRowsWithEvents(meta, listRows(key), events)
  saveRows(key, merged)
  return merged
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
  const matched = filterRows(mergeModuleRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 各入口共用的提交口：只登记事件，不直接改状态字段。
// 同一动作已归并过且状态仍停在它的结论上，说明是重复/并发提交，直接返回已登记的唯一结果。
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = mergeModuleRows(key)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(row.status)
  const recorded = findRecordedEvent(key, id, action)
  if (recorded && current === recorded.target) {
    return { ok: true, message: recorded.message }
  }
  const decision = decideTransition(meta, current, action)
  if (!decision.ok) {
    return decision
  }
  const event = appendEvent({
    moduleKey: key,
    rowId: id,
    action,
    target,
    message: `${meta.entity}已${action}，当前状态「${target}」`,
  })
  mergeModuleRows(key)
  return { ok: true, message: event.message }
}

export function resetModule(key: string): PageResult {
  clearModuleEvents(key)
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of mergeModuleRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
  for (const meta of MODULE_BY_KEY.values()) {
    mergeModuleRows(meta.key)
  }
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
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
