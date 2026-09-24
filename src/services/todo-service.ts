/**
 * todo-service — 任务清单落地（本模块是 todo 相关**唯一有副作用的地方**）
 *
 * 数据流：
 *   模型写入 → todo_write 工具 → tool_result 消息（content 给模型 / uiData 给 UI）
 *   用户编辑 → 草稿（ui/store/todoDraftStore，纯内存）
 *            → 落地时**逐字生效**（不做字段级合并）
 *            → **追加一条 role='feedback' 的消息**（模型下一轮天然可见）
 *
 * 「编辑的同时 AI 也在改」怎么办：**不自动合并**。用户编辑期间 AI 又写了一版清单时，
 * 编辑器提示「AI 已更新」，并把两个出口摆明：
 * - 「放弃编辑并同步」→ 丢弃用户编辑，跟随 AI 最新；
 * - 「覆盖更新」→ 用户这份**整体覆盖** AI 的更新（下面 `applyTodoDraftMessages`）。
 * 宁可让用户显式选一次，也不做那种「界面看到的是一份、落地却变成另一份」的隐式合并。
 *
 * 为什么用「追加 feedback 消息」而不是原地改历史清单消息：
 * - 消息是唯一权威载体，追加即可表达「用户改过了」，无需引入第二份状态；
 * - `session_db` 只提供 `cmd_append_messages` / 整会话替换，没有「更新单条消息」
 *   的 IPC（原地改会让内存与 SQLite 不一致）；
 * - feedback 角色被三个 Provider 统一映射成 user（`openai.ts` / `anthropic.ts` /
 *   `gemini.ts`，Rust 侧 `provider/openai.rs` 同样），模型能看到；
 * - UI 侧把它渲染成一行「你更新了任务清单」胶囊（`message-bubble.tsx`）。
 *
 * 落地时机（调用方）：
 * - **轮次边界**（工具回复后、下一次 LLM 请求前）→ `flushTodoDraftMessages(reason: 'round_boundary')`：
 *   消息直接进本轮消息列表，模型**这一轮**就能看到用户改动（TS 引擎走 `onRoundBoundary`
 *   回调；Rust 引擎走 `agent:round-boundary` 桥）
 * - AI 空闲时用户点「应用变更」→ `applyTodoDraft(reason: 'user')`，立即落地
 * - AI 回复中用户点「应用变更」→ 只 `markTodoDraftCommitted()`，等轮次边界 / 本轮结束再落地
 * - 兜底：本轮结束（`stream_end` 非 paused）/ 用户取消 → `flushTodoDraft()`
 *   （纯文本回复的轮次没有「下一次请求」，只能靠这个兜底）
 * - ⚠️ **paused（等用户交互弹窗）不落地**：本轮并未真正结束，草稿留到恢复后合并
 *
 * ⚠️ 只落地「已应用」的草稿：用户还在编辑（没点「应用变更」）的改动不算修改。
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
import { isRustEngineEnabled } from '@/services/rust-engine'
import {
  clearTodoDraft,
  getTodoDraft,
  isTodoDraftCommitted,
} from '@/ui/store/todoDraftStore'

/** 草稿落地的原因（仅用于埋点与日志） */
export type TodoApplyReason = 'user' | 'round_boundary' | 'stream_end' | 'cancel'

/**
 * 当前生效的清单（消息历史派生）。
 * UI 也可以直接用 `pickCurrentTodos(sessionStore...messages)`，这里只是包一层。
 */
export function getEffectiveTodos(sessionId: string): TodoItem[] {
  const current = pickCurrentTodos(getSessionMessages(sessionId))
  return current ? current.data.todos : []
}

/**
 * 构造并写入一条「用户更新了任务清单」的 feedback 消息。
 *
 * ⚠️ Rust 引擎路径下 `persistMessagesIfNeeded()` 有 `!isRustEngineEnabled()` 守卫
 * 会跳过落库（它假设消息由引擎内部直落），所以这里必须显式补落库 ——
 * 幂等：`messages.id` 是主键，`cmd_append_messages` 是 upsert。
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
  if (isRustEngineEnabled()) {
    void invoke('cmd_append_messages', {
      sessionId,
      messages: [message],
    }).catch(() => {})
  }
  return message
}

/**
 * 落地草稿：把用户的清单**逐字**写成一条 feedback 消息（用户这份为准）。
 *
 * 调用方：
 * - AI 空闲时用户点「应用变更 / 覆盖更新」→ 直接调用（`reason: 'user'`）
 * - 轮次边界 / 本轮结束 / 取消 → 走 `flushTodoDraft` / `flushTodoDraftMessages`
 *   （只落地已应用的草稿）
 *
 * @returns 是否真的产生了变更消息（用户改完又改回原样 → false，不产生噪音消息）
 */
export function applyTodoDraft(
  sessionId: string,
  reason: TodoApplyReason,
): boolean {
  return applyTodoDraftMessages(sessionId, reason).length > 0
}

/**
 * 同 `applyTodoDraft`，但把新写入的消息**返回给调用方**。
 *
 * 轮次边界注入靠的就是这个返回值：消息既要进 UI/库（`addSessionMessage` 内部已做），
 * 也要进**引擎本轮的内存消息列表**，下一次 LLM 请求才能看到。
 */
export function applyTodoDraftMessages(
  sessionId: string,
  reason: TodoApplyReason,
): Message[] {
  const draft = getTodoDraft(sessionId)
  if (!draft) return []

  const latest = getEffectiveTodos(sessionId)
  // 用户这份**逐字生效**：不做字段级合并 ——
  // 「界面看到什么、落地就是什么」。AI 在自己编辑期间做的改动由用户显式二选一
  //（放弃编辑并同步 / 覆盖更新），不静默回灌。
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
 * 落地「已应用」的草稿（轮次边界 / 本轮结束 / 取消）。
 *
 * 用户还在编辑（没点「应用变更」）的改动不算修改，不会被自动落地。
 *
 * @returns 是否真的产生了变更消息
 */
export function flushTodoDraft(
  sessionId: string,
  reason: Exclude<TodoApplyReason, 'user'>,
): boolean {
  return flushTodoDraftMessages(sessionId, reason).length > 0
}

/**
 * 同 `flushTodoDraft`，但返回要注入下一次 LLM 请求的消息列表
 * （轮次边界钩子的返回值，见 `SendMessageOptions.onRoundBoundary`）。
 */
export function flushTodoDraftMessages(
  sessionId: string,
  reason: Exclude<TodoApplyReason, 'user'>,
): Message[] {
  if (!isTodoDraftCommitted(sessionId)) return []
  return applyTodoDraftMessages(sessionId, reason)
}
