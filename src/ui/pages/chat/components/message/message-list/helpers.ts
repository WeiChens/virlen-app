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
