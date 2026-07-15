import { ToolHandles } from '../tool-service/types'

export interface ToolService {
  /**
   * 创建工具交互 handles — chat-service 的唯一入口
   * @param sessionId
   */
  createToolHandles(sessionId: string): Promise<ToolHandles>
}
