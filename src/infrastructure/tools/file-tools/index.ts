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
  hash: string
  line_count: number
  byte_size: number
}

/** Rust edit_file 返回类型 */
interface FileEditResult {
  hash: string
  replaced_count: number
  line_count: number
  old_start_line: number
  old_string_context: string
  new_string_context: string
}

toolRegistry.register(
  {
    name: 'read_file',
    label: t('读取文件'),
    description: `Read a file's content. Returns content, line count, size, and SHA256 hash (for edit_file conflict detection).`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (relative to workspace or absolute).',
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
            'Max lines to read. Default is 1000. When start_line is used, this limits how many lines are returned.',
          default: 1000,
        },
      },
      required: ['path'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'r',
      ctx.sessionId,
    )
    const maxLines = +(args.max_lines as number) || 2000
    const startLine = Math.max(0, +(args.start_line as number) || 1)
    try {
      const result: FileReadResult = await withCancelResult(
        ctx.abortSignal,
        invoke('read_file_with_hash', {
          path: fullPath,
        }),
        () =>
          ({
            content: '',
            hash: '',
            line_count: 0,
            byte_size: 0,
          }) as FileReadResult,
      )

      if (!result.hash) {
        throw '[Cancelled] File read was cancelled.'
      }

      const lines = result.content.split('\n')
      const totalLines = lines.length

      // start_line 是 1-indexed，转成 0-indexed 做切片
      const startIdx = Math.max(0, startLine - 1)
      const endIdx = Math.min(totalLines, startIdx + maxLines)
      const slice = lines.slice(startIdx, endIdx)

      // 计算返回的行号范围
      const displayStart = startIdx + 1
      const displayEnd = endIdx

      // 构建带行号的内容
      const resultLines = slice.map((line, i) => {
        const lineNum = displayStart + i
        return line
      })

      const headerLines = [
        `📄 ${fullPath}`,
        tpl('📝 $__lines__ 行 / $__size__', {
          lines: totalLines,
          size: formatSize(result.byte_size),
        }),
        `🔑 SHA256: ${result.hash}`,
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

      if (startIdx > 0) {
        headerLines.push(
          tpl('💡 提示: 使用 start_line=$__line__ 读取后续内容', {
            line: displayEnd + 1,
          }),
        )
      }
      if (displayEnd < totalLines) {
        headerLines.push(
          tpl(
            '💡 提示: 文件内容未完整显示，剩余 $__remaining__ 行。使用 start_line=$__next__ 读取后续内容',
            { remaining: totalLines - displayEnd, next: displayEnd + 1 },
          ),
        )
      }

      const displayedContent = resultLines.join('\n')
      return {
        content: headerLines.join('\n') + '\n\n' + displayedContent,
        uiData: {
          content: displayedContent,
          hash: result.hash,
          line_count: result.line_count,
          byte_size: result.byte_size,
          fullPath,
          startLine: displayStart,
          endLine: displayEnd,
        },
      }
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
      'Replace exact text in a file. Requires expected_hash from read_file (conflict detection). Prefer for partial edits over write_file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (relative to workspace or absolute).',
        },
        old_string: {
          type: 'string',
          description:
            'The exact existing text to replace. Include enough surrounding context for a unique match.',
        },
        new_string: {
          type: 'string',
          description: 'The new text to insert in place of old_string.',
        },
        expected_hash: {
          type: 'string',
          description:
            'The SHA256 hash of the current file content, obtained from read_file output. ' +
            'Used for conflict detection to ensure no one modified the file since you read it.',
        },
        replace_count: {
          type: 'number',
          description:
            'How many occurrences of old_string to replace. Default: 1. ',
          default: 1,
        },
      },
      required: ['path', 'old_string', 'new_string', 'expected_hash'],
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
    const oldString = args.old_string as string
    const newString = args.new_string as string
    const expectedHash = args.expected_hash as string
    const replaceCount = (args.replace_count as number) ?? 1

    try {
      const result: FileEditResult = await withCancelResult(
        ctx.abortSignal,
        invoke('edit_file_in_place', {
          path: fullPath,
          oldString,
          newString,
          expectedHash,
          replaceCount: replaceCount === 0 ? 999999 : replaceCount,
        }),
        () => {
          throw new Error('[Cancelled] File edit was cancelled.')
        },
      )

      const oldLineCount = result.old_string_context.split('\n').length
      const newLineCount = result.new_string_context.split('\n').length

      // 用 LCS diff 提前计算变更行数，避免前端每次渲染重新计算
      const diffRows = computeDiff(
        result.old_string_context.split('\n'),
        result.new_string_context.split('\n'),
        result.old_start_line,
      )
      const { delCount, insCount } = countDiffRows(diffRows)

      return {
        content:
          tpl('✅ 已编辑文件: $__path__', { path: fullPath }) +
          '\n' +
          `  - ${tpl('替换: $__count__ 处', { count: result.replaced_count })}\n` +
          `  - ${tpl('共 $__count__ 行', { count: result.line_count })}\n` +
          `  - SHA256: ${result.hash}`,
        uiData: {
          fullPath,
          oldStartLine: result.old_start_line,
          oldEndLine: result.old_start_line + oldLineCount - 1,
          newEndLine: result.old_start_line + newLineCount - 1,
          oldString: result.old_string_context,
          newString: result.new_string_context,
          diffRows,
          delCount,
          insCount,
        },
      }
    } catch (e: any) {
      const msg = e.message || String(e)
      // 将 Rust 端的错误消息直接传递给 AI，帮助它修复
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
 * 计算内容归一化（LF-only）后的 SHA256 哈希，与 Rust 端 read_file/edit_file 一致
 */
async function computeContentHash(content: string): Promise<string> {
  // 归一化：\r\n → \n，与 Rust 端 normalize_content 保持一致
  const normalized = content.replace(/\r\n/g, '\n')
  const encoder = new TextEncoder()
  const data = encoder.encode(normalized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

toolRegistry.register(
  {
    name: 'write_file',
    label: t('写入文件'),
    description:
      'Write content to a file (full overwrite). Creates parent directories if they do not exist. ' +
      '⚠️ Use edit_file for partial modifications instead of reading and re-writing entire files. ' +
      'Returns the SHA256 hash of the written content (normalized to LF), which can be used ' +
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

      // 计算归一化内容的 SHA256 hash，与 read_file/edit_file 一致
      const hash = await computeContentHash(content)
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
          hash,
          fullPath,
          lineCount,
          byteSize: new TextEncoder().encode(content).length,
        },
        content: returnContent + `\n🔑 SHA256: ${hash}`,
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
    description: 'Delete a file or directory. ',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file or directory to delete.',
        },
      },
      required: ['path'],
    },
  },
  (async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    if (!tauriFs) return '[delete_file] 错误：当前不是 Tauri 环境'

    const fullPath = await securityService.resolveSafePath(
      args.path as string,
      'w',
      ctx.sessionId,
    )
    try {
      const exists = await tauriFs.exists(fullPath)
      if (!exists) return `错误：路径不存在 — ${fullPath}`

      await invoke('move_to_trash', { path: fullPath })
      return `🗑️ 已移至回收站: ${fullPath}`
    } catch (e: any) {
      return `错误：删除失败 — ${e.message || String(e)}`
    }
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
