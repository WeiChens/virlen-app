/**
 * message-list 纯辅助函数（无组件状态，「传参进、结果出」）
 */
import type { Message } from '@/types'
import { getSessionRuntime } from '@/ui/store'

/** 从消息内容中提取纯文本摘要（截断长度与后端预览保持一致：420 字符） */
export function previewOfMessage(msg: Message): string {
  const text =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((b) => b.type === 'text')
          .map((b) => ('text' in b ? b.text : ''))
          .join('')
  return text.slice(0, 420)
}

/**
 * 会话是否正在「流式输出」中。
 *
 * 流式期间 assistant 气泡的高度随 token 持续增长，任何「等待布局稳定」的逻辑
 * 都永远等不到稳定（等待用户交互而暂停的会话不算：此时没有新内容，高度静止）。
 */
export function isStreamingSession(sessionId: string): boolean {
  const rt = getSessionRuntime(sessionId)
  return rt.working && !rt.paused
}

/**
 * 把「检索命中点」解析成一个**可定位的消息 id**。
 *
 * tool 消息（role='tool'）在列表中不渲染气泡 —— 工具结果挂在发起该调用的
 * assistant 气泡下方的工具卡片里（见 message-bubble 的 ToolCallGroup），
 * 它自己那一行高度为 0。若直接跳 tool 消息，会落在一条看不见的空行上。
 * 因此命中 tool 消息时，改为定位到「发起该 tool_call 的 assistant 消息」
 * （工具结果排在调用之后，所以往前找宿主，取最近的一个）。
 *
 * 返回 null 表示：命中了 tool 消息，但宿主 assistant 还没回补到内存
 *（在更早的分页里）—— 调用方应继续 loadOlder，而不是停在那条零高度行上。
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
