/**
 * tool-service — 工具交互服务统一入口（抽象层）。
 *
 * chat-service 只调 createToolHandles(sessionId)，内部按 type 路由到子模块（user_choice / confirm_command）。
 * 一个 session 的一次 tool 循环可能先后触发多种交互，故按类型各缓存一个 handler。
 */
import { createUserChoiceHandles } from './user_choice'
import type { UserChoiceHandles } from './user_choice'
import {
  createCommandConfirmHandles,
  createNativeCommandConfirmHandles,
} from './command_confirm'
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
    let nativeCommandConfirmInner: CommandConfirmHandles | null = null

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
        if (type === 'confirm_command_native') {
          // Rust 原生 execute_command 的审批（命令由 Rust 执行）
          if (!nativeCommandConfirmInner) {
            nativeCommandConfirmInner = createNativeCommandConfirmHandles(sessionId)
          }
          return nativeCommandConfirmInner.handler(type, data)
        }
        throw new Error(`未知的交互类型: ${type}`)
      },
      cleanup: () => {
        userChoiceInner?.cleanup()
        commandConfirmInner?.cleanup()
        nativeCommandConfirmInner?.cleanup()
      },
    }
  }
}
export const toolService = new ToolServiceImpl()
