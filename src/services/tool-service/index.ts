/**
 * tool-service — 工具交互服务统一入口（抽象层）
 *
 * 为 chat-service 提供统一的工具交互调度接口，隐藏各 tool 的具体实现细节。
 * chat-service 只需调用 createToolHandles(sessionId)，不感知内部路由。
 *
 * 根据 type 分发给子模块：
 *   - user_choice          → user_choice.ts
 *   - confirm_command      → confirm_command.ts
 *   - sandbox_rule_check   → 本文件内联（内部查询，不弹窗，无 UI）
 *
 * ⚠️ 一个 session 在一次 tool 循环中可能先后触发多种交互类型
 *   （如先 confirm_command 再 user_choice），因此不能只缓存一种 handler。
 *
 * ⚠️ `sandbox_rule_check` 与其它类型不同：它**不是用户交互**，而是 Rust 原生
 *   `execute_command` / `execute_script` 在执行前问一句「这条命令命中「忽略沙盒命令」
 *   规则了吗」（命中的命令要以「不使用沙盒」方式执行）。因此它必须：
 *   1. **完全不碰 UI**（不弹窗、不写 pending 状态）；
 *   2. 应答为 JSON 字符串 `{"matched":bool,"ruleName":string|null}`（Rust 侧解析）。
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
import { securityService } from '../security-service'

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
        if (type === 'sandbox_rule_check') {
          // 内部查询（Rust 原生执行路径）：命令是否命中「忽略沙盒命令」规则。
          // 不弹窗、不缓存 handler —— 纯读规则表后原样回传判定。
          // ⚠️ 任何异常都必须回「未命中」（fail-closed：宁可走沙盒，也不静默放行）。
          try {
            const hit = await securityService.matchSandboxIgnoreRule(
              String(data?.command ?? ''),
            )
            return JSON.stringify({
              matched: !!hit,
              ruleName: hit?.name ?? null,
            })
          } catch {
            return JSON.stringify({ matched: false, ruleName: null })
          }
        }
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
