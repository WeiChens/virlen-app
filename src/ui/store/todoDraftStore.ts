/**
 * todoDraftStore — 任务清单「本地草稿」（按会话缓存）
 *
 * 用途：AI 回复期间用户也能改清单。改动先落在草稿里 —— 既不打断本轮引擎
 * （引擎的消息数组是内存快照，追加消息也不影响本轮），也不会被 AI 本轮后续的
 * 写入覆盖。
 *
 * 草稿分两态，**「应用」是唯一的分界线**：
 *   - `committed = false`（编辑中）：只是草稿，清单权威不变，**不会被自动落地**；
 *   - `committed = true`（已应用）：用户已确认，等本轮回复流真正结束（stream_end
 *     非 paused）或用户取消本轮时，由 `services/todo-service.flushTodoDraft()`
 *     逐字落地成一条 `role='feedback'` 消息（用户这份为准，不做字段级合并）。
 *   AI 空闲时点「应用」则立即落地（`applyTodoDraft`），不经过 committed 阶段。
 *   任何后续编辑都会把 `committed` 复位 —— 「编辑中」永远不等于「已修改」。
 *
 * `base` 不只是备份：**编辑期间 AI 又写了一版清单**就靠它识别 ——
 * `sameTodoList(最新清单, base)` 不相等 = 权威被换过，编辑器提示「AI 已更新」，
 * 并把「放弃编辑并同步 / 覆盖更新」两个出口摆明（见 `TodoEditor`）。
 *
 * 与 Run Snapshot 同级：**只在内存**，刷新即失效；不进消息流、不落库。
 * 会话删除时由 `dropTodoDrafts()` 一并清理（避免内存泄漏）。
 */
import { runInAction } from 'mobx'
import RuntimeState from '@/utils/runtimeState'
import type { TodoItem } from '@/domain/todo/types'

/** 单个会话的清单草稿 */
export interface TodoDraft {
  /** 用户开始编辑时的清单（用来判断「编辑期间 AI 是否又写了一版」） */
  base: TodoItem[]
  /** 用户编辑后的清单 */
  todos: TodoItem[]
  /**
   * 用户是否已点「应用变更」。
   * false = 还在编辑，不生效；true = 已应用，等本轮结束 / 取消时合并落地。
   */
  committed: boolean
}

interface TodoDraftStoreShape {
  drafts: Record<string, TodoDraft>
}

const defaultState: TodoDraftStoreShape = { drafts: {} }

/** JSON 深拷贝（清单是纯数据，无循环引用） */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

export const todoDraftState = new RuntimeState<TodoDraftStoreShape>(
  defaultState,
).mixins({
  setDraft(sessionId: string, draft: TodoDraft | null) {
    if (!sessionId) return
    runInAction(() => {
      // 整体替换对象：MobX 才能感知到变化（就地改字段不会触发重渲染）
      const drafts = { ...todoDraftState.value.drafts }
      if (draft) drafts[sessionId] = draft
      else delete drafts[sessionId]
      todoDraftState.value.drafts = drafts
    })
  },
})

/** 取草稿（无则 undefined） */
export function getTodoDraft(sessionId: string): TodoDraft | undefined {
  return todoDraftState.value.drafts[sessionId]
}

export function hasTodoDraft(sessionId: string): boolean {
  return !!getTodoDraft(sessionId)
}

/**
 * 取（必要时创建）草稿。
 *
 * `effective` 是「用户开始编辑那一刻生效的清单」，作为 `base` 存下来 ——
 * 之后不会再重新采样 base（否则用户编辑期间 AI 的写入会被当成用户意图）。
 */
export function ensureTodoDraft(
  sessionId: string,
  effective: TodoItem[],
): TodoDraft {
  const exist = getTodoDraft(sessionId)
  if (exist) return exist
  const draft: TodoDraft = {
    base: clone(effective),
    todos: clone(effective),
    committed: false,
  }
  todoDraftState.setDraft(sessionId, draft)
  return draft
}

/**
 * 用新的清单内容替换草稿内容（base 保持不变）。
 *
 * ⚠️ 任何编辑都会把 `committed` 复位 —— 用户改完还没再点「应用」，
 * 这份改动就只是草稿，本轮结束 / 取消都不会带上它。
 */
export function updateTodoDraftItems(
  sessionId: string,
  todos: TodoItem[],
): void {
  const draft = getTodoDraft(sessionId)
  if (!draft) return
  todoDraftState.setDraft(sessionId, { ...draft, todos, committed: false })
}

/**
 * 标记草稿「已应用」（AI 回复期间用户点「应用变更」时调用）。
 *
 * @returns 是否存在草稿 —— 无草稿（用户什么都没改）时返回 false，
 *          调用方据此提示「清单没有变化」。
 */
export function markTodoDraftCommitted(sessionId: string): boolean {
  const draft = getTodoDraft(sessionId)
  if (!draft) return false
  if (!draft.committed) {
    todoDraftState.setDraft(sessionId, { ...draft, committed: true })
  }
  return true
}

/** 草稿是否处于「已应用、等本轮结束生效」状态 */
export function isTodoDraftCommitted(sessionId: string): boolean {
  return !!getTodoDraft(sessionId)?.committed
}

/** 丢弃草稿（用户点「放弃修改」/ 落地完成后清理） */
export function clearTodoDraft(sessionId: string): void {
  todoDraftState.setDraft(sessionId, null)
}

/**
 * 丢弃「还没应用」的草稿（**浮层关闭时**调用）。
 *
 * 约定：草稿只活在浮层里 —— 关掉浮层 = 放弃这次编辑（与主流内联编辑面板一致）：
 * 没点「应用变更 / 覆盖更新」就不算修改，不应该悄悄留在内存里、下次开窗又冒出来。
 * ⚠️ 「已应用」（committed）的草稿是「用户已确认、等本轮生效」，关窗时**绝不能丢**。
 *
 * @returns 是否真的丢了东西（调用方据此决定要不要提示）
 */
export function dropUnappliedTodoDraft(sessionId: string): boolean {
  const draft = getTodoDraft(sessionId)
  if (!draft || draft.committed) return false
  clearTodoDraft(sessionId)
  return true
}

/** 会话被删除时清理草稿（与 dropSessionRuntime 同策略） */
export function dropTodoDrafts(ids: Iterable<string>): void {
  const list = Array.from(ids)
  if (list.length === 0) return
  runInAction(() => {
    const drafts = { ...todoDraftState.value.drafts }
    for (const id of list) delete drafts[id]
    todoDraftState.value.drafts = drafts
  })
}
