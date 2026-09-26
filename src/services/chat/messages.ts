/**
 * 会话消息 CRUD（原 chat-service 内联，合并自 messages.ts）
 *
 * 全部操作作用于 sessionStore 的内存消息列表，并按宿主决定是否由本层落库：
 * - Tauri（有 Rust 后端）：引擎内部直落 SQLite，本层跳过（见 persistMessagesIfNeeded 的守卫）
 * - 非 Tauri（vitest）：本层负责调用 cmd_append_messages 等命令落库（invoke 为桩）
 */
import { runInAction } from 'mobx'
import { sessionStore } from '@/ui/store'
import { v4 } from '@/utils/uuid'
import type { Message } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import { isTauriAvailable } from '@/services/rust-engine'
import { sanitizeLoneSurrogates } from '@/utils/text'

/**
 * TS 引擎路径消息落库（Tauri 下由引擎内部直落 SQLite，跳过）。
 * fire-and-forget：不 await，落库不阻塞 UI。
 */
export function persistMessagesIfNeeded(
  sessionId: string,
  messages: Message[],
): void {
  if (isTauriAvailable()) return
  if (!messages.length) return
  try {
    // 兜底：孤立代理（半个 emoji）经 JSON.stringify → Rust serde_json 会报
    // "unexpected end of hex escape"；命中时才复制，未命中零开销
    void invoke('cmd_append_messages', {
      sessionId,
      messages: sanitizeLoneSurrogates(messages),
    }).catch(() => {})
  } catch {
    // 非 Tauri 环境忽略
  }
}

/** 直接改写会话内存消息（不触碰分页状态，区别于 replaceSessionMessages） */
export function setSessionMessagesInPlace(
  sessionId: string,
  messages: Message[],
): void {
  runInAction(() => {
    const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
    if (!session) return
    session.messages = messages
    // 消息修复（悬空 tool_calls 补占位）不是用户发言，不刷新会话时间
    sessionStore.messagesChanged(sessionId)
  })
}

export function addSessionMessage(
  sessionId: string,
  message: Message,
): Message | null {
  let added: Message | null = null
  runInAction(() => {
    const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const session = sessionStore.value.sessions[idx]
    const existing = message.toolCallId
      ? session.messages.find((m) => m.toolCallId === message.toolCallId)
      : undefined
    if (existing) {
      if (existing.role === 'tool' && message.role === 'tool') {
        const msgs = [...session.messages]
        const msgIdx = msgs.findIndex((m) => m.id === existing.id)
        msgs[msgIdx] = { ...message, id: existing.id }
        session.messages = msgs
        sessionStore.messagesChanged(sessionId)
        added = msgs[msgIdx]
      }
      return
    }
    session.messages = [...session.messages, message]
    // 不刷新 session.updatedAt：这里是所有消息（含 AI 回复、工具结果）的通用入口，
    // 会话时间只由「用户发送消息」刷新（见 sessionStore.touchSession）。
    sessionStore.messagesChanged(sessionId)
    added = message
  })
  // TS 引擎路径：新增/更新的消息立即落库（Rust 引擎路径由引擎内部直落）
  if (added) persistMessagesIfNeeded(sessionId, [added])
  return added
}

export function updateSessionMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<Message>,
): Message | null {
  return runInAction(() => {
    const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return null
    const session = sessionStore.value.sessions[idx]
    const msgIdx = session.messages.findIndex((m) => m.id === messageId)
    if (msgIdx === -1) return null
    const msgs = [...session.messages]
    msgs[msgIdx] = { ...msgs[msgIdx], ...patch }
    session.messages = msgs
    sessionStore.messagesChanged(sessionId)
    return msgs[msgIdx]
  })
}

export function getSessionMessages(sessionId: string): Message[] {
  const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
  return session ? [...session.messages] : []
}

/**
 * 按 id 取单条消息（不复制整表）
 *
 * 用于流式增量拼接：每个增量补丁都要读一次「当前正文」，
 * 走 getSessionMessages 会把整个消息列表复制一遍（高频路径上无必要）。
 */
export function getSessionMessage(
  sessionId: string,
  messageId: string,
): Message | undefined {
  const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
  return session?.messages.find((m) => m.id === messageId)
}

/**
 * 删除指定消息及其之后的所有消息（不支持删除 tool 消息）
 */
export function deleteSessionMessage(
  sessionId: string,
  messageId: string,
): boolean {
  return runInAction(() => {
    const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
    if (!session) return false

    const msgIdx = session.messages.findIndex((m) => m.id === messageId)
    if (msgIdx === -1) return false

    // 不允许手动删除 tool 消息
    if (session.messages[msgIdx].role === 'tool') return false

    // 删除该消息及之后所有消息
    const removed = session.messages.slice(msgIdx)
    session.messages = session.messages.slice(0, msgIdx)
    // 同步「全量用户消息索引」：剔除本次被删掉的用户消息，
    // 否则右侧锚点列表会残留已删除用户消息的圆点
    // （索引为一次性拉取的缓存，不会随 messages 变化自动更新）。
    sessionStore.dropUserMessagesFromIndex(
      sessionId,
      removed.filter((m) => m.role === 'user').map((m) => m.id),
    )
    // 落库：从 SQLite 删除该消息及其之后的所有消息，使内存与 DB 保持一致。
    // 注意 messagesChanged 只触发会话元数据落库（cmd_upsert_session 不写 messages 表），
    // 必须显式调用截断命令，否则重启后已删除消息会从 DB「复活」。
    // fire-and-forget：失败不阻塞 UI，非 Tauri 环境静默忽略。
    try {
      void invoke('cmd_truncate_session_messages', {
        sessionId,
        messageId,
      }).catch(() => {})
    } catch {
      // 非 Tauri 环境忽略
    }
    sessionStore.messagesChanged(sessionId)
    return true
  })
}

export function clearSessionMessages(sessionId: string): boolean {
  // 清空消息后用户消息索引也应整体清空，否则右侧锚点列表会残留全部圆点
  const prevRefs = sessionStore.getUserMessageIndex(sessionId)
  const ok = runInAction(() => {
    const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return false
    const sessions = [...sessionStore.value.sessions]
    sessions[idx] = {
      ...sessions[idx],
      messages: [],
    }
    sessionStore.value.sessions = sessions
    sessionStore.dropUserMessagesFromIndex(
      sessionId,
      prevRefs.map((r) => r.id),
    )
    // 落库：清空 SQLite 中该会话的全部消息（复用整批替换命令，传空列表）。
    // 同样不能只靠 messagesChanged（只写会话元数据）。
    try {
      void invoke('cmd_replace_session_messages', {
        sessionId,
        messages: [],
      }).catch(() => {})
    } catch {
      // 非 Tauri 环境忽略
    }
    sessionStore.messagesChanged(sessionId)
    return true
  })
  if (ok) sessionStore.markMessagesFullyLoaded(sessionId)
  return ok
}

/**
 * 原子替换整个会话的消息列表（用于上下文压缩等场景）
 */
export function replaceSessionMessages(
  sessionId: string,
  messages: Message[],
): boolean {
  // 压缩会丢弃部分历史（含用户消息）：同步剔除索引中已不存在的用户消息，
  // 否则右侧锚点列表会残留已被压缩掉的圆点。
  // messages 为完整历史（调用方已 ensureAllMessagesLoaded），故「不在新列表中的
  // 索引项」即为被压缩掉的消息。
  const keepIds = new Set(messages.map((m) => m.id))
  const staleIds = sessionStore
    .getUserMessageIndex(sessionId)
    .filter((r) => !keepIds.has(r.id))
    .map((r) => r.id)

  const ok = runInAction(() => {
    const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
    if (!session) return false
    session.messages = messages
    sessionStore.dropUserMessagesFromIndex(sessionId, staleIds)
    sessionStore.messagesChanged(sessionId)
    return true
  })
  // 整体替换后内存即完整历史，同步分页状态（否则上滚会重复回补）
  if (ok) sessionStore.markMessagesFullyLoaded(sessionId)
  return ok
}
