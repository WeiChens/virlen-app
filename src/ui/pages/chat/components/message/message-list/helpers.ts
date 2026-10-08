/** message-list 纯辅助函数（无组件状态，「传参进、结果出」）。 */
import type { Message } from '@/types'
import { getSessionRuntime } from '@/ui/store'
import { sliceHead } from '@/utils/text'

/** 从消息内容中提取纯文本摘要（截断长度与后端预览保持一致：420 字符） */
export function previewOfMessage(msg: Message): string {
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((b) => b.type === 'text')
          .map((b) => ('text' in b ? b.text : ''))
          .join('')
  return sliceHead(text, 420)
}

/**
 * 会话是否正在「流式输出」中（暂停等待用户交互的不算：那时没有新内容，高度静止）。
 * 流式期间 assistant 气泡高度持续增长，任何「等布局稳定」的逻辑都永远等不到稳定。
 */
export function isStreamingSession(sessionId: string): boolean {
  const rt = getSessionRuntime(sessionId)
  return rt.working && !rt.paused
}

/**
 * 把「检索命中点」解析成一个**可定位的消息 id**。tool 消息在列表里不渲染气泡（工具结果挂在发起该调用的
 * assistant 气泡下方的卡片里，自己那行高度为 0），直接跳会落在看不见的空行上 → 命中 tool 消息时改为
 * 定位到「发起该 tool_call 的 assistant 消息」（结果排在调用之后，故往前找最近的宿主）。
 *
 * 返回 null：命中了 tool 消息但宿主还没回补到内存（在更早的分页里）—— 调用方应继续 loadOlder。
 */
export function resolveJumpAnchorId(
  list: Message[],
  msgId: string,
): string | null {
  const index = list.findIndex((m) => m.id === msgId)
  // 本次尚未加载到该消息：无法判断角色，原样返回交给调用方继续回补
  if (index < 0) return msgId
  const target = list[index]
  if (target.role !== 'tool' || !target.toolCallId) return msgId
  for (let i = index - 1; i >= 0; i--) {
    const m = list[i]
    if (
      m.role === 'assistant' &&
      m.toolCalls?.some((tc) => tc.id === target.toolCallId)
    ) {
      return m.id
    }
  }
  return null
}

/**
 * 在消息窗口里找「可定位的跳转目标」：命中返回最终要定位的消息 id，否则 `null`。
 *
 * 与 `resolveJumpAnchorId` 的分工：那个只做「tool → 宿主 assistant」的解析（消息不在窗口里时
 * 原样返回 id，即「还没加载到」），本函数把「到底在不在窗口里」补上 —— 回补循环要的判据正是
 * 这个：`tool` 消息自身零高度、且宿主可能还在更早的分页里，两者都已加载才算命中。
 */
export function findJumpTarget(list: Message[], msgId: string): string | null {
  const resolved = resolveJumpAnchorId(list, msgId)
  if (!resolved || !list.some((m) => m.id === resolved)) return null
  return resolved
}

/**
 * 视口里「正在读的那条用户消息」= **已经进入视口的最后一条**用户消息（`null` = 一条用户消息都没有）。
 *
 * 为什么不取「离视口顶部最近的」：视口里同时有两条用户消息时（上一条已滚过顶部、下一条刚露头），
 * 离顶部探针近的往往是**上面那条** —— 高亮就落在已经读过的旧提问上。按「可见的最后一条」判定，
 * 两条都可见时指向下面那条（当前正在读的）；只有一条可见时结论与旧口径一致。
 *
 * @param messages 已加载消息（会话顺序）
 * @param topOf 该条消息在内容坐标系里的顶部（未测量的条目给 `undefined`，跳过）
 * @param viewportBottom 视口底边在内容坐标系里的位置（`scrollTop + clientHeight`）
 */
export function pickActiveAnchorUser(
  messages: readonly Message[],
  topOf: (messageIndex: number) => number | undefined,
  viewportBottom: number,
): string | null {
  let active: string | null = null
  let firstUserId: string | null = null
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue
    if (firstUserId === null) firstUserId = messages[i].id
    const top = topOf(i)
    if (top === undefined) continue
    // 顶部偏移随顺序单调递增：一旦落到视口底边之下，后面的只会更靠下
    if (top > viewportBottom) break
    active = messages[i].id
  }
  // 视口整体停在第一条用户消息之上（一条都没进入视口）→ 仍指向第一条，避免高亮整个消失
  return active ?? firstUserId
}
