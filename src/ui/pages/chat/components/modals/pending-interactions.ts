/**
 * pending-interactions — 「待应答交互」的队列与展示焦点状态机（纯逻辑，可单测）。
 *
 * 背景：工具交互（AI 提问 `user_choice` / 授权确认 `authorization`）在引擎并发时可能**同时有多条挂起**
 * （两个会话各提一个问题、或提问与授权撞在一起）。改造前桌面端按类型各维护一个队列、各自独立渲染：
 * 同类第二个排队看不见、跨类两个弹窗直接**叠在一起**（后渲染的盖住先渲染的，被盖的那个既没人应答、
 * 也没人看得见）。数据没丢、之后能答，但用户当下不知道该先答哪个、也看不到「还有几个」。
 *
 * 现在统一成**一个队列 + 一个「当前展示项」指针**：
 *  - 一次只展示一项（弹窗不再互相覆盖）；
 *  - 新到的交互**不抢焦点**（用户可能正在填上一个）→ 在切换条上挂「未读」标记；
 *  - 可随时切到任意一项 —— 先去处理别的，再切回来继续答（各自表单里的草稿由弹窗实例保留）。
 *
 * ⚠️ 应答一律按 `interactionId` 精确路由（事件契约见 `events/toolInteractEvent.ts`），队列里存的就是它，
 * 本模块不引入第二套身份。
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

/**
 * 当前该展示哪一项：`activeId` 失效（已被应答 / 被移除）时退回队首，保证「有队列就一定有弹窗」。
 * 返回 null = 没有待应答交互（不渲染任何弹窗）。
 */
export function activeItem(state: PendingState): PendingInteraction | null {
  if (state.items.length === 0) return null
  return (
    state.items.find((i) => i.interactionId === state.activeId) ??
    state.items[0]
  )
}

/**
 * 新交互入队。
 *
 * **不抢焦点**：只有当前没有展示项（队列原本是空的）时才接管展示 —— 用户可能正在填上一条，
 * 把他正在答的东西顶掉（改造前就是这样互相覆盖的）比「排队等一会儿」糟得多。
 * 新项会被挂上「未读」标记，切换条上看得见，用户想答哪个就切哪个。
 */
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
 * 某个交互已被应答（本端应答 / 手机端等**另一个应答端**应答 / 运行结束被收敛 `expired`）→ 出队。
 *
 * ⚠️ 被移除的可能不是当前展示项：用户在切换条上切到别的项时，后台那一项也能被手机端应答。
 * 若被移除的正是当前展示项：接管**它原来的位置**（下一个；已是末尾则回退到上一个）——
 * 与切换条的阅读顺序一致，跳到别的项会让用户莫名其妙。
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

/**
 * 切到指定项（切换条点击 / `Alt+←→` 快捷键）→ 清掉它的未读标记。
 * 目标不存在时原样返回**同一个引用**（否则每次无效切换都会触发一次无意义的重渲染）。
 */
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

/**
 * 切换到「相邻」的一项（快捷键 `Alt+←/→`）：按队列顺序环形移动，
 * 只认当前展示项的位置；没有展示项时取队首 / 队尾。
 */
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

/**
 * AI 提问折成切换条上的一行标签：代码块整体丢掉（放不下，也不是「问题」本身），
 * 行内标记符号（粗体 / 标题 / 引用 / 行内代码）剥掉，连续空白压成单空格，超长截断 ——
 * chip 上只有一行的位置，完整问题在弹窗里。
 */
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
