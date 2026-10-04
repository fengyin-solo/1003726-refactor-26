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
  metrics: string[]
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

/** 断面测量动作提交结果：先归并事件，再带回落库后的列表与该记录的核对清单。 */
export type CrossSectionActionResult = {
  ok: boolean
  message: string
  /** 本次动作凭据：并发/重放同一凭据只产生一次处理结果。 */
  requestId: string
  /** 归并后的当前状态（单一来源投影）。 */
  status: string
  /** 当前状态下还允许的动作，供各入口更新核对清单。 */
  allowed: string[]
  /** 是否命中幂等去重（同一动作的重复提交）。 */
  deduped: boolean
  /** 先归并事件后读到的列表落库结果。 */
  page: PageResult
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
