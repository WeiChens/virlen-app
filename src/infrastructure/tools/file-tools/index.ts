import { invoke } from '@tauri-apps/api/core'
import { withCancelResult } from '@/utils/withCancel'
import { computeDiff, countDiffRows } from '@/utils/diff'
import { t, tpl } from '@/ui/i18n'

/**
 * 文件系统工具集 — 文件读写、目录遍历、搜索等
 *
 * 使用 Tauri v2 的 @tauri-apps/plugin-fs API 操作文件系统。
 * 所有操作限定在应用数据目录或指定的安全范围内。
 */

import * as tauriFs from '@tauri-apps/plugin-fs'
import { securityService } from '@/services/security-service'
import { toolRegistry } from '@/domain/tools'
import {
  ToolContext,
  ToolExecutor,
  ToolExecutorResponse,
  ToolResult,
} from '@/domain/tools/types'

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

// ==================== 工具注册 ====================

/** Rust read_file 返回类型 */
interface FileReadResult {
  content: string
  hash10: string
  line_count: number
  byte_size: number
}

/** Rust edit_file_multi 单次编辑结果 */
interface SingleEditResult {
  replaced_count: number
  old_start_line: number
  old_string_context: string
  new_string_context: string
}

/** Rust edit_file_multi 返回类型 */
interface FileEditMultiResult {
  hash10: string
  line_count: number
  edits: SingleEditResult[]
}

toolRegistry.register(
  {
    name: 'read_file',
    label: t('读取文件'),
    description:
      'Read a file\'s content. Returns content, line count, size, and hash10 (short fingerprint) (for edit_file conflict detection). ' +
      'Pass "paths" (array) to read multiple files in one call — avoids N round-trips for N files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path (relative to workspace or absolute). Use this for a single file.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of file paths to read in one call. Use this to batch-read multiple files efficiently.',
        },
        start_line: {
          type: 'number',
          description:
            'Starting line number (1-indexed). Use this to read a specific section of a large file. ' +
            'When set, returns at most max_lines lines starting from this line. Default: 1.',
          default: 1,
        },
        max_lines: {
          type: 'number',
          description:
            'Max lines to read. Default is 2000. When start_line is used, this limits how many lines are returned.',
          default: 2000,
        },
        max_line_chars: {
          type: 'number',
          description:
            'Max characters per line. Default is 1600. ' +
            'Prevents token explosion from single very long lines ' +
            '(minified JS/CSS, long JSON/base64, etc.). Lines longer than this ' +
            'are truncated with a marker so the AI knows content is incomplete.',
          default: 1600,
        },
      },
      oneOf: [{ required: ['path'] }, { required: ['paths'] }],
      required: [],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const maxLines = +(args.max_lines as number) || 2000
    const maxLineChars = +(args.max_line_chars as number) || 2000
    const startLine = Math.max(0, +(args.start_line as number) || 1)

    // 读取单个文件的核心逻辑（供 paths 批量复用）
    async function readSingleFile(
      rawPath: string,
    ): Promise<{ content: string; uiData: any }> {
      const fullPath = await securityService.resolveSafePath(
        rawPath,
        'r',
        ctx.sessionId,
      )
      const result: FileReadResult = await withCancelResult(
        ctx.abortSignal,
        invoke('read_file_with_hash', { path: fullPath }),
        () =>
          ({
            content: '',
            hash10: '',
            line_count: 0,
            byte_size: 0,
          }) as FileReadResult,
      )

      if (!result.hash10) {
        throw '[Cancelled] File read was cancelled.'
      }

      const lines = result.content.split('\n')
      const totalLines = lines.length
      const startIdx = Math.max(0, startLine - 1)

      const slice: string[] = []
      let truncatedLineCount = 0

      for (let i = startIdx; i < totalLines && slice.length < maxLines; i++) {
        const line = lines[i]
        if (line.length > maxLineChars) {
          const omitted = line.length - maxLineChars
          slice.push(
            `${line.slice(0, maxLineChars)} … [已截断，省略 ${omitted} 字符]`,
          )
          truncatedLineCount++
        } else {
          slice.push(line)
        }
      }

      const displayStart = startIdx + 1
      const displayEnd = startIdx + slice.length
      const remainingLines = Math.max(0, totalLines - displayEnd)

      const headerLines = [
        `📄 ${fullPath}`,
        tpl('📝 $__lines__ 行 / $__size__', {
          lines: totalLines,
          size: formatSize(result.byte_size),
        }),
        `🔑 hash10: ${result.hash10}`,
        startLine > 1
          ? tpl('🔢 显示: 第 $__start__-$__end__ 行 (共 $__total__ 行)', {
              start: displayStart,
              end: displayEnd,
              total: totalLines,
            })
          : tpl('🔢 显示: 第 1-$__end__ 行 (共 $__total__ 行)', {
              end: displayEnd,
              total: totalLines,
            }),
      ]

      if (truncatedLineCount > 0) {
        headerLines.push(
          tpl(
            '💡 提示: 有 $__count__ 行内容过长，已按每行 $__max__ 字符截断。可增大 max_line_chars 参数读取更多内容',
            { count: truncatedLineCount, max: maxLineChars },
          ),
        )
      }
      if (startIdx > 0) {
        headerLines.push(
          tpl('💡 提示: 使用 start_line=$__line__ 读取后续内容', {
            line: displayEnd + 1,
          }),
        )
      }
      if (remainingLines > 0) {
        headerLines.push(
          tpl(
            '💡 提示: 文件内容未完整显示，剩余 $__remaining__ 行。使用 start_line=$__next__ 读取后续内容',
            { remaining: remainingLines, next: displayEnd + 1 },
          ),
        )
      }

      const displayedContent = slice.join('\n')
      return {
        content: headerLines.join('\n') + '\n\n' + displayedContent,
        uiData: {
          content: displayedContent,
          hash10: result.hash10,
          line_count: result.line_count,
          byte_size: result.byte_size,
          fullPath,
          startLine: displayStart,
          endLine: displayEnd,
        },
      }
    }

    try {
      // 支持 paths 数组（批量读取多个文件）
      const paths: string[] = Array.isArray(args.paths)
        ? (args.paths as any[]).filter(
            (p): p is string => typeof p === 'string' && p.trim() !== '',
          )
        : []

      if (paths.length > 0) {
        const results: { content: string; uiData: any }[] = []
        const errors: string[] = []

        for (const p of paths) {
          try {
            const r = await readSingleFile(p)
            results.push(r)
          } catch (e: any) {
            errors.push(`${p} — ${e.message || String(e)}`)
          }
        }

        if (results.length === 0 && errors.length > 0) {
          throw errors.join('\n')
        }

        // 文件之间用分隔线隔开
        const parts = results.map((r, i) =>
          i === 0 ? r.content : '\n---\n' + r.content,
        )
        if (errors.length > 0) {
          parts.push(
            `\n\n⚠️ 有 ${errors.length} 个文件读取失败:\n` +
              errors.map((e) => `  - ${e}`).join('\n'),
          )
        }

        const uiData =
          results.length === 1
            ? results[0].uiData // 单文件 → 保持原有 uiData 结构
            : { files: results.map((r) => r.uiData) }

        return {
          content: parts.join('\n'),
          uiData,
        }
      }

      // 单文件路径（向后兼容）
      const path = args.path as string
      if (!path) {
        throw t('错误：请提供 "path" 或 "paths" 参数')
      }
      const r = await readSingleFile(path)
      return { content: r.content, uiData: r.uiData }
    } catch (e: any) {
      throw tpl('错误：读取文件失败 — $__error__', {
        error: e.message || String(e),
      })
    }
  }) as ToolExecutor,
)

toolRegistry.register(
  {
    name: 'edit_file',
    label: t('编辑文件'),
    description:
      'Replace exact text in a file. Requires expected_hash10 from read_file (conflict detection). Prefer for partial edits over write_file. ' +
      'Use the "edits" array to apply one or more edits in a single call — each edit is { old_string, new_string, replace_count }.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (relative to workspace or absolute).',
        },
        edits: {
          type: 'array',
          description:
            'Array of edits to apply sequentially in one file. Each item: { old_string, new_string, replace_count }. ' +
            'All edits share the same expected_hash10 and are applied in order on the same content. ' +
            'Use this instead of multiple edit_file calls to avoid hash conflicts between edits.',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description:
                  'The exact existing text to replace. Include enough surrounding context for a unique match.',
              },
              new_string: {
                type: 'string',
                description: 'The new text to insert in place of old_string.',
              },
              replace_count: {
                type: 'number',
                description:
                  'How many occurrences of old_string to replace. Default: 1. Set to 0 to replace all.',
                default: 1,
              },
            },
            required: ['old_string', 'new_string'],
          },
        },
        expected_hash: {
          type: 'string',
          description:
            'The hash10 value of the current file content, obtained from read_file output. ' +
            'Used for conflict detection to ensure no one modified the file since you read it.',
        },
      },
      required: ['path', 'edits', 'expected_hash'],
    },
  },
  (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolExecutorResponse> => {
    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'w',
      ctx.sessionId,
    )
    const expectedHash = args.expected_hash as string

    const edits = Array.isArray(args.edits) ? args.edits : []
    if (edits.length === 0) {
      throw t('错误：请提供 "edits" 参数（至少一项编辑）')
    }

    // 规范化 edits 参数：每个 edit 的 replace_count 默认 1，0 表示全部
    // （Rust 端会把 0 当作 usize::MAX，与单编辑时代的 999999 哨兵等价）
    const normalizedEdits = edits.map((e: any, i: number) => {
      const oldString = (e.old_string ?? '').toString()
      const newString = (e.new_string ?? '').toString()
      const replaceCount = (e.replace_count as number) ?? 1
      if (!oldString) {
        throw tpl('错误：第 $__n__ 处编辑的 old_string 不能为空', {
          n: i + 1,
        })
      }
      return {
        old_string: oldString,
        new_string: newString,
        replace_count: replaceCount,
      }
    })

    try {
      const result: FileEditMultiResult = await withCancelResult(
        ctx.abortSignal,
        invoke('edit_file_multi_in_place', {
          path: fullPath,
          edits: normalizedEdits,
          expectedHash,
        }),
        () => {
          throw new Error('[Cancelled] File edit was cancelled.')
        },
      )

      // 为每个编辑计算 diff
      const uiEdits = result.edits.map((e: SingleEditResult) => {
        const oldLineCount = e.old_string_context.split('\n').length
        const newLineCount = e.new_string_context.split('\n').length
        const diffRows = computeDiff(
          e.old_string_context.split('\n'),
          e.new_string_context.split('\n'),
          e.old_start_line,
        )
        const { delCount, insCount } = countDiffRows(diffRows)
        return {
          oldStartLine: e.old_start_line,
          oldEndLine: e.old_start_line + oldLineCount - 1,
          newEndLine: e.old_start_line + newLineCount - 1,
          oldString: e.old_string_context,
          newString: e.new_string_context,
          replacedCount: e.replaced_count,
          diffRows,
          delCount,
          insCount,
        }
      })

      const totalReplaced = result.edits.reduce(
        (sum, e) => sum + e.replaced_count,
        0,
      )
      const totalDel = uiEdits.reduce((s, e) => s + e.delCount, 0)
      const totalIns = uiEdits.reduce((s, e) => s + e.insCount, 0)

      return {
        content:
          tpl('✅ 已编辑文件: $__path__', { path: fullPath }) +
          '\n' +
          `  - ${tpl('编辑 $__count__ 处（共替换 $__replaced__ 次）', {
            count: result.edits.length,
            replaced: totalReplaced,
          })}\n` +
          `  - ${tpl('减少 $__del__行,新增 $__ins__行', {
            del: totalDel,
            ins: totalIns,
          })}\n` +
          `  - ${tpl('共 $__count__ 行', { count: result.line_count })}\n` +
          `  - hash10: ${result.hash10}`,
        uiData: {
          fullPath,
          hash10: result.hash10,
          edits: uiEdits,
        },
      }
    } catch (e: any) {
      const msg = e.message || String(e)
      if (
        msg.includes('old_string not found') ||
        msg.includes('appears') ||
        msg.includes('Conflict') ||
        msg.includes('Cannot read')
      ) {
        throw tpl('错误：编辑失败 — $__msg__', { msg })
      }
      throw tpl('错误：编辑文件失败 — $__msg__', { msg })
    }
  }) as ToolExecutor,
)

/**
 * 计算内容归一化（LF-only）后的 hash10（SHA-256 前 10 位），与 Rust 端 compute_hash10 一致
 */
async function computeContentHash10(content: string): Promise<string> {
  // 归一化：\r\n → \n，与 Rust 端 normalize_content 保持一致
  const normalized = content.replace(/\r\n/g, '\n')
  const encoder = new TextEncoder()
  const data = encoder.encode(normalized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const full = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  // 截断为前 10 位 hex，与 Rust 端 compute_hash10 对齐
  return full.slice(0, 10)
}

toolRegistry.register(
  {
    name: 'write_file',
    label: t('写入文件'),
    description:
      'Write content to a file (full overwrite). Creates parent directories if they do not exist. ' +
      '⚠️ Use edit_file for partial modifications instead of reading and re-writing entire files. ' +
      'Returns the hash10 (short fingerprint) of the written content (normalized to LF), which can be used ' +
      'as expected_hash for subsequent edit_file calls.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (relative to workspace or absolute).',
        },
        content: { type: 'string', description: 'Content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    if (!tauriFs) throw t('[write_file] 错误：当前不是 Tauri 环境')

    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'w',
      ctx.sessionId,
    )
    const content = args.content as string
    try {
      // 创建父目录（兼容 Windows 反斜杠路径）
      const normalizedPath = fullPath.replace(/\\/g, '/')
      const parent = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'))
      if (parent) {
        await tauriFs.mkdir(parent, { recursive: true }).catch(() => {})
      }
      const existed = await tauriFs.exists(fullPath).catch(() => false)
      await tauriFs.writeTextFile(fullPath, content)

      // 计算归一化内容的 hash10，与 read_file/edit_file 一致
      const hash10 = await computeContentHash10(content)
      const lineCount = content.replace(/\r\n/g, '\n').split('\n').length
      const size = formatSize(new TextEncoder().encode(content).length)

      const returnContent = existed
        ? tpl('✅ 已覆写文件 ($__size__): $__path__', {
            size,
            path: fullPath,
          })
        : tpl('✅ 已创建文件 ($__size__): $__path__', {
            size,
            path: fullPath,
          })

      return {
        uiData: {
          hash10,
          fullPath,
          lineCount,
          byteSize: new TextEncoder().encode(content).length,
        },
        content: returnContent + `\n🔑 hash10: ${hash10}`,
      }
    } catch (e: any) {
      throw tpl('错误：写入文件失败 — $__error__', {
        error: e.message || String(e),
      })
    }
  }) as ToolExecutor,
)

/** Rust 返回的目录条目（结构化协议，无 magic string 冲突风险） */
type DirEntryType = 'file' | 'dir' | 'enter_dir' | 'leave_dir'

interface RustDirEntry {
  name: string
  type: DirEntryType
  size?: number | null
}

// ==================== Tool 注册 ====================

toolRegistry.register(
  {
    name: 'list_files',
    label: '列出文件',
    description:
      'List files and directories in a given path. Shows relative paths from the given root.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path. Default: workspace root.',
          default: '.',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively. Default: false',
          default: false,
        },
        includeHidden: {
          type: 'boolean',
          description: 'Include hidden files. Default: false',
          default: false,
        },
        maxDepth: {
          type: 'number',
          description: 'Max recursion depth. Default: 5',
          default: 5,
        },
      },
      required: [],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const dirPath = (args.path as string) || '.'
    const recursive = !!args.recursive
    const includeHidden = !!args.includeHidden
    const maxDepth = (args.maxDepth as number) || 5

    const rawDir = await securityService.resolveSafePath(
      dirPath,
      'r',
      ctx.sessionId,
    )

    const taskId = `list_dir_${crypto.randomUUID()}`
    const onAbort = () => {
      invoke('stop_task', { taskId }).catch(() => {})
    }
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
    const skipEachDirs = await securityService.getSkipEachDirs()

    const entries: RustDirEntry[] = await invoke('list_directory', {
      root: rawDir,
      recursive,
      includeHidden,
      maxDepth,
      skipEachDirs,
      taskId,
    })

    if (entries.length === 0) {
      return {
        content: '（空目录）',
      }
    }

    // 构建完整相对路径的条目列表
    const pathStack: string[] = []
    const items: { path: string; isDir: boolean }[] = []

    for (const e of entries) {
      if (e.type === 'enter_dir') {
        pathStack.push(e.name)
        items.push({ path: [...pathStack].join('/'), isDir: true })
        continue
      }
      if (e.type === 'leave_dir') {
        pathStack.pop()
        continue
      }

      const fullRel = [...pathStack, e.name].join('/')
      items.push({ path: fullRel, isDir: e.type === 'dir' })
    }

    // 限制最大返回条目数为 600
    const MAX_ITEMS = 600
    const totalItems = items.length
    if (items.length > MAX_ITEMS) {
      items.length = MAX_ITEMS
    }

    // 树状展示（使用 ├── / └── 风格）
    interface TreeNode {
      name: string
      isDir: boolean
      size?: number | null
      children: TreeNode[]
    }

    const buildTree = (): TreeNode[] => {
      const root: TreeNode[] = []
      const stack: TreeNode[][] = [root]
      for (const e of entries) {
        if (e.type === 'enter_dir') {
          const node: TreeNode = { name: e.name, isDir: true, children: [] }
          stack[stack.length - 1].push(node)
          stack.push(node.children)
          continue
        }
        if (e.type === 'leave_dir') {
          stack.pop()
          continue
        }
        stack[stack.length - 1].push({
          name: e.name,
          isDir: e.type === 'dir',
          size: e.size,
          children: [],
        })
      }
      return root
    }

    const tree = buildTree()

    const renderLines: string[] = [rawDir]
    let renderItemCount = 0

    const renderTree = (nodes: TreeNode[], prefix: string) => {
      for (let i = 0; i < nodes.length; i++) {
        if (renderItemCount >= MAX_ITEMS) break

        const node = nodes[i]
        const isLast = i === nodes.length - 1
        const connector = isLast ? '└── ' : '├── '
        const nextPrefix = prefix + (isLast ? '    ' : '│   ')

        const sizeStr =
          !node.isDir && node.size != null
            ? `  (${formatSize(node.size)})`
            : ''
        renderLines.push(
          `${prefix}${connector}${node.name}${node.isDir ? '/' : ''}${sizeStr}${node.isDir && skipEachDirs.includes(node.name) ? '  # 内部省略' : ''}`,
        )
        renderItemCount++

        if (node.children.length > 0) {
          renderTree(node.children, nextPrefix)
        }
      }
    }

    renderTree(tree, '')

    const truncated = totalItems > MAX_ITEMS
    const summary = truncated
      ? `\n\n⚠️ 文件数量超过限制，仅显示前 ${MAX_ITEMS} 项（共 ${totalItems} 项）`
      : `\n\n总计 ${totalItems} 项`

    return {
      content: renderLines.join('\n') + summary,
      uiData: {
        count: items.length,
        items,
      },
    }
  }) as ToolExecutor,
)

toolRegistry.register(
  {
    name: 'delete_file',
    label: '删除文件',
    description:
      'Delete one or more files/directories. Accepts either "path" (single string) or "paths" (array of strings). ' +
      'Deleted items are moved to trash/recycle bin.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the file or directory to delete. Use this for a single item. (Deprecated in favor of "paths".)',
        },
        paths: {
          type: 'array',
          description:
            'Array of paths to delete. Use this to delete multiple files/directories in one call.',
          items: {
            type: 'string',
            description: 'Path to the file or directory to delete.',
          },
        },
      },
      required: [],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    if (!tauriFs) return '[delete_file] 错误：当前不是 Tauri 环境'

    // 兼容单个 path 与多个 paths；过滤空字符串
    const rawPaths: string[] = Array.isArray(args.paths)
      ? (args.paths as any[]).filter(
          (p): p is string => typeof p === 'string' && p.trim() !== '',
        )
      : typeof args.path === 'string' && args.path.trim() !== ''
        ? [args.path]
        : []

    if (rawPaths.length === 0) {
      return '错误：未提供要删除的路径（请使用 "paths" 数组，或单个 "path" 字符串）'
    }

    const deleted: string[] = []
    const errors: string[] = []

    for (const raw of rawPaths) {
      const fullPath = await securityService.resolveSafePath(
        raw,
        'w',
        ctx.sessionId,
      )
      try {
        const exists = await tauriFs.exists(fullPath)
        if (!exists) {
          errors.push(`路径不存在 — ${fullPath}`)
          continue
        }
        await invoke('move_to_trash', { path: fullPath })
        deleted.push(fullPath)
      } catch (e: any) {
        errors.push(`${fullPath} — ${e.message || String(e)}`)
      }
    }

    const parts: string[] = []
    if (deleted.length > 0) {
      parts.push(
        deleted.length === 1
          ? `🗑️ 已移至回收站: ${deleted[0]}`
          : `🗑️ 已移至回收站 ${deleted.length} 项:\n${deleted
              .map((p) => `  - ${p}`)
              .join('\n')}`,
      )
    }
    if (errors.length > 0) {
      parts.push(
        `⚠️ 有 ${errors.length} 项删除失败:\n${errors
          .map((e) => `  - ${e}`)
          .join('\n')}`,
      )
    }
    return parts.join('\n')
  }) as ToolExecutor,
)

toolRegistry.register(
  {
    name: 'file_info',
    label: '文件信息',
    description: 'Get metadata about a file or directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file or directory.' },
      },
      required: ['path'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    if (!tauriFs) return '[file_info] 错误：当前不是 Tauri 环境'

    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'r',
      ctx.sessionId,
    )

    try {
      const exists = await tauriFs.exists(fullPath)
      if (!exists) return `错误：路径不存在 — ${fullPath}`

      const stat = await tauriFs.stat(fullPath)

      return [
        `📋 ${fullPath}`,
        `  类型: ${stat.isDirectory ? '📁 目录' : '📄 文件'}`,
        stat.size !== undefined ? `  大小: ${formatSize(stat.size)}` : '',
        stat.atime ? `  访问时间: ${stat.atime.toLocaleString('zh-CN')}` : '',
        stat.mtime ? `  修改时间: ${stat.mtime.toLocaleString('zh-CN')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    } catch (e: any) {
      return `错误：获取信息失败 — ${e.message || String(e)}`
    }
  }) as ToolExecutor,
)
