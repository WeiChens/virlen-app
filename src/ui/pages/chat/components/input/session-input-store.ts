/**
 * session-input-store — 每个 session 独立维护输入框状态（仅内存，不持久化）
 *
 * 保存/恢复：文本内容、光标位置、图片附件
 * 切换 session 时自动保存当前、恢复目标 session 的状态
 */

import type { ImageAttachment } from './hooks'

interface SessionInputState {
  value: string
  cursorPos: number
  images: ImageAttachment[]
}

const store = new Map<string, SessionInputState>()

/** 特殊 key 用于无会话（欢迎页） */
const NULL_SESSION = '__null__'

function mapKey(sessionId?: string | null): string {
  return sessionId ?? NULL_SESSION
}

export function saveSessionInput(
  sessionId: string | undefined | null,
  state: SessionInputState,
) {
  store.set(mapKey(sessionId), state)
}

export function getSessionInput(
  sessionId: string | undefined | null,
): SessionInputState | undefined {
  return store.get(mapKey(sessionId))
}

export function clearSessionInput(sessionId: string | undefined | null) {
  store.delete(mapKey(sessionId))
}
