/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 动作允许的发起状态：登记了就按表校验，越级一律拒绝；没登记的模块保持任意状态可发起。
  actionSources?: Record<string, string[]>
  metrics: string[]
}

// 状态事件：各入口只提交事件，记录的状态由事件统一归并得出，不再各自改字段。
export type StatusEvent = {
  eventId: string
  moduleKey: string
  rowId: number
  action: string
  target: string
  message: string
  seq: number
  createdAt: string
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
