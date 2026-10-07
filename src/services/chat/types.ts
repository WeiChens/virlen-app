/** chat-service 的对外回调事件契约（供 event-handler 与 flow 共用，避免互相 import 成环）。 */

export interface ChatServiceEvents {
  /** 会话工作状态变更 */
  onWorkingChange?: (sessionId: string, working: boolean) => void
  /** 迭代验证状态变更（开始/结束验证时触发） */
  onVerifyingChange?: (sessionId: string, verifying: boolean) => void
  /** 会话消息更新 */
  onMessagesUpdate?: (sessionId: string) => void
  /** 错误 */
  onError?: (sessionId: string, error: string) => void
  /** 流式内容累积 */
  onPendingContent?: (sessionId: string, delta: string) => void
  /** 流式结束 */
  onStreamEnd?: (sessionId: string) => void
}
