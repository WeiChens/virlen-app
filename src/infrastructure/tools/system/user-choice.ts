/**
 * user_choice — 让 AI 向用户提供选择（单选/多选）
 *
 * tool 执行时返回 UserInteractionRequired 信号，
 * engine 层收到后暂停 tool 循环等待用户在 UI 弹窗中做出选择。
 */
import { toolRegistry } from '@/domain/tools'
import {
  UserInteractionRequired,
  type ToolContext,
  type ToolExecutor,
} from '@/domain/tools/types'
import { t } from '@/ui/i18n'

toolRegistry.register(
    'user_choice',
    (async (args: Record<string, any>, _ctx: ToolContext) => {
    // 返回交互信号，engine 层检查返回值处理
    return new UserInteractionRequired('user_choice', {
      question: args.question,
      options: args.options,
      multi: args.multi ?? false,
    })
  }) as ToolExecutor,
    t('用户选择'),
)
