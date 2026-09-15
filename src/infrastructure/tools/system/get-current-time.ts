/**
 * get_current_time — 获取当前时间（支持 IANA 时区参数）
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor } from '@/domain/tools/types'
import { t, getCurrentLanguage } from '@/ui/i18n'

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
