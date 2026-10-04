import type { ActionResult, EntryRow, ModuleMeta, StatusEvent } from './types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 状态写入的唯一来源：所有入口只提交事件，状态一律由这里归并得出。
function applyEvent(meta: ModuleMeta, row: EntryRow, event: StatusEvent): EntryRow {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return {
    ...row,
    status: event.target,
    pending: event.target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => event.action.startsWith(verb)),
  }
}

// 统一归并：以落库行为基线（兼容既有历史结论，历史「需重测」没有事件就原样保留），
// 再按事件序号顺序叠加；事件记的是目标状态，重复归并结果不变。
export function mergeRowsWithEvents(
  meta: ModuleMeta,
  rows: EntryRow[],
  events: StatusEvent[],
): EntryRow[] {
  if (events.length === 0) {
    return rows
  }
  const byRow = new Map<number, StatusEvent[]>()
  for (const event of events) {
    const list = byRow.get(event.rowId) ?? []
    list.push(event)
    byRow.set(event.rowId, list)
  }
  return rows.map((row) => {
    const list = byRow.get(Number(row.id))
    if (!list || list.length === 0) {
      return row
    }
    return list.reduce((acc, event) => applyEvent(meta, acc, event), row)
  })
}

// 越级判定：登记了 actionSources 的动作只能从列出的状态发起，其余一律拒绝。
export function decideTransition(meta: ModuleMeta, current: string, action: string): ActionResult {
  const target = meta.actionTargets[action]
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    return {
      ok: false,
      message: `越级操作已拒绝：${meta.entity}当前状态「${current}」，「${action}」只能从「${sources.join('」「')}」发起`,
    }
  }
  return { ok: true, message: '' }
}
