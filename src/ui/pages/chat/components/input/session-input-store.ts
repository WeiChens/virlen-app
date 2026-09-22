/**
 * session-input-store — 每个 session 独立维护输入框状态（仅内存，不持久化）
 *
 * 保存/恢复：文本内容、光标位置、图片附件、文件附件、引用消息、技能引用、迭代目标
 * 切换 session 时自动保存当前、恢复目标 session 的状态
 */

import type {
  FileAttachment,
  ImageAttachment,
  QuoteAttachment,
  SkillAttachment,
} from './hooks'

interface SessionInputState {
  value: string
  cursorPos: number
  images: ImageAttachment[]
  /** 文件附件（只存路径） */
  files: FileAttachment[]
  /** 引用消息（只存 id + 发送方 + 正文快照） */
  quotes: QuoteAttachment[]
  /** 技能引用（技能名 + 目录 + SKILL.md 全文快照） */
  skills: SkillAttachment[]
  /** 迭代目标（Goal） */
  goal: string
  /** 迭代模式是否展开 */
  goalExpanded: boolean
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
