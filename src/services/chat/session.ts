/**
 * chat/session — 会话激活（**数据侧**）的唯一入口
 *
 * 把「进入某个会话时需要做的数据准备」从组件里抽出来，供两个调用方共用：
 *  1. `ui/pages/chat/chat-view.tsx` 的用户点击 / 托盘唤起路径；
 *  2. 手机控制接口层（`bridge/`，见 `docs/phone-control-bridge.md`）——
 *     手机推送「我切到会话 X」时，电脑侧要做完全相同的数据准备，
 *     否则它的消息列表会是空的（同样的问题在 `tray-service.ts` 的注释里已经踩过一次）。
 *
 * 本函数**只做数据侧**，不碰任何 UI 状态：
 *  - 不写 `chatState.currentSessionId` —— 手机有自己的视角游标，不抢桌面的屏（拍板决策 §8-①）；
 *  - 不同步 React 镜像 state（`setMessages`）—— 那只有 `chat-view` 组件自己能做。
 *
 * ⚠️ 新增「进入会话要做的事」时**只加在这里**，不要在组件里另起一份 —— 两份必然分叉。
 *
 * M4 追加：会话的**写操作用例**也落在这里（`renameSession` / `setSessionPinned`）——
 * 接口层（手机）**不得直调 store 裸 action**，否则「空标题 / 超长标题」这类用例级校验
 * 只在某一个调用方存在，两端行为必然漂移（§3 原则）。
 */
import {
  sessionStore,
  getSessionRuntime,
  updateSessionRuntime,
} from '@/ui/store'
import type { Session } from '@/types'
import { repairSessionIfNeeded } from './repair'

/**
 * 激活会话：完成数据侧准备。
 *
 * 做四件事（顺序有意义）：
 *  1. 清除「新回复」标记 —— 「激活」的产品语义就是「用户看到了」；
 *  2. 懒加载消息（SQLite → store，仅首次）；
 *  3. 修复中断残留（悬空 `tool_calls`）—— 必须在消息加载完之后，否则拿到的是空列表；
 *  4. 加载全量用户消息索引（右侧锚点用，只拉 id + 摘要，不 await）。
 *
 * @returns 加载完成后的会话对象；会话不存在返回 `null`（调用方据此不切）
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
 * 会话标题长度上限。
 *
 * 侧栏与手机列表都是**单行省略**渲染，超长标题不影响正确性；限长是为了避免把
 * 不合理的体积写进库、以及侧栏搜索/排序被脏数据干扰。手机是**第二个输入源**，
 * 不能指望它的输入框长度限制。
 */
export const MAX_SESSION_TITLE_LEN = 80

/**
 * 重命名会话（唯一入口）。
 *
 * 行为：`trim()` 后为空 → **不改**（返回 false）；超长 → 截断；会话不存在 → false。
 * 与侧栏旧行为一致（侧栏原本就地写了同一句 `if (editTitle.trim())`，现已改调本函数）。
 */
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
 * 置顶 / 取消置顶（唯一入口）。
 *
 * 注意与侧栏的区别：侧栏是「切换」（不知道也不关心当前值），这里接的是**目标态**——
 * 手机端只能表达目标态（它拿到的列表可能已过期，用切换会把状态翻反）。
 * 两者最终落在同一个 store action 上，幂等由本函数保证。
 */
export function setSessionPinned(sessionId: string, pinned: boolean): boolean {
  const session = sessionStore.getSession(sessionId)
  if (!session) return false
  if (!!session.pinned === !!pinned) return true // 目标态已达成：幂等空操作
  sessionStore.toggleSessionPin(sessionId)
  return true
}
