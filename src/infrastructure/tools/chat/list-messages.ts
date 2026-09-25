/**
 * list_messages — 列出「已被上下文压缩掉」的历史消息时序
 *
 * 只覆盖「已压缩区间」（时序 < 最后一个 summary）：该区间之后的对话已在模型当前
 * 上下文中，重复下发只会浪费 token —— 因此这里**不返回**当下可见的消息。
 *
 * AI 用它拿到时序 + 消息 id（或按关键词定位），再用 read_messages 读取正文。
 *
 * ⚠️ 已原生化（Step 2）：Rust 引擎走 `native_tools/chat/list_messages.rs`（默认路径），
 * 本文件只服务 **TS 引擎**（回退路径）；文本格式化 / 上限 / 预算在
 * `tools/chat/common.ts` ↔ `native_tools/chat/common.rs` 两份镜像，改一边要同步另一边（铁律 1）。
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

// 工具描述已收敛到权威源（机制 C）：src-tauri/src/agent/tool_defs/definitions.json

toolRegistry.register(
    'list_messages',
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
    t('列出历史消息'),
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
