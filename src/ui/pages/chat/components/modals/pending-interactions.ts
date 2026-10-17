/**
 * 待应答交互的队列与展示焦点状态机（纯逻辑，可单测）：统一队列 + 单一 activeId，
 * 一次只展示一项、新到不抢焦点、按 `interactionId` 精确路由。
 */
import type {
  AuthorizationRequest,
  ChoiceRequest,
} from '@/events/toolInteractEvent'

/** 队列里的一个待应答交互（`kind` 决定渲染哪个弹窗、切换条上怎么标注）。 */
export type PendingInteraction =
  | ({ kind: 'choice' } & ChoiceRequest)
  | ({ kind: 'authorization' } & AuthorizationRequest)

export interface PendingState {
  /** 待应答交互，按**到达顺序**（切换条上的序号就是它）。 */
  items: PendingInteraction[]
  /** 当前展示项的 interactionId；null = 没有展示项（渲染时退回队首）。 */
  activeId: string | null
  /** 还没被展示过的项（新到且一直没轮上）→ 切换条上打未读点。 */
  unread: string[]
}

export const EMPTY_PENDING_STATE: PendingState = {
  items: [],
  activeId: null,
  unread: [],
}

/** 当前展示项；`activeId` 失效时退回队首，空队列返回 null。 */
export function activeItem(state: PendingState): PendingInteraction | null {
  if (state.items.length === 0) return null
  return (
    state.items.find((i) => i.interactionId === state.activeId) ??
    state.items[0]
  )
}

/** 入队且**不抢焦点**：已有展示项时只挂未读标记；同一 interactionId 幂等。 */
export function enqueue(
  state: PendingState,
  item: PendingInteraction,
): PendingState {
  // 同一个交互重复入队（事件重放 / 手机端与桌面端都收到）→ 幂等
  if (state.items.some((i) => i.interactionId === item.interactionId)) {
    return state
  }
  const items = [...state.items, item]
  const taken =
    !!state.activeId && state.items.some((i) => i.interactionId === state.activeId)
  if (taken) {
    return { items, activeId: state.activeId, unread: [...state.unread, item.interactionId] }
  }
  // 没人占着展示位 → 新项直接上台（它立刻就可见，不必标未读）
  return { items, activeId: item.interactionId, unread: state.unread }
}

/**
 * 出队。被移除的若是当前展示项，接管它原来的位置（下一个，末尾则回退上一个）；
 * 被移除的可能不是展示项 —— 另一个应答端（手机端等）也能应答后台项。
 */
export function removePending(
  state: PendingState,
  interactionId: string,
): PendingState {
  const index = state.items.findIndex((i) => i.interactionId === interactionId)
  if (index < 0) return state
  const items = state.items.filter((i) => i.interactionId !== interactionId)
  let unread = state.unread.filter((id) => id !== interactionId)
  if (state.activeId !== interactionId) {
    return { items, activeId: state.activeId, unread }
  }
  const next = items[Math.min(index, items.length - 1)]
  // 接手展示的那一项立刻可见 → 清掉它的未读点
  if (next) unread = unread.filter((id) => id !== next.interactionId)
  return { items, activeId: next ? next.interactionId : null, unread }
}

/** 切到指定项并清未读；目标不存在时返回同一引用（避免无效重渲染）。 */
export function activate(state: PendingState, interactionId: string): PendingState {
  if (!state.items.some((i) => i.interactionId === interactionId)) return state
  if (
    state.activeId === interactionId &&
    !state.unread.includes(interactionId)
  ) {
    return state
  }
  return {
    ...state,
    activeId: interactionId,
    unread: state.unread.filter((id) => id !== interactionId),
  }
}

/** 环形切到相邻项（`Alt+←/→`）；无展示项时从队首 / 队尾起算。 */
export function stepPending(
  state: PendingState,
  delta: number,
  currentId: string | null,
): PendingState {
  const len = state.items.length
  if (len < 2) return state
  const index = state.items.findIndex((i) => i.interactionId === currentId)
  const from = index < 0 ? (delta >= 0 ? -1 : 0) : index
  const next = (from + delta + len) % len
  return activate(state, state.items[next].interactionId)
}

/** 提问压成 chip 单行标签：丢代码块与行内标记、空白归一、超长截断。 */
export function questionSummary(question: string, max = 36): string {
  const flat = (question || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 切换条上的标签：授权取权限标题（没有标题退回权限 key），提问取问题摘要。 */
export function pendingLabel(item: PendingInteraction): string {
  if (item.kind === 'authorization') return item.title || item.permName
  return questionSummary(item.question)
}
