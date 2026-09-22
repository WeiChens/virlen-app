/**
 * tree-rows — 目录树「可见行」的扁平化（纯函数，无 React / DOM 依赖）
 *
 * 虚拟列表只接受一维数组，所以先按展开状态把树压平：
 *   根节点 → 逐层子项 → 加载中 / 空目录 / 读取失败 也各占一行。
 * 行高固定（用于虚拟滚动的 estimateSize），因此所有行都是「单行」语义。
 *
 * 另外提供 selectRangePaths（Shift 连选），它同样只能基于「可见行」计算，
 * 放在这里可以单测。
 *
 * 刻意不依赖 service / tauri：保持纯函数，便于单测与在任意环境复用。
 */

/** 目录项（`list_directory` 返回值的最小投影） */
export interface TreeEntry {
  name: string
  isDir: boolean
  /** 文件字节数（目录无此值） */
  size?: number
}

/** 单个目录的加载状态，key 为目录绝对路径 */
export interface DirState {
  entries?: TreeEntry[]
  loading?: boolean
  error?: string
}

/** 一行节点 */
export interface TreeRowNode {
  kind: 'node'
  /** 稳定 key（= 绝对路径） */
  key: string
  path: string
  name: string
  isDir: boolean
  size?: number
  /** 缩进层级，根节点为 0 */
  depth: number
}

/** 一行占位信息（加载中 / 空目录 / 读取失败） */
export interface TreeRowMessage {
  kind: 'message'
  key: string
  depth: number
  code: 'loading' | 'empty' | 'error'
  /** code='error' 时的原始错误文本（不翻译，直接展示） */
  text?: string
}

export type TreeRow = TreeRowNode | TreeRowMessage

/** 路径分隔符统一成 /，去掉尾部斜杠 */
export function normalizeTreePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 取路径所在目录（无目录部分时原样返回） */
export function parentDirOf(p: string): string {
  const normalized = normalizeTreePath(p)
  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? normalized : normalized.slice(0, idx)
}

/** 取路径末段作为显示名 */
export function treeBaseName(p: string): string {
  const segments = normalizeTreePath(p).split('/').filter(Boolean)
  return segments[segments.length - 1] || p
}

/** 该行的「粘贴目标目录」：目录本身；文件取其所在目录 */
export function pasteDirFor(row: { path: string; isDir: boolean }): string {
  return row.isDir ? row.path : parentDirOf(row.path)
}

/**
 * 文件名搜索的结果排序（工作目录页签的搜索框用）。
 *
 * Rust 侧（search_files_by_name → search.rs）是「按目录遍历顺序、拿整条路径做子串匹配」，
 * 结果直接展示会让最相关的那条散落在中间，所以这里按三条规则重排：
 *   1. **末级名称**命中 优先于 仅父路径命中（搜 `session` 时 `sessionStore.ts`
 *      应排在 `src/session-utils/helper.ts` 前面）；
 *   2. 路径短者优先（层级更浅，通常就是用户要找的那个）；
 *   3. 路径字典序（保证同分结果顺序稳定，不会每次搜索都跳）。
 */
export function rankFilePaths(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return paths
  const rank = (p: string): number =>
    treeBaseName(p).toLowerCase().includes(q) ? 0 : 1
  return [...paths].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (a.length !== b.length) return a.length - b.length
    return a.localeCompare(b)
  })
}

/**
 * Shift 连选：取可见行里 anchor → focus 之间的**节点行**路径（含两端，按可见顺序）。
 *
 * 为什么以「可见行」为序：树是一维展开视图，折叠起来的节点不在 rows 里，
 * 用户看不到它们被选中，就不能静默把它们加进选择集。
 * 锚点找不到时（换过工作目录 / 节点已折叠）退回只选 focus 自身。
 */
export function selectRangePaths(
  rows: TreeRow[],
  anchorKey: string,
  focusKey: string,
): string[] {
  const keys = rows.filter((r) => r.kind === 'node').map((r) => r.key)
  const from = keys.indexOf(anchorKey)
  const to = keys.indexOf(focusKey)
  if (from < 0 || to < 0) return [focusKey]
  const [start, end] = from <= to ? [from, to] : [to, from]
  return keys.slice(start, end + 1)
}

/**
 * 按展开状态把树压平成可见行。
 *
 * @param args.rootPath 树根（工作目录绝对路径，空串表示无工作目录）
 * @param args.dirs     已加载目录的缓存
 * @param args.expanded 展开状态（key 为目录绝对路径）
 */
export function buildTreeRows(args: {
  rootPath: string
  dirs: Record<string, DirState>
  expanded: Record<string, boolean>
}): TreeRow[] {
  const { rootPath, dirs, expanded } = args
  if (!rootPath) return []

  const rows: TreeRow[] = [
    {
      kind: 'node',
      key: rootPath,
      path: rootPath,
      name: treeBaseName(rootPath),
      isDir: true,
      depth: 0,
    },
  ]
  if (!expanded[rootPath]) return rows

  pushChildren(rows, rootPath, 1, dirs, expanded)
  return rows
}

function pushChildren(
  rows: TreeRow[],
  dirPath: string,
  depth: number,
  dirs: Record<string, DirState>,
  expanded: Record<string, boolean>,
): void {
  const state = dirs[dirPath]
  if (!state || state.loading) {
    rows.push({ kind: 'message', key: `${dirPath}#loading`, depth, code: 'loading' })
    return
  }
  if (state.error) {
    rows.push({
      kind: 'message',
      key: `${dirPath}#error`,
      depth,
      code: 'error',
      text: state.error,
    })
    return
  }
  if (!state.entries || state.entries.length === 0) {
    rows.push({ kind: 'message', key: `${dirPath}#empty`, depth, code: 'empty' })
    return
  }

  for (const entry of state.entries) {
    const path = `${dirPath}/${entry.name}`
    rows.push({
      kind: 'node',
      key: path,
      path,
      name: entry.name,
      isDir: entry.isDir,
      size: entry.size,
      depth,
    })
    if (entry.isDir && expanded[path]) {
      pushChildren(rows, path, depth + 1, dirs, expanded)
    }
  }
}
