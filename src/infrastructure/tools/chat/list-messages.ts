/**
 * list_messages — 列出「已被上下文压缩掉」的历史消息时序
 *
 * 只覆盖「已压缩区间」（时序 < 最后一个 summary）：该区间之后的对话已在模型当前
 * 上下文中，重复下发只会浪费 token —— 因此这里**不返回**当下可见的消息。
 *
 * AI 用它拿到时序 + 消息 id（或按关键词定位），再用 read_messages 读取正文。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import { t } from '@/ui/i18n'
import { track, hashText } from '@/utils/telemetry'
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  capOutput,
  consumeBudget,
  formatTimeline,
} from './common'

const DESCRIPTION = [
  'List the timeline of messages that have been COMPRESSED AWAY in this conversation,',
  'i.e. earlier messages that are no longer present in your current context because the',
  'conversation was summarized. Messages that are still in your context are NOT returned —',
  'do not use this tool to re-read what you already have.',
  '',
  'Each entry gives: sequence number (#seq), message ID, role, timestamp, a short preview',
  '(<= 100 chars) and the names of any tools the message called. Deep-thinking (reasoning)',
  'content is never exposed.',
  '',
  'Use it to: (1) discover the message ID of an earlier message and then read it with',
  'read_messages; (2) find earlier messages by keyword. The newest page of the queryable',
  'range is returned first; to page further back, call again with the returned cursor.',
].join(' ')

toolRegistry.register(
  {
    name: 'list_messages',
    label: t('列出历史消息'),
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        cursor: {
          type: 'number',
          description:
            'Page cursor: only return messages with sequence before this value. ' +
            'Omit it to get the newest page of the queryable range.',
        },
        keyword: {
          type: 'string',
          description:
            'Optional keyword filter applied to the message plain text. ' +
            'Only messages in the queryable (compressed) range are searched.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of messages per page. Default: ${LIST_DEFAULT_LIMIT}, Max: ${LIST_MAX_LIMIT}.`,
          default: LIST_DEFAULT_LIMIT,
        },
      },
      required: [],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const sessionId = ctx.sessionId
    if (!sessionId) {
      return { content: 'No active conversation is available.' }
    }

    const keyword =
      typeof args.keyword === 'string' && args.keyword.trim()
        ? args.keyword.trim()
        : undefined
    const cursor = toPositiveInt(args.cursor)
    const limit = clampLimit(args.limit)

    const started = Date.now()
    let page
    try {
      page = await sessionRepo.getMessageTimeline(sessionId, {
        keyword,
        beforeSeq: cursor,
        limit,
      })
    } catch {
      page = null
    }

    if (!page) {
      track('chat.messages.query', {
        mode: 'list',
        status: 'unavailable',
        duration_ms: Date.now() - started,
      })
      return {
        content:
          'Message history is unavailable in this environment (local storage not accessible).',
      }
    }

    if (page.total === 0) {
      return { content: 'This conversation has no messages yet.' }
    }

    if (page.boundarySeq === null) {
      // 会话从未压缩 → 全部对话都在模型上下文里，没有「被压缩掉」的历史
      track('chat.messages.query', {
        mode: 'list',
        status: 'not_compressed',
        duration_ms: Date.now() - started,
      })
      return {
        content:
          'This conversation has not been compressed yet, so the full history is already ' +
          'in your current context. There is nothing to look up here.',
        uiData: { mode: 'list', status: 'not_compressed', total: page.total },
      }
    }

    if (page.items.length === 0) {
      return {
        content: keyword
          ? `No queryable message matches "${keyword}". Queryable range: #1..#${page.boundarySeq - 1}.`
          : 'No more older messages in the queryable range.',
        uiData: { mode: 'list', status: 'empty', total: page.total },
      }
    }

    const { text, truncated } = capOutput(formatTimeline(page))
    if (!consumeBudget(sessionId, text.length)) {
      track('chat.messages.query', {
        mode: 'list',
        status: 'budget_exceeded',
        msg_count: page.items.length,
        duration_ms: Date.now() - started,
      })
      return {
        content:
          '[Message-query budget exceeded. Stop querying history and answer with the ' +
          'information you already have.]',
      }
    }

    track('chat.messages.query', {
      mode: 'list',
      status: 'success',
      msg_count: page.items.length,
      chars: text.length,
      truncated,
      has_keyword: !!keyword,
      duration_ms: Date.now() - started,
      session_id: hashText(sessionId),
    })

    return {
      content: text,
      uiData: {
        mode: 'list',
        status: 'success',
        total: page.total,
        boundarySeq: page.boundarySeq,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        keyword: keyword ?? null,
        items: page.items,
      },
    }
  }) as ToolExecutor,
)

/** limit 收敛到 [1, LIST_MAX_LIMIT] */
function clampLimit(raw: any): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return LIST_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(n), 1), LIST_MAX_LIMIT)
}

/** 正整数参数（非法返回 undefined） */
function toPositiveInt(raw: any): number | undefined {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}
