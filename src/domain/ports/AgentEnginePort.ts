import { SendMessageOptions } from '@/domain/engine'
import { RunSnapshot } from '../engine/types'
import { Message, Session } from '@/types'

export interface AgentEnginePort {
  /**
   * 发送消息并获取回复
   */
  sendMessage(options: SendMessageOptions): Promise<void>
  /**
   * 获取当前会话的运行快照
   * @param sessionId
   */
  getRunSnapshot(sessionId: string): Promise<RunSnapshot>
  clearRunSnapshot(sessionId: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  compressContext(
    session: Session,
    allMessages: Message[],
  ): Promise<{ summary?: string; messages: Message[] }>
}
