/**
 * tool-service — 工具交互服务统一入口（抽象层）
 *
 * 为 chat-service 提供统一的工具交互调度接口，隐藏各 tool 的具体实现细节。
 * chat-service 只需调用 createToolHandles(sessionId)，不感知内部路由。
 *
 * 根据 type 分发给子模块：
 *   - user_choice      → user_choice.ts
 *   - confirm_command  → confirm_command.ts
 *
 * ⚠️ 一个 session 在一次 tool 循环中可能先后触发多种交互类型
 *   （如先 confirm_command 再 user_choice），因此不能只缓存一种 handler。
 */
import { createUserChoiceHandles } from './user_choice'
import type { UserChoiceHandles } from './user_choice'
import { createCommandConfirmHandles } from './command_confirm'
import type { CommandConfirmHandles } from './command_confirm'
import type { ToolExecutorResponse } from '@/domain/tools/types'
import { ToolService } from '../port/ToolService'

class ToolServiceImpl implements ToolService {
  async createToolHandles(sessionId: string): Promise<{
    handler: (
      type: string,
      data: Record<string, any>,
    ) => Promise<ToolExecutorResponse>
    cleanup: () => void
  }> {
    let userChoiceInner: UserChoiceHandles | null = null
    let commandConfirmInner: CommandConfirmHandles | null = null

    return {
      handler: async (type: string, data: Record<string, any>) => {
        if (type === 'user_choice') {
          if (!userChoiceInner) {
            userChoiceInner = createUserChoiceHandles(sessionId)
          }
          return userChoiceInner.handler(type, data)
        }
        if (type === 'confirm_command') {
          if (!commandConfirmInner) {
            commandConfirmInner = createCommandConfirmHandles(sessionId)
          }
          return commandConfirmInner.handler(type, data)
        }
        throw new Error(`未知的交互类型: ${type}`)
      },
      cleanup: () => {
        userChoiceInner?.cleanup()
        commandConfirmInner?.cleanup()
      },
    }
  }
}
export const toolService = new ToolServiceImpl()
