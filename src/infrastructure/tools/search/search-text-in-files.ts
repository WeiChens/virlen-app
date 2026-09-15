/**
 * search_text_in_files — 按内容搜索（支持正则，自动跳过二进制文件并遵循 .gitignore）
 *
 * 底层使用 Rust 的 ripgrep 核心库，通过 Tauri invoke 调用。
 */
import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolContext, ToolResult } from '@/domain/tools/types'
import { createSearchTask, resolveSearchRoot } from './common'

interface TextSearchResult {
  path: string
  line_number: number
  line: string
}

toolRegistry.register(
  {
    name: 'search_text_in_files',
    label: '搜索关键字',
    description:
      'Search for text content inside files recursively. **Supports regex patterns.** ' +
      'Returns file path, line number, and the matching line content. ' +
      'Automatically skips binary files and respects .gitignore. ' +
      'Use this to find function definitions, variable usages, error messages, TODO comments, etc.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Root directory to search in (e.g. "./src").',
          default: '.',
        },
        query: {
          type: 'string',
          description:
            'Text or regex pattern to search for in file contents. Supports full regex syntax (e.g. "function\\s+\\w+" for function definitions, "TODO|FIXME" for TODOs).',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results. Default: 30.',
          default: 30,
        },
      },
      required: ['query'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    // 参数校验：query 为必填
    if (!args.query) {
      return {
        content:
          'Missing required parameter: "query". Please provide a text or regex pattern to search for.',
        uiData: { length: 0 },
      }
    }

    const { taskId, stop } = createSearchTask('search_text', ctx.abortSignal)
    let cancelled = false

    const results = await withCancelResult(
      ctx.abortSignal,
      invoke<TextSearchResult[]>('search_text_in_files', {
        root: await resolveSearchRoot(args.path, ctx.sessionId),
        query: args.query,
        maxResults: args.max_results ?? 30,
        taskId,
      }),
      () => {
        cancelled = true
        stop()
        return [] as TextSearchResult[]
      },
    )

    if (cancelled) {
      throw `[Search cancelled] Search for "${args.query}" was cancelled.`
    }

    // 防御：invoke 可能返回 null/undefined，统一转为数组
    const safeResults: TextSearchResult[] = results ?? []

    const MAX_CHARS = 32000
    let output = `🔍 ${safeResults.length} match(es) for "${args.query}":\n`

    for (const r of safeResults) {
      const line = `  📄 ${r.path}:${r.line_number}  ${r.line.trim()}`
      if (output.length + line.length + 1 > MAX_CHARS) {
        output += `\n... (truncated, ${safeResults.length} total matches)`
        break
      }
      output += line + '\n'
    }

    return {
      content: output,
      uiData: {
        length: safeResults.length,
      },
    }
  }) as ToolExecutor,
)
