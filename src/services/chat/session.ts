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
  sessionRuntimeState,
  getSessionRuntime,
  updateSessionRuntime,
  isSessionRunActive,
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

/**
 * 重命名会话（唯一入口）：`trim()` 后为空 → 不改（返回 false）；超长 → 截断；
 * 会话不存在 / **已归档** → false。
 *
 * 归档会话只允许「取消归档」与「删除」，其它写操作一律拒绝（见 `setSessionArchived`）。
 */
export function renameSession(sessionId: string, title: string): boolean {
  const session = sessionStore.getSession(sessionId)
  if (!session || session.archived) return false
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
 * 会话不存在 / **已归档** → false（归档会话只允许取消归档与删除）。
 */
export function setSessionPinned(sessionId: string, pinned: boolean): boolean {
  const session = sessionStore.getSession(sessionId)
  if (!session || session.archived) return false
  if (!!session.pinned === !!pinned) return true // 目标态已达成：幂等空操作
  sessionStore.toggleSessionPin(sessionId)
  return true
}

/**
 * 归档 / 取消归档（唯一入口，接目标态）。
 *
 * 归档只改标记：不删消息、不断运行、不刷 `updatedAt`（它只由用户发消息刷新）。
 * **有 run 在跑（含暂停等你回答）的会话拒绝归档**：归档会把它从视图里摘掉，那条交互就永远
 * 没人答得上了。取消归档不受此限（恢复动作永远允许）。
 * **归档后的会话只允许取消归档与删除**，其余操作在各自入口拒绝：
 *   - 打开：侧栏 `handleSelect` + `chat-view.handleSelectSession` 校验 `archived`；
 *   - 重命名 / 置顶：本文件拒绝；
 *   - 导出 / 导入知识库等面板操作：侧栏右键菜单不给入口。
 * `activateSession` 故意不拦：它同时被手机订阅复用，拦掉会变成「订阅成功但消息永远空白」。
 */
export function setSessionArchived(
  sessionId: string,
  archived: boolean,
): boolean {
  if (!sessionStore.getSession(sessionId)) return false
  if (archived && isArchiveBlocked(sessionId)) return false
  sessionStore.setSessionsArchived([sessionId], archived)
  return true
}

/**
 * 批量归档 / 取消归档（分组「全部归档」用）：@returns 实际改动条数
 *
 * 归档方向**跳过** run 还活着的会话（一条在跑不该让整组归档全失败）；
 * 取消归档不过滤 —— 恢复动作永远允许。跳过条数由 `countArchiveBlockedSessions` 取，
 * ⚠️ 两处口径必须一致，否则提示的条数和实际改动对不上。
 */
export function setSessionsArchived(
  sessionIds: string[],
  archived: boolean,
): number {
  const targets = archived
    ? sessionIds.filter((id) => !isArchiveBlocked(id))
    : sessionIds
  return sessionStore.setSessionsArchived(targets, archived)
}

/** 这批会话里有多少条会被「运行中」挡住归档（侧栏提示跳过条数用） */
export function countArchiveBlockedSessions(sessionIds: string[]): number {
  return sessionIds.filter(isArchiveBlocked).length
}

/**
 * 该会话当前是否禁止归档：run 还活着（在跑 / 本地前置准备 / 暂停等回答）。
 * 会话不存在、或从没跑过（无运行时条目）都不算挡住 —— 写入侧会自己返回 false。
 * 不直接用 `getSessionRuntime`：它会**建**空条目，批量统计时白开一堆内存。
 */
function isArchiveBlocked(sessionId: string): boolean {
  if (!sessionStore.getSession(sessionId)) return false
  const rt = sessionRuntimeState.value.sessions[sessionId]
  return !!rt && isSessionRunActive(rt)
}
