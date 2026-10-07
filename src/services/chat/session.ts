/**
 * chat/session — 会话激活（**数据侧**）的唯一入口。
 *
 * 把「进入会话的数据准备」抽出来，供桌面 chat-view 与手机控制接口层（bridge/）共用；
 * 否则手机切入会话时消息列表会是空的。
 *
 * 只做数据侧，不碰 UI：不写 chatState.currentSessionId（手机有自己的视角游标），
 * 不同步 React 镜像 state（setMessages，那只有 chat-view 组件自己能做）。
 *
 * ⚠️ 新增「进入会话要做的事」只加在这里，不要在组件另起一份 —— 两份必然分叉。
 * M4：会话写操作用例（renameSession / setSessionPinned）也落这里，接口层（手机）不得直调 store 裸 action。
 */
import {
  sessionStore,
  getSessionRuntime,
  updateSessionRuntime,
} from '@/ui/store'
import type { Session } from '@/types'
import { repairSessionIfNeeded } from './repair'

/**
 * 激活会话：① 清除新回复标记 → ② 懒加载消息（SQLite → store，仅首次）
 * → ③ 修复中断残留（悬空 tool_calls，须在消息加载后）→ ④ 异步加载全量用户消息索引（右锚点用）。
 * @returns 加载后的会话；会话不存在返回 null（调用方据此不切）。
 */
export async function activateSession(
  sessionId: string,
): Promise<Session | null> {
  const session = sessionStore.getSession(sessionId)
  if (!session) return null

  // 进入会话 → 清除新回复标记（托盘唤起 / 检索跳转 / 手机推送 等入口一并覆盖）
  updateSessionRuntime(sessionId, { hasNewReply: false })

  // 懒加载：会话激活时从 SQLite 拉取历史消息（仅首次）
  await sessionStore.ensureMessagesLoaded(sessionId)

  // 消息到位后再检测中断残留（悬空 tool_calls）—— 消息没加载完时拿到的是空列表
  const rt = getSessionRuntime(sessionId)
  repairSessionIfNeeded(sessionId, rt.working || rt.paused)

  // 锚点列表需要「全量用户消息」：只拉 id + 摘要（不含 AI/工具正文，体积小）
  void sessionStore.ensureUserMessageIndex(sessionId)

  return sessionStore.getSession(sessionId) ?? session
}

/**
 * 会话标题上限。侧栏与手机列表都是单行省略渲染，超长不影响正确性；
 * 限长仅为避免不合理体积入库、脏数据干扰搜索排序。手机是第二输入源，不能指望其输入框限长。
 */
export const MAX_SESSION_TITLE_LEN = 80

/** 重命名会话（唯一入口）：`trim()` 后为空 → 不改（返回 false）；超长 → 截断；会话不存在 → false。 */
export function renameSession(sessionId: string, title: string): boolean {
  const trimmed = (title ?? '').trim()
  if (!trimmed) return false
  const next =
    trimmed.length > MAX_SESSION_TITLE_LEN
      ? trimmed.slice(0, MAX_SESSION_TITLE_LEN)
      : trimmed
  return sessionStore.updateSessionTitle(sessionId, next) !== null
}

/**
 * 置顶 / 取消置顶（唯一入口）。接**目标态**而非切换：手机拿到的列表可能过期，切换会把状态翻反。
 */
export function setSessionPinned(sessionId: string, pinned: boolean): boolean {
  const session = sessionStore.getSession(sessionId)
  if (!session) return false
  if (!!session.pinned === !!pinned) return true // 目标态已达成：幂等空操作
  sessionStore.toggleSessionPin(sessionId)
  return true
}
