/**
 * 搜索工具 — 文件名搜索 + 文件内容搜索
 *
 * 底层使用 Rust 的 ripgrep 核心库，性能远优于纯 JS 实现。
 * 通过 Tauri invoke 调用。
 *
 * search_files_by_name 支持三种匹配模式：
 *   1. 纯文本（默认）：大小写不敏感子串匹配
 *   2. 正则（use_regex=true）：完整的正则表达式匹配
 *   3. Glob 模式（glob=true）：通配符匹配，如 "**\/*.ts"、"*.json"
 *      底层自动将 glob 转换为正则后由 Rust 引擎执行。
 */
import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import type {
  ToolExecutor,
  ToolContext,
  ToolResult,
} from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { securityService } from '@/services/security-service'
import { toolRegistry } from '@/domain/tools'

interface FileSearchResult {
  path: string
}

interface TextSearchResult {
  path: string
  line_number: number
  line: string
}

/**
 * 将 Glob 模式转换为正则表达式
 *
 * 支持的语法：
 *   - `*`   匹配单层路径中的任意字符（不含 `/`）
 *   - `**`  匹配任意层级路径
 *   - `?`   匹配单层路径中的单个字符（不含 `/`）
 *   - `{a,b}` 备选模式（匹配 a 或 b）
 *   其他特殊字符自动转义
 */
function globToRegex(pattern: string): string {
  if (!pattern) return '^$'
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      // ** 匹配所有层级
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
      } else {
        const opts = pattern.slice(i + 1, end).split(',')
        re +=
          '(' +
          opts.map((o) => o.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') +
          ')'
        i = end
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c
    } else {
      re += c
    }
    i++
  }
  return '^' + re + '$'
}

toolRegistry.register(
  {
    name: 'search_files_by_name',
    label: t('文件名搜索'),
    description:
      'Search for files by filename. Supports plain text (case-insensitive substring match), ' +
      'regex matching (use_regex=true), or glob patterns (glob=true, e.g. "**/*.ts", "*.json", "src/**/*.css"). ' +
      'Returns a list of matching file paths.',
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
            'Filename pattern. Plain text (case-insensitive) by default, regex if use_regex=true, ' +
            'glob pattern if glob=true (e.g. "**/*.ts", "*.json", "src/**/*.css").',
        },
        use_regex: {
          type: 'boolean',
          description: 'Whether query is a regex pattern. Default: false.',
          default: false,
        },
        glob: {
          type: 'boolean',
          description:
            'Whether query is a glob pattern (e.g. "**/*.ts", "*.json"). ' +
            'When true, overrides use_regex — converts glob to regex automatically. Default: false.',
          default: false,
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
          'Missing required parameter: "query". Please provide a filename pattern to search for.',
        uiData: { length: 0, items: [] },
      }
    }

    const taskId = `search_files_${crypto.randomUUID()}`
    let cancelled = false

    // 确定实际使用的查询内容和是否为正则模式
    let effectiveQuery = args.query
    let effectiveUseRegex = args.use_regex ?? false

    // glob 模式优先：将 glob 转换为正则，由 Rust 引擎执行
    // 当 glob=true 时忽略 use_regex（glob 转换后本身就是正则）
    if (args.glob) {
      effectiveQuery = globToRegex(args.query)
      effectiveUseRegex = true
    }

    // abortSignal 触发时同时告诉 Rust 端停止
    const onAbort = () => {
      invoke('stop_task', { taskId }).catch(() => {})
    }
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

    const results: FileSearchResult[] = await withCancelResult(
      ctx.abortSignal,
      invoke<FileSearchResult[]>('search_files_by_name', {
        root: await securityService.resolveSafePath(
          args.path || '.',
          'r',
          ctx.sessionId,
        ),
        query: effectiveQuery,
        useRegex: effectiveUseRegex,
        maxResults: args.max_results ?? 30,
        taskId,
      }),
      () => {
        cancelled = true
        invoke('stop_task', { taskId }).catch(() => {})
        return [] as FileSearchResult[]
      },
    )

    if (cancelled) {
      throw `[Search cancelled] Search for "${args.query}" was cancelled.`
    }

    // 防御：invoke 可能返回 null/undefined，统一转为数组
    const safeResults: FileSearchResult[] = results ?? []

    if (safeResults.length === 0) {
      return {
        content: `No files matching "${args.query}" found in ${args.path ?? '.'}.`,
        uiData: {
          length: 0,
          items: [],
        },
      }
    }

    return {
      content:
        `🔍 ${safeResults.length} file(s) matching "${args.query}":\n` +
        safeResults.map((r) => `  📄 ${r.path}`).join('\n'),
      uiData: {
        length: safeResults.length,
        items: safeResults.map((r) => r.path),
      },
    }
  }) as ToolExecutor,
)

toolRegistry.register(
  {
    name: 'search_text_in_files',
    label: t('搜索关键字'),
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

    const taskId = `search_text_${crypto.randomUUID()}`
    let cancelled = false

    const onAbort = () => {
      invoke('stop_task', { taskId }).catch(() => {})
    }
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

    const results = await withCancelResult(
      ctx.abortSignal,
      invoke<TextSearchResult[]>('search_text_in_files', {
        root: await securityService.resolveSafePath(
          args.path || '.',
          'r',
          ctx.sessionId,
        ),
        query: args.query,
        maxResults: args.max_results ?? 30,
        taskId,
      }),
      () => {
        cancelled = true
        invoke('stop_task', { taskId }).catch(() => {})
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
