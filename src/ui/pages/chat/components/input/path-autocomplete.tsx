/**
 * path-autocomplete — 路径自动补全组件
 *
 * 在输入框中输入 "/" 时触发，列出当前工作目录的文件/文件夹选项，
 * 支持键盘导航（↑↓）、Enter 选中、Esc 关闭。
 *
 * 数据来源：Tauri invoke('list_directory', ...)
 */
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import { securityService } from '@/services/security-service'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'

// ==================== 工具类型 ====================

interface DirEntry {
  name: string
  type: 'file' | 'dir'
  size?: number | null
}

interface AutocompleteState {
  /** 是否显示下拉 */
  visible: boolean
  /** 匹配的条目 */
  items: DirEntry[]
  /** 目录前缀（用于展示路径上下文，如 "C:/code/project/src/"） */
  dirLabel: string
  /** 当前目录相对工作区的路径（如 "src/"，用于构建选中项的相对路径） */
  relativePrefix: string
  /** 正在加载 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 当前目录是否为空（没有任何文件和子目录） */
  isEmptyDir: boolean
}

// ==================== 工具函数 ====================

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / GB).toFixed(2)} GB`
}

/** 将 Rust DirEntryType 转为前端 type */
function mapDirEntryType(ty: string): 'file' | 'dir' {
  if (ty === 'dir' || ty === 'enter_dir') return 'dir'
  return 'file'
}

// ==================== Hook ====================

/**
 * 路径自动补全 hook
 *
 * @param text       当前输入框文本
 * @param cursorPos  光标位置（selectionStart）
 * @param workspace  当前工作区根目录
 * @returns          自动补全状态和控制方法
 */
export function usePathAutocomplete(
  text: string,
  cursorPos: number,
  workspace: string | null,
) {
  const [state, setState] = useState<AutocompleteState>({
    visible: false,
    items: [],
    dirLabel: '',
    relativePrefix: '',
    loading: false,
    error: null,
    isEmptyDir: false,
  })

  // 最近一次自动补全请求的标识，用于丢弃过期结果
  const requestIdRef = useRef(0)

  /**
   * 解析文本，提取路径片段
   * 以 @ 触发，@ 后面跟随路径（用 / 分隔）
   *
   * 例如 "读取 @src/main" → { dirPath: "src/", prefix: "main", dirLabel: "@src/" }
   * 例如 "读取 @src/"     → { dirPath: "src/", prefix: "",    dirLabel: "@src/" }
   * 例如 "读取 @"         → { dirPath: "",     prefix: "",    dirLabel: "@" }
   * 返回 null 表示未检测到 @ 输入
   */
  const parsePathFragment = useCallback((): {
    dirPath: string
    prefix: string
    dirLabel: string
  } | null => {
    const before = text.slice(0, cursorPos)

    // 找最后一个空格/换行后的内容
    const lastSpace = Math.max(
      before.lastIndexOf(' '),
      before.lastIndexOf('\n'),
      before.lastIndexOf('\t'),
    )
    const fragment = lastSpace >= 0 ? before.slice(lastSpace + 1) : before

    // 必须以 @ 触发
    const atIdx = fragment.lastIndexOf('@')
    if (atIdx < 0) return null

    // @ 后面的部分才是路径
    const afterAt = fragment.slice(atIdx + 1)
    const slashIdx = afterAt.lastIndexOf('/')

    const prefix = slashIdx >= 0 ? afterAt.slice(slashIdx + 1) : afterAt
    const dirPath = slashIdx >= 0 ? afterAt.slice(0, slashIdx + 1) : ''
    const dirLabel = '@' + (slashIdx >= 0 ? afterAt.slice(0, slashIdx + 1) : '')

    return { dirPath, prefix, dirLabel }
  }, [text, cursorPos])

  /**
   * 判断是否为绝对路径（Unix / 开头，Windows 盘符如 C:/ 开头）
   */
  const isAbsolutePath = (p: string): boolean =>
    p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)

  /**
   * 读取目录内容（实时从文件系统读取，不缓存，确保与磁盘状态同步）
   */
  const readDirectory = useCallback(
    async (dirPath: string, signal: AbortSignal): Promise<DirEntry[]> => {
      // triggerAutocomplete 已解析为完整路径，直接使用
      let fullDir: string
      if (isAbsolutePath(dirPath)) {
        fullDir = dirPath
      } else if (dirPath.startsWith('./')) {
        fullDir = workspace ? `${workspace}/${dirPath.slice(2)}` : dirPath
      } else if (dirPath) {
        fullDir = workspace ? `${workspace}/${dirPath}` : dirPath
      } else {
        fullDir = workspace || ''
      }

      // 标准化路径分隔符
      fullDir = fullDir.replace(/\\/g, '/')

      try {
        const entries: any[] = await invoke('list_directory', {
          root: fullDir,
          recursive: false,
          includeHidden: false,
          maxDepth: 1,
          skipEachDirs: [],
          taskId: `path_auto_${Date.now()}`,
        })

        if (signal.aborted) return []

        return entries
          .filter((e) => e.type === 'file' || e.type === 'dir')
          .map((e) => ({
            name: e.name,
            type: mapDirEntryType(e.type),
            size: e.size ?? undefined,
          }))
      } catch {
        return []
      }
    },
    [workspace],
  )

  /**
   * 触发自动补全
   */
  const triggerAutocomplete = useCallback(async () => {
    if (!workspace) {
      setState((s) => ({ ...s, visible: false }))
      return
    }

    const parsed = parsePathFragment()
    if (!parsed) {
      setState((s) => ({ ...s, visible: false }))
      return
    }

    const { dirPath, prefix, dirLabel } = parsed

    // 解析出真实的父目录路径
    let parentDir: string
    if (dirPath.startsWith('/') && !dirPath.startsWith('//')) {
      parentDir = dirPath // 绝对路径
    } else {
      parentDir = workspace + '/' + dirPath
    }
    parentDir = parentDir.replace(/\/+/g, '/').replace(/\/$/, '') || '/'

    setState((s) => ({ ...s, loading: true, error: null }))

    const rid = ++requestIdRef.current
    const abortController = new AbortController()

    try {
      const entries = await readDirectory(parentDir, abortController.signal)
      if (rid !== requestIdRef.current) return // 过期丢弃

      // 过滤匹配前缀
      const matched = entries.filter(
        (e) => !prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase()),
      )

      // 显示实际目录路径（如 "C:/code/project" 或 "C:/code/project/src/"）
      const displayLabel = dirPath ? parentDir + '/' : workspace

      // 如果已经进入了子目录（dirPath 非空）但没有任何条目，说明是个空目录
      // 此时仍然显示下拉，让用户可以通过"空目录"选项来确认路径并删除 @
      const isEmptyDir = matched.length === 0 && dirPath !== ''

      setState({
        visible: matched.length > 0 || isEmptyDir,
        items: matched.slice(0, 50), // 最多 50 项
        dirLabel: displayLabel,
        relativePrefix: dirPath, // 如 "src/" 或 ""
        loading: false,
        error: null,
        isEmptyDir,
      })
    } catch {
      if (rid === requestIdRef.current) {
        setState((s) => ({ ...s, visible: false, loading: false }))
      }
    }
  }, [workspace, parsePathFragment, readDirectory])

  /**
   * 关闭自动补全
   */
  const closeAutocomplete = useCallback(() => {
    setState((s) => ({ ...s, visible: false, items: [] }))
  }, [])

  /**
   * 路径变化时重新触发自动补全
   */
  useEffect(() => {
    if (!text || !workspace) {
      closeAutocomplete()
      return
    }

    const parsed = parsePathFragment()
    if (parsed) {
      triggerAutocomplete()
    } else {
      closeAutocomplete()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, cursorPos, workspace])

  return {
    ...state,
    closeAutocomplete,
  }
}

/** 空目录虚拟条目，供 PathAutocomplete 展示 */
const EMPTY_DIR_ITEM: DirEntry = {
  name: '(空目录)',
  type: 'dir',
  size: null,
}

// ==================== 组件 ====================

interface PathAutocompleteProps {
  /** 匹配的条目 */
  items: DirEntry[]
  /** 目录标签（如 "C:/code/project/src/"） */
  dirLabel: string
  /** 当前目录相对工作区的路径前缀（如 "src/"），用于构建目录项的显示路径 */
  relativePrefix: string
  /** 当前目录是否为空（没有任何文件和子目录） */
  isEmptyDir: boolean
  /** 选中后的回调：传入完整路径 */
  onSelect: (fullPath: string) => void
  /** 关闭 */
  onClose: () => void
  /** 选中的索引（键盘导航用） */
  selectedIndex: number
  /** 设置选中索引 */
  setSelectedIndex: (idx: number) => void
  /** 距离底部的偏移 px（避免遮挡 textarea） */
  bottomOffset?: number
}

/**
 * 路径自动补全下拉菜单
 */
export function PathAutocomplete({
  items,
  dirLabel,
  relativePrefix,
  isEmptyDir,
  onSelect,
  onClose,
  selectedIndex,
  setSelectedIndex,
  bottomOffset = 0,
}: PathAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // 选中项滚动到可见区域
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // 空目录时，显示一个虚拟条目供用户确认路径
  const displayItems = isEmptyDir ? [EMPTY_DIR_ITEM] : items

  if (items.length === 0 && !isEmptyDir) return null

  return (
    <div
      className="path-autocomplete"
      style={{ bottom: bottomOffset > 0 ? `${bottomOffset}px` : undefined }}>
      <div className="path-autocomplete-header">
        当前目录：{dirLabel || '/'}
      </div>
      <div className="path-autocomplete-list" ref={listRef}>
        {displayItems.map((item, idx) => {
          const isVirtualEmpty = isEmptyDir
          return (
            <div
              key={item.name + (item.type === 'dir' ? '/' : '')}
              className={`path-autocomplete-item ${idx === selectedIndex ? 'selected' : ''} ${isVirtualEmpty ? 'path-autocomplete-item-empty' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                // 空目录条目：传入空字符串，父组件会据此删除 @
                onSelect(isVirtualEmpty ? '' : item.name + (item.type === 'dir' ? '/' : ''))
              }}
              onMouseEnter={() => setSelectedIndex(idx)}>
              {isVirtualEmpty ? (
                <>
                  <span className="path-autocomplete-icon">
                    <FolderSvg className="path-icon" fill="currentColor" />
                  </span>
                  <span className="path-autocomplete-name-wrap">
                    <span className="path-autocomplete-name">{item.name}</span>
                    <span className="path-autocomplete-suffix">
                      {relativePrefix}
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <span className="path-autocomplete-icon">
                    {item.type === 'dir' ? (
                      <FolderSvg className="path-icon" fill="currentColor" />
                    ) : (
                      <FileTypeIcon filename={item.name} className="path-icon" />
                    )}
                  </span>
                  <span className="path-autocomplete-name-wrap">
                    <span className="path-autocomplete-name">{item.name}</span>
                    {item.type === 'dir' && (
                      <span className="path-autocomplete-suffix">
                        {relativePrefix}{item.name}/
                      </span>
                    )}
                  </span>
                  {item.size != null && (
                    <span className="path-autocomplete-size">
                      {formatSize(item.size)}
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
