/**
 * 断面测量校核流：状态的单一来源（事件溯源 / event sourcing）。
 *
 * 历史上「提交校核」「确认校核」「安排重测」三个入口各自直接改 status 字段，
 * 字段被多处覆盖后会出现相互矛盾的结论。这里把状态写收拢：
 *  - 入口只提交不可变事件（appendEvent），任何入口都不再写 status / pending / abnormal；
 *  - 当前状态一律由事件流按时间顺序归并（fold）投影得到，结论只有一个；
 *  - 归并规则是确定性的，同一份事件流无论归并多少次结果都一致。
 */

export const CROSSSECTION_KEY = 'crosssection'

/** 断面测量记录的全部状态。 */
export const CROSSSECTION_STATUSES = ['已测量', '待校核', '已校核', '需重测'] as const

export type CrossSectionStatus = (typeof CROSSSECTION_STATUSES)[number]

/** 三个入口各自能提交的事件；事件只追加、不可改。 */
export const WORKFLOW_EVENTS = ['提交校核', '确认校核', '安排重测'] as const

export type WorkflowEventType = (typeof WORKFLOW_EVENTS)[number]

export type WorkflowEvent = {
  /** 事件序号，即该记录事件流里的落库先后顺序。 */
  seq: number
  /** 该事件把记录推进到的状态。 */
  type: WorkflowEventType
  status: CrossSectionStatus
  /** 入口每次发起动作时生成的唯一凭据：同一凭据重放只产生一次处理结果。 */
  requestId: string
  /** 事件来源入口，便于排查是哪一个入口提交的。 */
  source: string
  at: string
}

/** 一次动作提交的处理结果。被拒绝的动作不会落库，因此不会产生事件。 */
export type SubmitOutcome =
  | { ok: true; message: string; status: CrossSectionStatus; event: WorkflowEvent; deduped: boolean }
  | { ok: false; message: string; status: CrossSectionStatus }

/**
 * 状态机：只允许在这张表里沿边推进，其余一律视为越级操作拒绝。
 * 已测量 → 待校核 → 已校核
 *               ↘ 需重测 → 待校核（重测完成后重新提交校核）
 */
const TRANSITIONS: Record<
  CrossSectionStatus,
  Partial<Record<WorkflowEventType, CrossSectionStatus>>
> = {
  已测量: { 提交校核: '待校核' },
  待校核: { 确认校核: '已校核', 安排重测: '需重测' },
  需重测: { 提交校核: '待校核' },
  已校核: {},
}

/**
 * 历史重测归并方式：
 * 「安排重测」产生的「需重测」是持续态——在事件流里会一直保持，直到后面出现
 * 一次「提交校核」把它推进回「待校核」为止；期间重复的「安排重测」不会改变结论，
 * 因为状态机只接受「需重测 → 待校核」，越级重复会被拒绝。这样即便历史上同一条记录
 * 被多次安排重测，归并出来的结论也唯一，并与既有落库结论保持一致。
 */
/**
 * 归并（fold）：以事件类型在状态机上逐条推进，而不是盲信事件携带的状态。
 * 遇到在当前状态下不允许的历史事件（越级/重复）直接跳过，结论仍唯一、合法。
 */
export function foldStatus(
  events: WorkflowEvent[],
  baseline: CrossSectionStatus = '已测量',
): CrossSectionStatus {
  return events.reduce<CrossSectionStatus>((status, event) => {
    return nextStatus(status, event.type) ?? status
  }, baseline)
}

/** 当前状态下还允许提交的动作，即各入口核对清单的唯一出处。 */
export function allowedActions(status: CrossSectionStatus): WorkflowEventType[] {
  return Object.keys(TRANSITIONS[status]) as WorkflowEventType[]
}

function nextStatus(status: CrossSectionStatus, type: WorkflowEventType): CrossSectionStatus | undefined {
  return TRANSITIONS[status][type]
}

/** 校验外部数据里读到的状态字符串，非法值回落到初始态。 */
export function asStatus(value: unknown): CrossSectionStatus {
  return CROSSSECTION_STATUSES.includes(value as CrossSectionStatus)
    ? (value as CrossSectionStatus)
    : '已测量'
}

export type WorkflowStoreLike = {
  /** 取某条记录的事件流（按 seq 升序）。 */
  eventsFor(id: number): WorkflowEvent[]
  /** 追加一条事件；返回落库后的事件流。 */
  appendEvent(id: number, event: WorkflowEvent): WorkflowEvent[]
  /** 某条记录是否已用过该 requestId（幂等去重）。 */
  hasRequest(id: number, requestId: string): boolean
}

/**
 * 归并一条记录：不做任何写入，只给当前结论和核对清单。
 * baseline 是无事件历史的既有记录的落库状态，用于兼容历史结论。
 */
export function projectRecord(
  store: WorkflowStoreLike,
  id: number,
  baseline: CrossSectionStatus,
): { status: CrossSectionStatus; events: WorkflowEvent[]; allowed: WorkflowEventType[] } {
  const events = store.eventsFor(id)
  const status = foldStatus(events, baseline)
  return { status, events, allowed: allowedActions(status) }
}

/**
 * 各入口统一走这里提交事件并归并，不再各自改字段。
 *
 * 串行化由调用方（local-service）用每条记录一把锁保证；这里只负责：
 *  1. requestId 幂等：同一动作凭据即使并发/重放，也只落一次处理结果；
 *  2. 状态机越级校验：越级、重复操作一律拒绝，且不产生事件；
 *  3. 追加事件后立即重新归并，返回的就是落库后的唯一结论。
 */
export function submitEvent(
  store: WorkflowStoreLike,
  params: {
    id: number
    action: string
    requestId: string
    baseline: CrossSectionStatus
    source?: string
  },
): SubmitOutcome {
  const { id, requestId, baseline } = params
  if (!requestId) {
    return {
      ok: false,
      message: '动作缺少提交凭据 requestId，已拒绝',
      status: foldStatus(store.eventsFor(id), baseline),
    }
  }
  if (store.hasRequest(id, requestId)) {
    // 同一动作的重复提交：不重复落库，直接回放第一次的处理结果。
    const events = store.eventsFor(id)
    const handled = events.find((item) => item.requestId === requestId) ?? events[events.length - 1]
    const status = foldStatus(events, baseline)
    return { ok: true, message: '该动作已处理过，沿用既有处理结果', status, event: handled, deduped: true }
  }

  const type = WORKFLOW_EVENTS.find((item) => item === params.action)
  const current = foldStatus(store.eventsFor(id), baseline)
  if (!type) {
    return { ok: false, message: `断面测量记录没有登记「${params.action}」这个动作`, status: current }
  }

  const target = nextStatus(current, type)
  if (!target) {
    // 已处于目标态算重复，其余算越级，两种都拒绝、都不落事件。
    const verb = current === actionTargetStatus(type) ? '重复' : '越级'
    return {
      ok: false,
      message: `当前状态为「${current}」，不能${verb}${type}（需先完成上一环节），已拒绝`,
      status: current,
    }
  }

  const events = store.eventsFor(id)
  const event: WorkflowEvent = {
    seq: events.length ? events[events.length - 1].seq + 1 : 1,
    type,
    status: target,
    requestId,
    source: params.source ?? '断面测量管理',
    at: new Date().toISOString(),
  }
  const stored = store.appendEvent(id, event)
  const status = foldStatus(stored, baseline)
  return { ok: true, message: `断面测量记录已${type}，当前状态「${status}」`, status, event, deduped: false }
}

function actionTargetStatus(type: WorkflowEventType): CrossSectionStatus {
  for (const status of CROSSSECTION_STATUSES) {
    const target = TRANSITIONS[status][type]
    if (target) {
      return target
    }
  }
  return '已测量'
}
