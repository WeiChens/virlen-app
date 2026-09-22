/**
 * search_files_by_name — 按文件名搜索
 *
 * 底层使用 Rust 的 ripgrep 核心库，性能远优于纯 JS 实现。通过 Tauri invoke 调用。
 *
 * 支持三种匹配模式：
 *   1. 纯文本（默认）：大小写不敏感子串匹配
 *   2. 正则（use_regex=true）：完整的正则表达式匹配
 *   3. Glob 模式（glob=true）：通配符匹配，如 "**\/*.ts"、"*.json"
 *      底层自动将 glob 转换为正则后由 Rust 引擎执行。
 */
import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolContext, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { createSearchTask, globToRegex, resolveSearchRoot } from './common'

interface FileSearchResult {
  path: string
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

    const { taskId, stop } = createSearchTask('search_files', ctx.abortSignal)
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

    const results: FileSearchResult[] = await withCancelResult(
      ctx.abortSignal,
      invoke<FileSearchResult[]>('search_files_by_name', {
        root: await resolveSearchRoot(args.path, ctx.sessionId),
        query: effectiveQuery,
        useRegex: effectiveUseRegex,
        maxResults: args.max_results ?? 30,
        taskId,
        // 遍历范围三个参数固定为「不剪枝」——保持工具原有行为（含隐藏项、不跳依赖目录），
        // 与 Rust 原生实现（native_tools/search/search_files_by_name.rs）逐字对齐。
        // 「默认跳过 node_modules 等目录」只是侧边栏搜索框的取舍，不作用于模型工具。
        includeHidden: true,
        skipDirNames: [],
        keepDirs: [],
      }),
      () => {
        cancelled = true
        stop()
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
