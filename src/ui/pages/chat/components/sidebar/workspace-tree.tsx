/**
 * workspace-tree —— 侧边栏「工作目录」页签
 *
 * 以 VS Code 资源管理器的方式展示当前工作目录的文件树：
 *  - 树根 = 当前会话的 workspace；无会话（新对话）时用已选择的工作目录，
 *    再兜底到全局默认工作目录
 *  - 懒加载：展开某个目录时才调 `list_directory` 读它的直接子项（recursive=false, maxDepth=1）
 *  - 虚拟列表：只渲染视口内的行（`@tanstack/react-virtual`），
 *    十几万条目的目录也不会卡（行高固定，见 tree-rows.ts 的扁平化）
 *  - 行交互（对齐资源管理器）：
 *      · 单击 = 选中（Ctrl/Cmd 加减、Shift 连选）；无修饰键时目录顺带展开/折叠
 *      · 左侧箭头单击 = 只切展开/折叠，不动选择
 *      · 双击 = 引用到输入框；右键菜单 = 打开 / 编辑器打开 / 复制 / 粘贴 /
 *        重命名 / 删除 / 在文件管理器中显示…
 *      · 拖到输入框 = 引用成附件；拖到目录行 = 移动到该目录（整份选择集一起）
 *
 * 与输入框的 `@` 路径补全同源，都是**不经安全校验的只读目录浏览**
 * （树根本身就是用户自己选定/配置的工作目录），仅隐藏点文件；不落盘、不缓存。
 * 但**写操作**（粘贴 / 移动 / 重命名 / 删除）一律经 file-transfer-service 过安全校验（铁律 6）。
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
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import ContextMenu, { useContextMenu } from '@/ui/components/shared/ContextMenu'
import { track } from '@/utils/telemetry'
import { t, tpl } from '@/ui/i18n'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import RefreshSvg from '@/ui/components/icons/RefreshSvg'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import {
  buildTreeRows,
  normalizeTreePath,
  parentDirOf,
  pasteDirFor,
  selectRangePaths,
  treeBaseName,
} from './tree-rows'
import type { DirState, TreeEntry, TreeRow } from './tree-rows'
import { useTreeDrag } from './use-tree-drag'
import type { TreeDragItem } from './use-tree-drag'
import { workspaceTreeMenuItems } from './tree-menu'
import type { TreeMenuTarget } from './tree-menu'

interface Props {
  /** 把路径作为附件挂到聊天输入框（右键「引用」/ 拖拽到输入框都走它） */
  onAttachPaths: (paths: string[]) => void
}

/** 行高（与 style.scss 的 .tree-row 保持一致，虚拟滚动按固定行高估算） */
const TREE_ROW_HEIGHT = 24

/** 视口外多渲染的行数 */
const TREE_OVERSCAN = 16

/** 每级缩进、基础左侧留白（与 style.scss 的行内边距一致） */
const INDENT_STEP = 12
const BASE_INDENT = 6

/**
 * 显示文件大小的最小容器宽度（px）。
 * 窄侧边栏下名字本身就不够显示，再挤一个大小进去只会两边都看不全 → 只在够宽时显示。
 */
const SIZE_MIN_CONTAINER_WIDTH = 220

/** 是否 Tauri 环境（浏览器调试模式下没有 list_directory 命令） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 目录优先、名称不区分大小写排序（对齐 VS Code 资源管理器） */
function compareEntry(a: TreeEntry, b: TreeEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

function WorkspaceTree({ onAttachPaths }: Props) {
  /** 已加载目录的缓存，key 为目录绝对路径 */
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  /** 展开状态，key 为目录绝对路径 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** 行内重命名：正在编辑的路径 + 原始名 + 当前输入 */
  const [renaming, setRenaming] = useState<{
    path: string
    original: string
    value: string
  } | null>(null)
  /** 容器够宽时才在行右侧显示文件大小 */
  const [isWide, setIsWide] = useState(false)
  /**
   * 选中项：key = 绝对路径，value 带上 name / isDir。
   * 存 Map 而不是 Set —— 拖拽 / 菜单需要 name 与 isDir，而选中的路径可能
   * 因为折叠已不在可见行里（那时从 rows 里查不到）。
   */
  const [selected, setSelected] = useState<Map<string, TreeMenuTarget>>(
    new Map(),
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  /** Shift 连选的锚点（最近一次单击的行） */
  const anchorRef = useRef<string | null>(null)
  const menu = useContextMenu<TreeMenuTarget>()
  /**
   * 行内重命名的待提交值。
   * 与 state 同步维护，但提交读的是这个 ref —— Enter 与随后的 blur 可能
   * 在同一帧内先后触发，只读 state 会拿到旧值，于是同一次重命名被提交两遍。
   */
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

  // 在 observer 渲染中读取，切换会话 / 换工作目录时能同步刷新
  const sessionId = chatState.value.currentSessionId
  const rawRoot = sessionId
    ? sessionStore.getSession(sessionId)?.workspace
    : chatState.value.selectedWorkspace
  const rootPath = normalizeTreePath(
    rawRoot || settingsState.value.defaultWorkspace || '',
  )

  /**
   * 读取某个目录的直接子项（覆盖写缓存）
   * @param silent 静默刷新：不置 loading、失败也不写 error，用于文件操作后的刷新（避免闪一下「加载中」）
   */
  const loadDir = useCallback(async (path: string, silent = false) => {
    if (!silent) {
      setDirs((prev) => ({
        ...prev,
        [path]: { ...prev[path], loading: true, error: undefined },
      }))
    }
    try {
      // invoke 返回 unknown，与 path-autocomplete 一致用 any[] 收口
      const raw: any[] = await invoke('list_directory', {
        root: path,
        recursive: false,
        includeHidden: false,
        maxDepth: 1,
        // 非递归模式下 Rust 不会下钻，skipEachDirs 无实际作用 → 传空
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
      // 静默刷新失败：保留旧内容，不打扰用户
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

  // 容器宽度 → 是否显示文件大小（侧边栏可拖拽调宽，必须动态量）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = () => setIsWide(el.clientWidth >= SIZE_MIN_CONTAINER_WIDTH)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootPath])

  /** 可见行（虚拟列表的输入）+ 「路径 → 行信息」索引（Shift 连选要用） */
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

  /** 文件操作后刷新：根目录 + 所有已展开目录（静默，不闪 loading） */
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

  /** 目录展开 / 折叠（首次展开触发懒加载；显式传 open 时不受当前态影响） */
  const toggleExpand = useCallback(
    (dirPath: string, open?: boolean) => {
      const next = open ?? !expanded[dirPath]
      if (next && !dirs[dirPath]?.entries && !dirs[dirPath]?.loading) {
        void loadDir(dirPath)
      }
      setExpanded((prev) => ({ ...prev, [dirPath]: next }))
    },
    [expanded, dirs, loadDir],
  )

  /** 用一批行覆盖选择集 */
  const setSelection = useCallback((targets: TreeMenuTarget[]) => {
    setSelected(new Map(targets.map((target) => [target.path, target])))
  }, [])

  /**
   * 单击 = 选中：
   *  - Ctrl/Cmd：加选 / 减选
   *  - Shift：从锚点连选到本行（只按可见行算，见 selectRangePaths）
   *  - 无修饰键：单选 +（目录）顺带展开 / 折叠
   * 带修饰键时**不**展开目录 —— 连选过程中可见行数一变，后续 Shift 范围就错位了。
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
    },
    [rows, rowMeta, setSelection, toggleExpand],
  )

  /** 目录 / 文件 → 输入框附件（双击、右键「引用」、拖到输入框共用） */
  const attachTargets = useCallback(
    (targets: TreeMenuTarget[], source: 'menu' | 'dblclick' | 'drag') => {
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
   * 拖到另一个目录 = 移动（整份选择集一起搬）。
   * 松手后**先确认再落盘**：移动真的会改磁盘位置，一次可能搬很多项，误拖的代价不小。
   */
  const handleMove = useCallback(
    async (items: TreeDragItem[], targetDir: string) => {
      // 已在目标目录里的条目不算「要搬的」（多选时才可能出现）：
      // 只对真正会发生位移的条目确认，否则弹窗里的条数与成功提示的条数对不上
      const pending = items.filter(
        (item) => parentDirOf(item.path) !== targetDir,
      )
      // 全部都在目标目录里（拖回原目录）→ 没有动作，弹「移动到 xxx」只会让人困惑
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
        sessionId || undefined,
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
    [sessionId, refreshAfterFileOp, setSelection],
  )

  const { startDrag, draggedRef } = useTreeDrag({
    onDropToInput: (items) => attachTargets(items, 'drag'),
    onDropIntoDir: (items, targetDir) => void handleMove(items, targetDir),
    // 落点合法性：不能拖到源自身或其子目录（高亮也据此决定）
    canDropIntoDir: (items, targetDir) =>
      canMoveInto(
        items.map((item) => item.path),
        targetDir,
      ),
  })

  /**
   * 按下：算出本次要拖的项交给 hook。
   *  - 命中的行已在选择集里 → 拖整份选择集
   *  - 不在 → 只拖它自己，并立即选上（等 click 再选的话，拖拽过程中就没有选中反馈）
   * 树根不参与移动（工作目录不能被搬进自己的子目录）。
   */
  const handleRowPointerDown = useCallback(
    (e: React.PointerEvent, row: TreeMenuTarget) => {
      // 按在按钮 / 输入框上（根目录的刷新按钮、行内重命名）不算拖拽
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
   * 双击 = 引用到输入框（打开类动作只留在右键菜单，避免误触）。
   * 命中的行在选择集里时，引用整份选择集。
   */
  const handleRowDoubleClick = useCallback(
    (row: TreeMenuTarget) => {
      if (draggedRef.current) {
        draggedRef.current = false
        return
      }
      attachTargets(
        selected.has(row.path) ? [...selected.values()] : [row],
        'dblclick',
      )
    },
    [selected, attachTargets, draggedRef],
  )

  /** 行点击：先看这一轮交互是不是拖拽（拖拽松手后浏览器仍会补一次 click） */
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
      const result = await fileTransferService.paste(dir, sessionId || undefined)
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
    [sessionId, refreshAfterFileOp],
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

      // 逐个删（不走并发）：删到一半失败时要能报出「成功几个、失败几个」
      let removed = 0
      let failed = 0
      let firstError = ''
      for (const target of targets) {
        const result = await fileTransferService.remove(
          target.path,
          sessionId || undefined,
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
    [sessionId, refreshAfterFileOp, setSelection],
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
      sessionId || undefined,
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
  }, [sessionId, refreshAfterFileOp, applyRenaming])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    overscan: TREE_OVERSCAN,
    getItemKey: (index) => rows[index]?.key ?? index,
  })

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
        // 目录行 = 拖拽的「移动落点」（hook 用 elementFromPoint + closest 命中它）
        data-tree-dir={row.isDir ? row.path : undefined}
        onContextMenu={(e) => {
          // 右键命中未选中的行 → 先把选择收敛到它，否则批量动作会作用在别处
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
            // Enter 等价于双击（引用），Space 等价于单击（选中 / 展开）
            if (e.key === 'Enter') {
              e.preventDefault()
              handleRowDoubleClick(target)
            } else if (e.key === ' ') {
              e.preventDefault()
              onRowClick(target, {})
            }
          }}>
          {row.isDir ? (
            // 箭头单独命中：点它只切展开，不改选择（否则整行 onClick 会再切一次 = 白点）
            <span
              className="tree-arrow-btn"
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(row.path)
              }}
              onDoubleClick={(e) => e.stopPropagation()}>
              <DropDownSvg
                className={`tree-arrow-icon ${isOpen ? '' : 'collapsed'}`}
              />
            </span>
          ) : (
            <span className="tree-arrow-placeholder" />
          )}
          {row.isDir ? (
            <FolderSvg className="tree-icon" />
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
              // 输入框在可点击行内，点它不能触发「选中 / 展开」；
              // 双击选词同样不能冒泡到行上（否则会变成「引用到输入框」）
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

  // ⚠️ 菜单项必须在渲染时就把 target / 选择集捕获进闭包：
  // ContextMenu 点击时会先 onClose（state 归 null）再执行 onClick，
  // 回调里再读 menu.state 会拿到 null。
  const menuTarget = menu.state?.target
  // 右键命中未选中的行时，上一行 onContextMenu 已把选择收敛到它，这里自然就是单选
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
    <div
      className={`workspace-tree${isWide ? ' is-wide' : ''}`}
      ref={scrollRef}>
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
 * MessageBox 的 text 支持传渲染函数（字符串会被 pre-wrap 直接铺开），
 * 路径要单独着色 / 折行，所以走 JSX。
 */
function MoveConfirmBody({
  targetDir,
  items,
}: {
  targetDir: string
  items: TreeDragItem[]
}) {
  /** 列名字的上限（再多就把弹窗炸了，剩下的用一句话概括） */
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
