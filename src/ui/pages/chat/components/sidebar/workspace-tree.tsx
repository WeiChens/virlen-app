/**
 * 侧边栏「工作目录」页签：资源管理器式文件树。
 *
 * 树根 = 当前会话 workspace → 已选目录 → 全局默认。懒加载（展开才 list_directory），虚拟列表只渲染视口行。
 * 搜索：关键词非空时整个工作目录递归搜，扁平结果替代树视图（防抖 250ms、可取消）。
 * 写操作一律走 file-transfer-service 过安全校验。
 *
 * 点项（`.` 开头）**不隐藏**：树与搜索都按 includeHidden: true 读盘 —— `.env` / `.gitignore` /
 * `.github` 是要编辑的正文。但**系统隐藏项**（如 `.git`：git 自己打上的隐藏属性）Rust 侧一律不列，
 * 前端不做第二道过滤。搜索只额外剪掉 `.git` 内部（版本库对象海量，扫一遍纯噪声）。
 *
 * **只监听展开的目录**（`use-dir-watch`）：根与每个展开项各一个非递归 watcher，折叠即退订 ——
 * 整棵树（node_modules / target / .git）一次保存能刷出几千个事件，盯不起。事件到达只是
 * 「静默重读这一层」，展开状态、选中、滚动全不动。
 *
 * **而且只在「正在被看」时才监听**（`active`）：右侧面板里的每棵树都常驻挂载（切标签不卸载、
 * 切会话不清状态），不是当前标签 / 面板收起时一个目录也不订；回到「被看」时把正在看着的
 * 那几层静默重读一遍（不盯期间的增删不会再有事件送来）。树根按 `sessionId`（标签自己的会话）解析，
 * 不传才是当前会话。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useVirtualizer } from '@tanstack/react-virtual'
import { invoke } from '@tauri-apps/api/core'
import { chatState, sessionStore, settingsState } from '@/ui/store'
import {
  canMoveInto,
  fileTransferService,
} from '@/services/file-transfer-service'
import { formatSize } from '@/infrastructure/tools/file/common'
import { getPlatform } from '@/utils/common'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import ContextMenu, { useContextMenu } from '@/ui/components/shared/ContextMenu'
import { track } from '@/utils/telemetry'
import { t, tpl } from '@/ui/i18n'
import CollapsedSvg from '@/ui/components/icons/CollapsedSvg'
import RefreshSvg from '@/ui/components/icons/RefreshSvg'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import {
  buildTreeRows,
  normalizeTreePath,
  parentDirOf,
  pasteDirFor,
  rankFilePaths,
  selectRangePaths,
  treeBaseName,
} from './tree-rows'
import type { DirState, TreeEntry, TreeRow } from './tree-rows'
import { useTreeDrag } from './use-tree-drag'
import type { TreeDragItem } from './use-tree-drag'
import { useDirWatchers } from './use-dir-watch'
import { workspaceTreeMenuItems } from './tree-menu'
import type { TreeMenuTarget } from './tree-menu'
import SidebarSearch from './search-box'

interface Props {
  /** 把路径作为附件挂到输入框 */
  onAttachPaths: (paths: string[]) => void
  /** 双击文件 → 在右侧面板打开（文本编辑 / 媒体预览） */
  onOpenFile: (path: string) => void
  /** 搜索关键词与写回（值由父组件持有：切页签会卸载本组件） */
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  /**
   * 这棵树长在哪：左侧栏（`sidebar`，默认）还是右侧面板的「工作区文件」标签（`panel`）。
   *
   * 唯一差别是**文件行的单击语义**：右侧面板里单击就打开（面板不长驻、用户点一下就是“看这个”），
   * 左侧栏保持双击（改掉老手感没有任何好处）。样式不受它影响 —— 树样式已 `@at-root`，两边共用。
   */
  /**
   * 这棵树此刻是不是**正在被看**（右侧面板里 = 当前会话的选中标签 + 面板没收起）。
   * `false` 时一个目录 watcher 也不订；回到 `true` 时把正在看着的那几层静默重读一遍。
   * 不传 = 一直盯着（左侧栏的常驻树就是这样）。
   */
  active?: boolean
  /**
   * 树根用哪个会话的工作目录。不传 = 当前会话（左侧栏、开始页都这样）；
   * 右侧面板里别的会话挂着的那个标签必须传**标签自己的**会话：
   * 否则它会去当前会话的目录里订 watcher、把别的会话的文件树画出来。
   */
  sessionId?: string
  variant?: 'sidebar' | 'panel'
}

/** 行高（与 style.scss 的 .tree-row 一致） */
const TREE_ROW_HEIGHT = 24

/** 视口外多渲染的行数 */
const TREE_OVERSCAN = 16

/** 每级缩进、基础左侧留白 */
const INDENT_STEP = 12
const BASE_INDENT = 6

/** 显示文件大小的最小容器宽度 */
const SIZE_MIN_CONTAINER_WIDTH = 220

/** 不监听任何目录（无工作目录 / 浏览器调试）—— 恒定引用，避免每帧重算 */
const NO_DIRS: string[] = []

/** 磁盘搜索命中上限（Rust 侧截断） */
const SEARCH_MAX_RESULTS = 60

/** 搜索防抖：每敲一个字都全盘遍历代价太大 */
const SEARCH_DEBOUNCE_MS = 250

/**
 * 磁盘搜索默认整棵剪掉的目录名（依赖 / 缓存 / 构建产物）：剪枝在 Rust 侧做，不是拿回结果再过滤。
 * 用户在树里展开过的那份不剪；只作用于侧边栏搜索框。
 *
 * `.git` 独一个理由：点项本身要能搜到（`.env` / `.gitignore` 命中靠的是文件名，不受剪枝影响），
 * 但版本库内部是成千上万个对象文件，扫一遍纯属噪声 + 拖慢搜索。
 */
const SEARCH_SKIP_DIR_NAMES = [
  '.git',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
]

/** 是否 Tauri 环境（浏览器调试无 list_directory） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 目录优先、名称不区分大小写排序（对齐 VS Code） */
function compareEntry(a: TreeEntry, b: TreeEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** 命中片段高亮（只标第一处，全标反而是噪音） */
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  )
}

function WorkspaceTree({
  onAttachPaths,
  onOpenFile,
  searchQuery: query,
  onSearchQueryChange: setQuery,
  variant = 'sidebar',
  active = true,
  sessionId,
}: Props) {
  /** 已加载目录缓存，key 为绝对路径 */
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  /** 展开状态，key 为绝对路径 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** 行内重命名：路径 + 原始名 + 当前输入 */
  const [renaming, setRenaming] = useState<{
    path: string
    original: string
    value: string
  } | null>(null)
  /** 容器够宽时才在行右侧显示文件大小 */
  const [isWide, setIsWide] = useState(false)
  /** 选中项（存 Map 而非 Set：拖拽 / 菜单需要 name 与 isDir） */
  const [selected, setSelected] = useState<Map<string, TreeMenuTarget>>(
    new Map(),
  )
  /** 搜索结果（已归一化为 / 分隔并排序） */
  const [searchResults, setSearchResults] = useState<string[]>([])
  /** Rust 侧是否已截断（≥ 上限即可能还有更多） */
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  /** 点击结果定位后要滚到的行（等 rows 更新再滚） */
  const [scrollToPath, setScrollToPath] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** Shift 连选的锚点（最近一次单击的行） */
  const anchorRef = useRef<string | null>(null)
  const menu = useContextMenu<TreeMenuTarget>()
  /** 重命名待提交值（提交读 ref）：Enter 与随后的 blur 可能同帧先后触发，读 state 会提交两遍 */
  const renamingRef = useRef<{
    path: string
    original: string
    value: string
  } | null>(null)

  const applyRenaming = useCallback(
    (next: { path: string; original: string; value: string } | null) => {
      renamingRef.current = next
      setRenaming(next)
    },
    [],
  )

  // 在 observer 渲染中读取，切换会话 / 换工作目录时能同步刷新。
  // `sessionId` 是宿主传进来的归属（右侧面板里 = 标签自己的会话）：它同时定树根与写操作的
  // 安全校验上下文 —— 两者必须是同一个会话，否者一边看 A、一边去 B 里删改
  const ownerId = sessionId ?? chatState.value.currentSessionId
  const rawRoot = ownerId
    ? sessionStore.getSession(ownerId)?.workspace
    : chatState.value.selectedWorkspace
  const rootPath = normalizeTreePath(
    rawRoot || settingsState.value.defaultWorkspace || '',
  )

  /**
   * 读取目录直接子项（覆盖写缓存）。
   * @param silent 静默刷新：不置 loading、失败也不写 error（文件操作后刷新用）
   */
  const loadDir = useCallback(async (path: string, silent = false) => {
    if (!silent) {
      setDirs((prev) => ({
        ...prev,
        [path]: { ...prev[path], loading: true, error: undefined },
      }))
    }
    try {
      // invoke 返回 unknown，用 any[] 收口
      const raw: any[] = await invoke('list_directory', {
        root: path,
        recursive: false,
        // 点项照常显示：`.env` / `.gitignore` / `.github` 都是用户要编辑的真文件，
        // 藏起来只会让人以为「目录里没有它」。系统隐藏项（`.git`，靠 Windows 隐藏位 / macOS
        // UF_HIDDEN 判定）已由 Rust 侧过滤，不依赖这个开关。
        includeHidden: true,
        maxDepth: 1,
        // 非递归模式下 Rust 不会下钻，skipEachDirs 无作用 → 传空
        skipEachDirs: [],
        taskId: `sidebar_tree_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      })
      const entries = raw
        .filter((e) => e.type === 'file' || e.type === 'dir')
        .map((e) => ({
          name: e.name as string,
          isDir: e.type === 'dir',
          size: typeof e.size === 'number' ? e.size : undefined,
        }))
        .sort(compareEntry)
      setDirs((prev) => ({ ...prev, [path]: { entries } }))
    } catch (e: any) {
      // 静默刷新失败：保留旧内容
      if (silent) return
      setDirs((prev) => ({
        ...prev,
        [path]: { error: e?.message || String(e) },
      }))
    }
  }, [])

  // 工作目录变化（切换会话 / 换目录 / 新建对话）→ 清空缓存，重新加载根目录
  useEffect(() => {
    setDirs({})
    applyRenaming(null)
    setSelected(new Map())
    anchorRef.current = null
    if (!rootPath) {
      setExpanded({})
      return
    }
    setExpanded({ [rootPath]: true })
    void loadDir(rootPath)
  }, [rootPath, loadDir, applyRenaming])

  // 容器宽度 → 是否显示文件大小（侧边栏可拖拽调宽）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = () => setIsWide(el.clientWidth >= SIZE_MIN_CONTAINER_WIDTH)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootPath])

  /** 「默认剪掉、但用户已展开」的目录：不再剪枝 */
  const searchKeepDirs = useMemo(
    () =>
      Object.keys(expanded).filter(
        (path) =>
          expanded[path] && SEARCH_SKIP_DIR_NAMES.includes(treeBaseName(path)),
      ),
    [expanded],
  )

  /**
   * 关键词 → 磁盘递归搜索（防抖 + 可取消）。两个坑：新关键词要 stop 上一次遍历，否则旧结果
   * 可能后到覆盖新结果；Windows 下 walk 出的路径子级用 \，查询串要先换分隔符。
   */
  useEffect(() => {
    const q = query.trim()
    if (!q || !rootPath || !isTauriEnv()) {
      setSearchResults([])
      setSearchTruncated(false)
      setSearchError('')
      setSearching(false)
      return
    }

    const taskId = `sidebar_tree_search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    let cancelled = false
    setSearching(true)
    setSearchError('')

    const timer = setTimeout(async () => {
      try {
        // os_platform 有进程内缓存，不会真的每次问 Rust
        const platform = await getPlatform()
        const matcher = platform === 'windows' ? q.replace(/\//g, '\\') : q
        const raw: any[] = await invoke('search_files_by_name', {
          root: rootPath,
          query: matcher,
          useRegex: false,
          maxResults: SEARCH_MAX_RESULTS,
          taskId,
          // 与树同口径：树上看得见的点项，搜索框也要搜得到
          includeHidden: true,
          // 依赖 / 构建目录整棵剪掉（Rust 侧 filter_entry 不下钻）
          skipDirNames: SEARCH_SKIP_DIR_NAMES,
          // 例外：已在树里展开过的那份忽略目录
          keepDirs: searchKeepDirs,
        })
        if (cancelled) return
        const rawList: any[] = raw ?? []
        // 路径统一归一化为 / 分隔：展示、排序与祖先定位都按它走
        const paths = rawList
          .map((item) => normalizeTreePath(String(item?.path ?? '')))
          .filter(Boolean)
        setSearchResults(rankFilePaths(paths, q))
        setSearchTruncated(rawList.length >= SEARCH_MAX_RESULTS)
      } catch (e: any) {
        if (cancelled) return
        setSearchResults([])
        setSearchError(typeof e === 'string' ? e : e?.message || String(e))
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      // 任务可能还没注册（防抖期内就换了关键词）→ stop_task 返回 false，无副作用
      void invoke('stop_task', { taskId }).catch(() => {})
    }
  }, [query, rootPath, searchKeepDirs])

  /** 可见行（虚拟列表输入）+ 「路径 → 行信息」索引（Shift 连选要用） */
  const rows = useMemo(
    () => buildTreeRows({ rootPath, dirs, expanded }),
    [rootPath, dirs, expanded],
  )
  const rowMeta = useMemo(() => {
    const map = new Map<string, TreeMenuTarget>()
    for (const row of rows) {
      if (row.kind === 'node') {
        map.set(row.path, { path: row.path, name: row.name, isDir: row.isDir })
      }
    }
    return map
  }, [rows])

  /** 文件操作后刷新：根目录 + 所有已展开目录（静默） */
  const refreshAfterFileOp = useCallback(
    (...extraDirs: string[]) => {
      const targets = new Set<string>([rootPath, ...extraDirs])
      for (const path of Object.keys(expanded)) {
        if (expanded[path]) targets.add(path)
      }
      targets.forEach((path) => {
        if (path) void loadDir(path, true)
      })
    },
    [rootPath, expanded, loadDir],
  )

  /**
   * 目录展开 / 折叠：展开时读盘。首次是懒加载；已有缓存则**静默重读** —— 折叠期间没有 watcher，
   * 缓存可能已被外部程序改过（不然会拿一份旧的列表一直显示）。
   */
  const toggleExpand = useCallback(
    (dirPath: string, open?: boolean) => {
      const next = open ?? !expanded[dirPath]
      if (next && !dirs[dirPath]?.loading) {
        void loadDir(dirPath, !!dirs[dirPath]?.entries)
      }
      setExpanded((prev) => ({ ...prev, [dirPath]: next }))
    },
    [expanded, dirs, loadDir],
  )

  /**
   * 监听哪几层：根 + 所有**展开**的目录（折叠的不订）：整棵树盯不起，
   * 而且只看「列表可能变了没」，不需要区分新增 / 删除 / 重命名。
   * 不活跃（不是当前标签 / 面板收起）时一层都不订。
   */
  const watchedDirs = useMemo(() => {
    if (!active || !rootPath || !isTauriEnv()) return NO_DIRS
    const list = [rootPath]
    for (const [path, open] of Object.entries(expanded)) {
      if (open && path && path !== rootPath) list.push(path)
    }
    return list
  }, [active, rootPath, expanded])

  /** 某一层变了 → 静默重读（不置 loading、失败保留旧内容） */
  const handleDirChanged = useCallback(
    (dir: string) => {
      void loadDir(dir, true)
    },
    [loadDir],
  )

  useDirWatchers(watchedDirs, handleDirChanged)

  /**
   * 从「不看着」回到「看着」（切到这个标签 / 面板重新展开）：把正在看着的那几层静默重读一遍。
   * 不盯的那段时间里的增删不会再有事件送来，不补这一次树就一直是旧的。
   * 首次挂载不算（`loadDir(rootPath)` 正在读）；目录 / 加载函数的身份变化不算「回来」，走 ref。
   */
  const firstLiveRef = useRef(true)
  const watchedDirsRef = useRef<string[]>(NO_DIRS)
  watchedDirsRef.current = watchedDirs
  const loadDirRef = useRef(loadDir)
  loadDirRef.current = loadDir
  useEffect(() => {
    const first = firstLiveRef.current
    firstLiveRef.current = false
    if (first || !active) return
    for (const dir of watchedDirsRef.current) void loadDirRef.current(dir, true)
  }, [active])

  /** 用一批行覆盖选择集 */
  const setSelection = useCallback((targets: TreeMenuTarget[]) => {
    setSelected(new Map(targets.map((target) => [target.path, target])))
  }, [])

  /**
   * 点搜索结果 → 在树里定位：逐级加载祖先 → 展开 → 选中 → 滚到该行，最后清空关键词回到树视图。
   */
  const locateSearchResult = useCallback(
    async (filePath: string) => {
      const full = normalizeTreePath(filePath)
      // 搜索结果必然在工作目录下；越界说明状态错乱
      if (!rootPath || !full.startsWith(rootPath + '/')) return

      const segments = full.slice(rootPath.length + 1).split('/')
      const chain: string[] = []
      let current = rootPath
      for (let i = 0; i < segments.length - 1; i++) {
        current = `${current}/${segments[i]}`
        chain.push(current)
      }
      // 必须自顶向下加载：父目录未加载时，扁平化只产出它的「加载中」占位行
      for (const dir of chain) {
        if (!dirs[dir]?.entries) await loadDir(dir)
      }

      setExpanded((prev) => {
        const next: Record<string, boolean> = { ...prev, [rootPath]: true }
        for (const dir of chain) next[dir] = true
        return next
      })
      setSelection([{ path: full, name: treeBaseName(full), isDir: false }])
      anchorRef.current = full
      setScrollToPath(full)
      setQuery('')
    },
    [rootPath, dirs, loadDir, setSelection],
  )

  /**
   * 单击 = 选中：Ctrl/Cmd 加选减选、Shift 从锚点连选、无修饰键单选并（目录）展开。
   * 带修饰键时不展开 —— 可见行数一变，后续 Shift 范围就错位。
   */
  const handleRowClick = useCallback(
    (
      row: TreeMenuTarget,
      e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    ) => {
      if (e.ctrlKey || e.metaKey) {
        setSelected((prev) => {
          const next = new Map(prev)
          if (next.has(row.path)) next.delete(row.path)
          else next.set(row.path, row)
          return next
        })
        anchorRef.current = row.path
        return
      }
      if (e.shiftKey && anchorRef.current) {
        setSelection(
          selectRangePaths(rows, anchorRef.current, row.path).map(
            (path) =>
              rowMeta.get(path) ?? {
                path,
                name: treeBaseName(path),
                isDir: false,
              },
          ),
        )
        return
      }
      anchorRef.current = row.path
      setSelection([row])
      if (row.isDir) toggleExpand(row.path)
      // 右侧面板里单击文件就是「打开」：面板本来就窄，再要双击反直觉
      else if (variant === 'panel') onOpenFile(row.path)
    },
    [rows, rowMeta, setSelection, toggleExpand, variant, onOpenFile],
  )

  /** 目录 / 文件 → 输入框附件（右键引用、拖到输入框共用） */
  const attachTargets = useCallback(
    (targets: TreeMenuTarget[], source: 'menu' | 'drag') => {
      if (targets.length === 0) return
      onAttachPaths(targets.map((target) => target.path))
      track('sidebar.file.attach', {
        source,
        count: targets.length,
        is_dir: targets[0].isDir,
      })
    },
    [onAttachPaths],
  )

  /**
   * 拖到另一个目录 = 移动（整份选择集）。先确认再落盘：一次可能搬很多项，误拖代价不小。
   */
  const handleMove = useCallback(
    async (items: TreeDragItem[], targetDir: string) => {
      // 已在目标目录里的不算要搬的：否则弹窗条数与成功提示对不上
      const pending = items.filter(
        (item) => parentDirOf(item.path) !== targetDir,
      )
      // 全在目标目录里（拖回原目录）→ 没有动作
      if (pending.length === 0) return

      const confirmed = await MessageBox.propt(
        pending.length === 1
          ? tpl('移动「$__name__」？', { name: pending[0].name })
          : tpl('移动选中的 $__count__ 项？', { count: pending.length }),
        () => <MoveConfirmBody targetDir={targetDir} items={pending} />,
        { confirmText: t('移动'), cancelText: t('取消') },
      )
      if (!confirmed) return

      const result = await fileTransferService.move(
        pending.map((item) => item.path),
        targetDir,
        ownerId || undefined,
      )
      track('sidebar.file.op', {
        op: 'move',
        ok: result.ok,
        count: result.moved ?? 0,
        failed: result.failed ?? 0,
      })

      if (!result.ok) {
        if (result.code === 'invalid-target') {
          showToast(t('不能移动到自身或其子目录'), 3000)
        } else if (result.code === 'exists') {
          showToast(
            tpl('目标位置已存在同名项：$__name__', {
              name: result.conflict?.[0] || '',
            }),
            3000,
          )
        } else {
          showToast(
            tpl('移动失败：$__error__', {
              error: result.error || t('未知错误'),
            }),
            3000,
          )
        }
        return
      }

      if (result.failed) {
        showToast(
          tpl('已移动 $__count__ 项，$__failed__ 项失败', {
            count: result.moved ?? 0,
            failed: result.failed,
          }),
          3000,
        )
      } else {
        showToast(
          tpl('已移动 $__count__ 项', { count: result.moved ?? 0 }),
          2000,
        )
      }
      // 源所在目录 + 目标目录都要刷新；路径变了，旧的选中项不再有意义
      refreshAfterFileOp(
        targetDir,
        ...pending.map((item) => parentDirOf(item.path)),
      )
      setSelection([])
    },
    [ownerId, refreshAfterFileOp, setSelection],
  )

  const { startDrag, draggedRef } = useTreeDrag({
    onDropToInput: (items) => attachTargets(items, 'drag'),
    onDropIntoDir: (items, targetDir) => void handleMove(items, targetDir),
    // 落点合法性：不能拖到源自身或其子目录
    canDropIntoDir: (items, targetDir) =>
      canMoveInto(
        items.map((item) => item.path),
        targetDir,
      ),
  })

  /**
   * 按下：算本次要拖的项。命中行已在选择集里则拖整份，否则只拖它自己并立即选上。
   * 树根不参与移动。
   */
  const handleRowPointerDown = useCallback(
    (e: React.PointerEvent, row: TreeMenuTarget) => {
      // 按在按钮 / 输入框上不算拖拽
      if ((e.target as HTMLElement).closest('button, input')) return
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !selected.has(row.path)) {
        setSelection([row])
      }
      const targets = (
        selected.has(row.path) ? [...selected.values()] : [row]
      ).filter((target) => target.path !== rootPath)
      startDrag(e, targets)
    },
    [selected, rootPath, setSelection, startDrag],
  )

  /**
   * 双击 = 打开：文件进右侧面板（文本编辑 / 图片 / 音视频预览），目录切展开。
   * 引用到输入框只保留在右键菜单与拖拽上 —— 双击是最容易被误触的动作，不能既打开又引用。
   */
  const handleRowDoubleClick = useCallback(
    (row: TreeMenuTarget) => {
      if (draggedRef.current) {
        draggedRef.current = false
        return
      }
      if (row.isDir) {
        toggleExpand(row.path)
        return
      }
      onOpenFile(row.path)
    },
    [toggleExpand, onOpenFile, draggedRef],
  )

  /** 行点击：先看这一轮是否拖拽（拖拽松手后浏览器仍会补一次 click） */
  const onRowClick = useCallback(
    (
      row: TreeMenuTarget,
      e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    ) => {
      if (draggedRef.current) {
        draggedRef.current = false
        return
      }
      handleRowClick(row, e)
    },
    [handleRowClick, draggedRef],
  )

  const handleCopy = useCallback((targets: TreeMenuTarget[]) => {
    fileTransferService.copy(targets.map((target) => target.path))
    track('sidebar.file.op', { op: 'copy', count: targets.length })
    showToast(
      targets.length > 1
        ? tpl('已复制 $__count__ 项，可在其他目录粘贴', {
            count: targets.length,
          })
        : t('已复制，可在其他目录粘贴'),
      2000,
    )
  }, [])

  const handlePaste = useCallback(
    async (row: TreeMenuTarget) => {
      const dir = pasteDirFor(row)
      const result = await fileTransferService.paste(dir, ownerId || undefined)
      track('sidebar.file.op', {
        op: 'paste',
        ok: result.ok,
        count: result.copied ?? 0,
      })
      if (!result.ok) {
        showToast(
          tpl('粘贴失败：$__error__', {
            error: result.error || t('未知错误'),
          }),
          3000,
        )
        return
      }
      showToast(tpl('已粘贴 $__count__ 项', { count: result.copied ?? 0 }), 2000)
      refreshAfterFileOp(dir)
    },
    [ownerId, refreshAfterFileOp],
  )

  const handleDelete = useCallback(
    async (targets: TreeMenuTarget[]) => {
      if (targets.length === 0) return
      const single = targets.length === 1 ? targets[0] : null
      const confirmed = await MessageBox.propt(
        single
          ? tpl('删除「$__name__」？', { name: single.name })
          : tpl('删除选中的 $__count__ 项？', { count: targets.length }),
        single
          ? single.isDir
            ? t('该目录及其内容会移入系统回收站，可在回收站中恢复。')
            : t('该文件会移入系统回收站，可在回收站中恢复。')
          : t('选中的文件 / 目录会移入系统回收站，可在回收站中恢复。'),
        {
          confirmText: t('移入回收站'),
          cancelText: t('取消'),
          danger: true,
        },
      )
      if (!confirmed) return

      // 逐个删（不走并发）：失败时要能报出成功几个、失败几个
      let removed = 0
      let failed = 0
      let firstError = ''
      for (const target of targets) {
        const result = await fileTransferService.remove(
          target.path,
          ownerId || undefined,
        )
        if (result.ok) {
          removed++
        } else {
          failed++
          if (!firstError) firstError = result.error || ''
        }
      }
      track('sidebar.file.op', {
        op: 'delete',
        ok: failed === 0,
        count: removed,
        failed,
      })

      if (failed === 0) {
        showToast(
          removed > 1
            ? tpl('已删除 $__count__ 项', { count: removed })
            : t('已移至回收站'),
          2000,
        )
      } else if (removed === 0) {
        showToast(
          tpl('删除失败：$__error__', {
            error: firstError || t('未知错误'),
          }),
          3000,
        )
        return
      } else {
        showToast(
          tpl('已删除 $__count__ 项，$__failed__ 项失败', {
            count: removed,
            failed,
          }),
          3000,
        )
      }
      refreshAfterFileOp(...targets.map((target) => parentDirOf(target.path)))
      setSelection([])
    },
    [ownerId, refreshAfterFileOp, setSelection],
  )

  /** 提交行内重命名 */
  const commitRename = useCallback(async () => {
    const current = renamingRef.current
    if (!current) return
    // 立即消费：重复调用（Enter 后紧跟 blur）直接返回
    applyRenaming(null)
    const name = current.value.trim()
    if (!name || name === current.original) return

    const result = await fileTransferService.rename(
      current.path,
      name,
      ownerId || undefined,
    )
    track('sidebar.file.op', { op: 'rename', ok: result.ok })
    if (!result.ok) {
      const message =
        result.code === 'exists'
          ? t('目标已存在，请换个名称')
          : result.code === 'invalid-name'
            ? t('名称不能为空，且不能包含路径分隔符')
            : tpl('重命名失败：$__error__', {
                error: result.error || t('未知错误'),
              })
      showToast(message, 3000)
      return
    }
    refreshAfterFileOp(parentDirOf(current.path))
  }, [ownerId, refreshAfterFileOp, applyRenaming])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    overscan: TREE_OVERSCAN,
    getItemKey: (index) => rows[index]?.key ?? index,
  })

  // 定位到某行：必须等 rows 里真的出现它才能滚
  useEffect(() => {
    if (!scrollToPath) return
    const index = rows.findIndex(
      (row) => row.kind === 'node' && row.path === scrollToPath,
    )
    if (index < 0) return
    virtualizer.scrollToIndex(index, { align: 'center' })
    setScrollToPath(null)
  }, [scrollToPath, rows, virtualizer])

  const renderRow = (row: TreeRow) => {
    const indent = { paddingLeft: BASE_INDENT + row.depth * INDENT_STEP }

    if (row.kind === 'message') {
      return (
        <div
          className={`tree-message${row.code === 'error' ? ' error' : ''}`}
          style={indent}
          title={row.text}>
          {row.code === 'loading'
            ? t('加载中...')
            : row.code === 'empty'
              ? t('空目录')
              : row.text}
        </div>
      )
    }

    const isRoot = row.depth === 0
    const isOpen = !!expanded[row.path]
    const isRenaming = renaming?.path === row.path
    const isSelected = selected.has(row.path)
    const sizeText =
      !row.isDir && typeof row.size === 'number' ? formatSize(row.size) : ''
    const title = sizeText ? `${row.path} · ${sizeText}` : row.path
    const target: TreeMenuTarget = {
      path: row.path,
      name: row.name,
      isDir: row.isDir,
    }

    return (
      <div
        className={`tree-row${row.isDir ? '' : ' is-file'}${isRoot ? ' tree-root' : ''}${isSelected ? ' selected' : ''}`}
        style={indent}
        // 目录行 = 拖拽的移动落点（hook 用 elementFromPoint + closest 命中它）
        data-tree-dir={row.isDir ? row.path : undefined}
        onContextMenu={(e) => {
          // 右键命中未选中的行 → 先把选择收敛到它
          if (!isSelected) setSelection([target])
          menu.openAt(e, target)
        }}
        // 重命名时不要启动拖拽，否则选不中文字
        onPointerDown={
          isRenaming ? undefined : (e) => handleRowPointerDown(e, target)
        }>
        <span
          className="tree-main"
          role="button"
          tabIndex={0}
          title={title}
          onClick={(e) => onRowClick(target, e)}
          onDoubleClick={() => handleRowDoubleClick(target)}
          onKeyDown={(e) => {
            // Enter 等价双击（文件打开 / 目录展开），Space 等价单击（选中 / 展开）
            if (e.key === 'Enter') {
              e.preventDefault()
              handleRowDoubleClick(target)
            } else if (e.key === ' ') {
              e.preventDefault()
              onRowClick(target, {})
            }
          }}>
          {row.isDir ? (
            // 箭头单独命中：只切展开，不改选择
            <span
              className="tree-arrow-btn"
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(row.path)
              }}
              onDoubleClick={(e) => e.stopPropagation()}>
              <CollapsedSvg
                className={`tree-arrow-icon${isOpen ? ' expanded' : ''}`}
              />
            </span>
          ) : (
            <FileTypeIcon filename={row.name} className="tree-icon" />
          )}
          {isRenaming ? (
            <input
              className="tree-rename-input"
              value={renaming.value}
              onChange={(e) =>
                applyRenaming(
                  renaming ? { ...renaming, value: e.target.value } : null,
                )
              }
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') applyRenaming(null)
              }}
              // 输入框在可点击行内，点它不能触发选中 / 展开；双击选词也不能冒泡
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <span className="tree-name">{row.name}</span>
          )}
        </span>
        {/* 宽度足够时 hover 才显示体积（窄侧边栏下让位给文件名） */}
        {sizeText && <span className="tree-size">{sizeText}</span>}
        {isRoot && (
          <button
            type="button"
            className="tree-action"
            onClick={() => void loadDir(rootPath, true)}
            title={t('刷新')}
            aria-label={t('刷新')}>
            <RefreshSvg />
          </button>
        )}
      </div>
    )
  }

  /** 关键词非空 = 搜索模式（树视图让位给扁平结果） */
  const isSearching = query.trim().length > 0

  /** 搜索结果列表：树是懒加载的，未展开目录只有磁盘搜索才能覆盖 */
  const renderSearchResults = () => {
    if (searchError) {
      return (
        <div className="tree-message error">
          {tpl('搜索失败: $__error__', { error: searchError })}
        </div>
      )
    }
    if (searchResults.length === 0) {
      return searching ? (
        <div className="tree-message">{t('搜索中...')}</div>
      ) : (
        <div className="sidebar-empty">
          <p>{t('未找到匹配的文件或文件夹')}</p>
          <p className="hint">
            {t('已跳过 node_modules 等依赖 / 构建目录，展开后即可搜到')}
          </p>
        </div>
      )
    }
    return (
      <>
        {searchResults.map((path) => {
          const name = treeBaseName(path)
          // 结果均在 rootPath 下 → 展示相对父路径，完整路径走 tooltip
          const rel = path.slice(rootPath.length + 1)
          const dir = rel.slice(0, rel.length - name.length - 1)
          return (
            <div
              key={path}
              className="tree-search-item"
              role="button"
              tabIndex={0}
              title={path}
              onClick={() => void locateSearchResult(path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void locateSearchResult(path)
                }
              }}>
              <FileTypeIcon filename={name} className="tree-icon" />
              <span className="tree-search-name">
                {highlightMatch(name, query)}
              </span>
              {dir && <span className="tree-search-dir">{dir}</span>}
            </div>
          )
        })}
        {searchTruncated && (
          <div className="tree-search-more">
            {tpl('仅显示前 $__count__ 项，可输入更精确的关键词', {
              count: SEARCH_MAX_RESULTS,
            })}
          </div>
        )}
      </>
    )
  }

  if (!rootPath) {
    return (
      <div className="workspace-tree">
        <div className="sidebar-empty">
          <p>{t('未设置工作目录')}</p>
          <p className="hint">{t('选择工作目录后即可在此浏览文件')}</p>
        </div>
      </div>
    )
  }

  if (!isTauriEnv()) {
    return (
      <div className="workspace-tree">
        <div className="sidebar-empty">
          <p>{t('当前环境不支持浏览本地目录')}</p>
        </div>
      </div>
    )
  }

  // 菜单项必须在渲染时捕获 target / 选择集：ContextMenu 点击时先 onClose（state 归 null）再 onClick
  const menuTarget = menu.state?.target
  // 右键命中未选中的行时，onContextMenu 已把选择收敛到它
  const menuTargets = menuTarget
    ? selected.has(menuTarget.path)
      ? [...selected.values()]
      : [menuTarget]
    : []
  const menuItems = menuTarget
    ? workspaceTreeMenuItems({
        target: menuTarget,
        targets: menuTargets,
        workspace: rootPath,
        actions: {
          onAttach: () => attachTargets(menuTargets, 'menu'),
          onCopy: () => handleCopy(menuTargets),
          onPaste: () => void handlePaste(menuTarget),
          onRename: () =>
            applyRenaming({
              path: menuTarget.path,
              original: menuTarget.name,
              value: menuTarget.name,
            }),
          onDelete: () => void handleDelete(menuTargets),
        },
      })
    : null

  return (
    <div className={`workspace-tree${isWide ? ' is-wide' : ''}`}>
      {/* 搜索框固定在树上方（不随树滚动） */}
      <SidebarSearch
        value={query}
        onChange={setQuery}
        placeholder={t('搜索文件或文件夹…')}
      />
      {/* 滚动容器必须常驻：搜索时只换子节点，不能把 .tree-scroll 一起卸载 */}
      <div className="tree-scroll" ref={scrollRef}>
        {isSearching ? (
          renderSearchResults()
        ) : (
          <div
            className="tree-virtual"
            style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                className="tree-virtual-row"
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}>
                {renderRow(rows[item.index])}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右键菜单（portal 挂到 body，位置由 ContextMenu 钳进视口） */}
      {menu.state && menuItems && (
        <ContextMenu
          position={menu.state.position}
          onClose={menu.close}
          items={menuItems}
        />
      )}
    </div>
  )
}

/**
 * 移动确认弹窗的正文：目标目录 + 将被搬走的条目。
 * MessageBox 的 text 支持传渲染函数，而路径要单独着色 / 折行，所以走 JSX 而不是字符串。
 */
function MoveConfirmBody({
  targetDir,
  items,
}: {
  targetDir: string
  items: TreeDragItem[]
}) {
  /** 列名字上限（再多就把弹窗炸了） */
  const maxNames = 5

  return (
    <div className="tree-move-confirm">
      <div className="tree-move-row">
        <span className="tree-move-label">{t('目标位置')}</span>
        <span className="tree-move-path" title={targetDir}>
          {targetDir}
        </span>
      </div>
      {items.length > 1 && (
        <>
          <ul className="tree-move-list">
            {items.slice(0, maxNames).map((item) => (
              <li key={item.path} title={item.path}>
                {item.isDir ? '📁' : '📄'} {item.name}
              </li>
            ))}
          </ul>
          {items.length > maxNames && (
            <div className="tree-move-more">
              {tpl('… 共 $__count__ 项', { count: items.length })}
            </div>
          )}
        </>
      )}
      <p className="tree-move-hint">
        {t('文件会从原位置移动到目标目录（不是复制）。')}
      </p>
    </div>
  )
}

export default observer(WorkspaceTree)
