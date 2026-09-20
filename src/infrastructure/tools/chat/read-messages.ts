/**
 * read_messages — 按消息 id + 相对窗口读取「已被上下文压缩掉」的历史消息正文
 *
 * 与 list_messages 同源（同一 Rust 查询），只是定位方式不同：
 * 给定锚点（id 优先，可用 seq）与相对窗口 [-10,0] / [0,10] / [-5,5]，
 * 返回该窗口内各条消息的正文。
 *
 * 约束（需求硬性）：
 *   - 只覆盖「已压缩区间」；触及边界即停止，并提示后续内容已在上下文中；
 *   - 深度思考（reasoning）永不返回；
 *   - 工具调用只给「工具名 + 参数摘要」，参数与工具结果均截断到 ≈100 字符；
 *   - 单条正文 ≤ 4000 字符、单次窗口 ≤ 21 条、单次输出 ≤ 30000 字符。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import { t } from '@/ui/i18n'
import { track, hashText } from '@/utils/telemetry'
import {
  WINDOW_DEFAULT_SPAN,
  WINDOW_MAX_BACK,
  WINDOW_MAX_FWD,
  capOutput,
  consumeBudget,
  formatWindow,
} from './common'

const DESCRIPTION = [
  'Read the full text of earlier messages that have been COMPRESSED AWAY (they are no',
  'longer in your current context). Only messages before the compression summary can be',
  'read; anything still in your context is NOT returned.',
  '',
  'Provide message_id (obtained from list_messages) and a relative window:',
  '  [-10, 0] = the anchor and the 10 messages before it;',
  '  [0, 10]  = the anchor and the 10 messages after it;',
  `  [-5, 5]  = 5 before and 5 after (default).`,
  'If message_id (and seq) are omitted, the newest readable message is used as the anchor.',
  '',
  'Limits: at most 21 messages per call, each message text <= 4000 chars, each tool-call',
  'detail <= 100 chars. Deep-thinking (reasoning) content is never returned. Do not call',
  'this repeatedly to dump the whole history.',
].join(' ')

toolRegistry.register(
  {
    name: 'read_messages',
    label: t('读取历史消息'),
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description:
            'Anchor message ID (from list_messages). Preferred over seq.',
        },
        seq: {
          type: 'number',
          description:
            'Anchor message sequence number, used when message_id is not provided.',
        },
        window: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Relative window [start, end] around the anchor, with start <= 0 <= end. ' +
            'Examples: [-10,0] (10 before), [0,10] (10 after), [-5,5] (default).',
          default: [-WINDOW_DEFAULT_SPAN, WINDOW_DEFAULT_SPAN],
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

    const anchorId =
      typeof args.message_id === 'string' && args.message_id.trim()
        ? args.message_id.trim()
        : undefined
    const anchorSeq = toPositiveInt(args.seq)
    const { before, after } = parseWindow(args.window)

    const started = Date.now()
    let win
    try {
      win = await sessionRepo.getMessageWindow(sessionId, {
        anchorId,
        anchorSeq,
        before,
        after,
      })
    } catch {
      win = null
    }

    if (!win) {
      track('chat.messages.query', {
        mode: 'window',
        status: 'unavailable',
        duration_ms: Date.now() - started,
      })
      return {
        content:
          'Message history is unavailable in this environment (local storage not accessible).',
      }
    }

    if (win.total === 0) {
      return { content: 'This conversation has no messages yet.' }
    }

    if (win.boundarySeq === null) {
      track('chat.messages.query', {
        mode: 'window',
        status: 'not_compressed',
        duration_ms: Date.now() - started,
      })
      return {
        content:
          'This conversation has not been compressed yet, so the full history is already ' +
          'in your current context. There is nothing to read here.',
        uiData: { mode: 'window', status: 'not_compressed', total: win.total },
      }
    }

    if (!win.anchorFound) {
      return {
        content:
          `Message "${anchorId ?? anchorSeq}" was not found in this conversation. ` +
          'It may have been deleted. Use list_messages to get valid message IDs.',
        uiData: { mode: 'window', status: 'not_found', total: win.total },
      }
    }

    if (win.messages.length === 0) {
      // 锚点落在「已在上下文」的区间（压缩摘要及其之后）
      return {
        content:
          `#${win.anchorSeq} and everything after it are already in your current context — ` +
          `no need to read them. The readable (compressed) range is #1..#${win.boundarySeq - 1}.`,
        uiData: {
          mode: 'window',
          status: 'in_context',
          anchorSeq: win.anchorSeq,
          boundarySeq: win.boundarySeq,
          total: win.total,
        },
      }
    }

    const { text, truncated } = capOutput(formatWindow(win))
    if (!consumeBudget(sessionId, text.length)) {
      track('chat.messages.query', {
        mode: 'window',
        status: 'budget_exceeded',
        msg_count: win.messages.length,
        duration_ms: Date.now() - started,
      })
      return {
        content:
          '[Message-query budget exceeded. Stop querying history and answer with the ' +
          'information you already have.]',
      }
    }

    track('chat.messages.query', {
      mode: 'window',
      status: 'success',
      msg_count: win.messages.length,
      chars: text.length,
      truncated,
      clamped_by_boundary: win.clampedByBoundary,
      duration_ms: Date.now() - started,
      session_id: hashText(sessionId),
    })

    return {
      content: text,
      uiData: {
        mode: 'window',
        status: 'success',
        total: win.total,
        anchorSeq: win.anchorSeq,
        startSeq: win.startSeq,
        endSeq: win.endSeq,
        boundarySeq: win.boundarySeq,
        clampedByBoundary: win.clampedByBoundary,
        messages: win.messages,
      },
    }
  }) as ToolExecutor,
)

/**
 * 解析相对窗口 `[start, end]`（要求 start <= 0 <= end），并收敛到单侧上限。
 * 非法输入回退到默认 `[-5, 5]`。
 */
function parseWindow(raw: any): { before: number; after: number } {
  if (Array.isArray(raw) && raw.length === 2) {
    const start = Number(raw[0])
    const end = Number(raw[1])
    if (Number.isFinite(start) && Number.isFinite(end) && start <= 0 && end >= 0) {
      return {
        before: Math.min(Math.floor(-start), WINDOW_MAX_BACK),
        after: Math.min(Math.floor(end), WINDOW_MAX_FWD),
      }
    }
  }
  return { before: WINDOW_DEFAULT_SPAN, after: WINDOW_DEFAULT_SPAN }
}

/** 正整数参数（非法返回 undefined） */
function toPositiveInt(raw: any): number | undefined {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}
