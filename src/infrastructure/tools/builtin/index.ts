/**
 * 内置 Tool 定义 — 基础工具集
 */
import { toolRegistry } from '@/domain/tools'
import {
  UserInteractionRequired,
  type ToolContext,
  type ToolExecutor,
  type ToolResult,
} from '@/domain/tools/types'
import { t, getCurrentLanguage } from '@/ui/i18n'

/**
 * 当前时间工具
 */
toolRegistry.register(
  {
    name: 'get_current_time',
    label: t('获取当前时间'),
    description: 'Get the current date and time.',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone (e.g. "Asia/Shanghai")',
          default: 'Asia/Shanghai',
        },
      },
      required: [],
    },
  },
  (async (args: Record<string, any>, _ctx: ToolContext): Promise<string> => {
    const now = new Date()
    return now.toLocaleString(
      getCurrentLanguage() === 'en-US' ? 'en-US' : 'zh-CN',
      {
        timeZone: args.timezone || 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'long',
      },
    )
  }) as ToolExecutor,
)

/**
 * 用户选择 — 让 AI 向用户提供选择（单选/多选）
 *
 * tool 执行时返回 UserInteractionRequired 信号，
 * engine 层收到后暂停 tool 循环等待用户在 UI 弹窗中做出选择。
 */
toolRegistry.register(
  {
    name: 'user_choice',
    label: t('用户选择'),
    description:
      'Present a choice to the user. The AI provides a question, a list of options, and whether single or multiple selection is allowed. ' +
      'A dialog will pop up for the user to answer. The result is returned after the user confirms.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of options for the user to choose from',
        },
        multi: {
          type: 'boolean',
          description:
            'Whether multiple selection is allowed. If false, single selection.',
          default: false,
        },
      },
      required: ['question', 'options'],
    },
  },
  (async (args: Record<string, any>, _ctx: ToolContext) => {
    // 返回交互信号，engine 层检查返回值处理
    return new UserInteractionRequired('user_choice', {
      question: args.question,
      options: args.options,
      multi: args.multi ?? false,
    })
  }) as ToolExecutor,
)
