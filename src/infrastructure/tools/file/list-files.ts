/**
 * list_files — 列出目录内容（支持递归、隐藏文件、最大深度）
 *
 * 底层调用 Rust `list_directory`，返回结构化条目流
 * （file / dir / enter_dir / leave_dir），本工具负责渲染成树状文本。
 */
import { invoke } from '@tauri-apps/api/core'
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { securityService } from '@/services/security-service'
import { formatSize } from './common'

/** Rust 返回的目录条目（结构化协议，无 magic string 冲突风险） */
type DirEntryType = 'file' | 'dir' | 'enter_dir' | 'leave_dir'

interface RustDirEntry {
  name: string
  type: DirEntryType
  size?: number | null
}

/** 限制最大返回条目数 */
const MAX_ITEMS = 600

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
