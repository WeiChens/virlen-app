/**
 * todo-service — 任务清单落地（todo 相关**唯一有副作用的地方**）。
 *
 * 数据流：模型写入 → todo_write 工具 → tool_result 消息（content 给模型 / uiData 给 UI）；
 * 用户编辑 → 草稿（todoDraftStore，纯内存）→ 落地时**逐字生效**（不做字段级合并）
 * → 追加一条 role='feedback' 的消息（模型下一轮天然可见）。
 *
 * 「编辑的同时 AI 也在改」：**不自动合并**，编辑器提示「AI 已更新」，由用户显式二选一
 *（放弃编辑并同步 / 覆盖更新）。宁可让用户选一次，也不做「看到一份、落地变另一份」的隐式合并。
 *
 * 用「追加 feedback 消息」而非原地改历史：消息是唯一权威载体；session_db 无「更新单条消息」IPC；
 * feedback 被三个 Provider 统一映射成 user，模型可见；UI 渲染成「你更新了任务清单」胶囊。
 *
 * 落地时机：轮次边界 → flushTodoDraftMessages('round_boundary')（本轮模型即可见）；
 * AI 空闲点「应用变更」→ applyTodoDraft('user')；AI 回复中 → 只 markTodoDraftCommitted，待边界落地；
 * 兜底（stream_end 非 paused / 取消）→ flushTodoDraft()。paused（等弹窗）不落地。只落地「已应用」的草稿。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Message } from '@/types'
import { v4 } from '@/utils/uuid'
import { track, hashText } from '@/utils/telemetry'
import {
  computeStats,
  diffTodos,
  pickCurrentTodos,
  renderUserTodoContent,
} from '@/domain/todo/state'
import type { TodoChange, TodoItem, TodoUiData } from '@/domain/todo/types'
import { addSessionMessage, getSessionMessages } from '@/services/chat/messages'
import { isTauriAvailable } from '@/services/rust-engine'
import {
  clearTodoDraft,
  getTodoDraft,
  isTodoDraftCommitted,
} from '@/ui/store/todoDraftStore'

/** 草稿落地的原因（仅用于埋点与日志） */
export type TodoApplyReason = 'user' | 'round_boundary' | 'stream_end' | 'cancel'

/** 当前生效的清单（从消息历史派生）；UI 也可直接用 pickCurrentTodos。 */
export function getEffectiveTodos(sessionId: string): TodoItem[] {
  const current = pickCurrentTodos(getSessionMessages(sessionId))
  return current ? current.data.todos : []
}

/**
 * 构造并写入一条「用户更新了任务清单」的 feedback 消息。
 * Tauri 下 persistMessagesIfNeeded() 有 isTauriAvailable() 守卫会跳过落库，故这里显式补落库；
 * 幂等（id 是主键，cmd_append_messages 是 upsert）。
 */
function appendTodoFeedbackMessage(
  sessionId: string,
  todos: TodoItem[],
  changes: TodoChange[],
): Message {
  const uiData: TodoUiData = {
    type: 'todo',
    todos,
    stats: computeStats(todos),
    source: 'user',
    changes,
  }
  const message: Message = {
    id: v4(),
    role: 'feedback',
    content: renderUserTodoContent(todos, changes),
    uiData,
    timestamp: Date.now(),
  }
  addSessionMessage(sessionId, message)
  if (isTauriAvailable()) {
    void invoke('cmd_append_messages', {
      sessionId,
      messages: [message],
    }).catch(() => {})
  }
  return message
}

/**
 * 落地草稿：把用户的清单**逐字**写成一条 feedback 消息（用户这份为准）。
 * @returns 是否真的产生了变更消息（改回原样 → false，不产生噪音消息）
 */
export function applyTodoDraft(
  sessionId: string,
  reason: TodoApplyReason,
): boolean {
  return applyTodoDraftMessages(sessionId, reason).length > 0
}

/**
 * 同 applyTodoDraft，但返回新写入的消息（轮次边界注入引擎本轮内存消息列表用）。
 */
export function applyTodoDraftMessages(
  sessionId: string,
  reason: TodoApplyReason,
): Message[] {
  const draft = getTodoDraft(sessionId)
  if (!draft) return []

  const latest = getEffectiveTodos(sessionId)
  // 用户这份**逐字生效**，不做字段级合并 ——「界面看到什么、落地就是什么」。
  // AI 编辑期间的改动由用户显式二选一，不静默回灌。
  const next = draft.todos.map((t) => ({ ...t }))
  const changes = diffTodos(latest, next)

  // 先清草稿再写消息：消息写入会触发 UI 重渲染，避免这一刻还看到旧草稿
  clearTodoDraft(sessionId)

  if (changes.length === 0) return []

  const message = appendTodoFeedbackMessage(sessionId, next, changes)

  track('todo.user_edit', {
    session_id: hashText(sessionId),
    reason,
    count: changes.length,
    total: next.length,
  })
  return [message]
}

/**
 * 落地「已应用」的草稿（轮次边界 / 本轮结束 / 取消）；未点「应用变更」的编辑不算修改，不自动落地。
 * @returns 是否真的产生了变更消息
 */
export function flushTodoDraft(
  sessionId: string,
  reason: Exclude<TodoApplyReason, 'user'>,
): boolean {
  return flushTodoDraftMessages(sessionId, reason).length > 0
}

/**
 * 同 flushTodoDraft，但返回要注入下一次 LLM 请求的消息列表（onRoundBoundary 钩子返回值）。
 */
export function flushTodoDraftMessages(
  sessionId: string,
  reason: Exclude<TodoApplyReason, 'user'>,
): Message[] {
  if (!isTodoDraftCommitted(sessionId)) return []
  return applyTodoDraftMessages(sessionId, reason)
}
