import { ToolExecutorResponse } from '@/domain/tools/types'

export interface ToolHandles {
  /** 给 agentEngine.sendMessage 的 onUserInteraction 回调 */
  handler: (
    type: string,
    data: Record<string, any>,
  ) => Promise<ToolExecutorResponse>
  /** 交互结束后清理资源 */
  cleanup: () => void
}
