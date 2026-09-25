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
import { t } from '@/ui/i18n'
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
    'list_files',
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
      // ⚠️ 模型侧固定英文（P4b/D2-A）；UI 侧走 uiData 由组件按界面语言渲染
      return {
        content: '(empty directory)',
        uiData: {
          count: 0,
          items: [],
          rootPath: rawDir,
          nodes: [],
          totalItems: 0,
          maxItems: MAX_ITEMS,
          truncated: false,
        },
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
      /** 该目录在 skipEachDirs 中 → UI 侧渲染「内部省略」标记（语言无关布尔值） */
      elided?: boolean
      children: TreeNode[]
    }

    const buildTree = (): TreeNode[] => {
      const root: TreeNode[] = []
      const stack: TreeNode[][] = [root]
      for (const e of entries) {
        if (e.type === 'enter_dir') {
          const node: TreeNode = {
            name: e.name,
            isDir: true,
            elided: skipEachDirs.includes(e.name),
            children: [],
          }
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
          elided: e.type === 'dir' && skipEachDirs.includes(e.name),
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
          `${prefix}${connector}${node.name}${node.isDir ? '/' : ''}${sizeStr}${node.elided ? '  # elided' : ''}`,
        )
        renderItemCount++

        if (node.children.length > 0) {
          renderTree(node.children, nextPrefix)
        }
      }
    }

    renderTree(tree, '')

    /** 语言无关的目录树（供 UI 组件本地化渲染；content 里的树文本仍给模型） */
    const toUiNodes = (nodes: TreeNode[]): any[] =>
      nodes.map((n) => ({
        name: n.name,
        isDir: n.isDir,
        ...(n.size != null ? { size: n.size } : {}),
        ...(n.elided ? { elided: true } : {}),
        ...(n.children.length > 0 ? { children: toUiNodes(n.children) } : {}),
      }))

    const truncated = totalItems > MAX_ITEMS
    // ⚠️ 与 Rust `native_tools/file/list_files.rs` 的 summary 逐字一致（铁律 1）
    const summary = truncated
      ? `\n\n⚠️ Too many files; showing only the first ${MAX_ITEMS} of ${totalItems} item(s)`
      : `\n\n${totalItems} item(s) total`

    return {
      content: renderLines.join('\n') + summary,
      uiData: {
        count: items.length,
        items,
        rootPath: rawDir,
        nodes: toUiNodes(tree),
        totalItems,
        maxItems: MAX_ITEMS,
        truncated,
      },
    }
  }) as ToolExecutor,
    t('列出文件'),
)
