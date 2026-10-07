/**
 * path-autocomplete — 路径自动补全：输入 `@` 触发，列出工作目录下的文件 / 文件夹；
 * ↑↓ 导航、Enter 选中、Esc 关闭。数据来自 invoke('list_directory')。
 */
import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import { t } from '@/ui/i18n'

interface DirEntry {
  name: string
  type: 'file' | 'dir'
  size?: number | null
}

interface AutocompleteState {
  visible: boolean
  items: DirEntry[]
  /** 展示用的目录路径上下文（如 "C:/code/project/src/"） */
  dirLabel: string
  /** 当前目录相对工作区的路径前缀（如 "src/"），用于构建选中项 */
  relativePrefix: string
  loading: boolean
  error: string | null
  /** 当前目录下无任何条目（仍显示下拉，让用户能确认路径） */
  isEmptyDir: boolean
}

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

/** 路径自动补全 hook；cursorPos = 光标位置（selectionStart），workspace = 工作区根目录 */
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

  // 请求标识，用于丢弃过期结果
  const requestIdRef = useRef(0)

  /**
   * 从光标前的片段里提取 `@` 路径：`@src/main` → { dirPath: 'src/', prefix: 'main', dirLabel: '@src/' }；
   * 未检测到 `@` 返回 null。
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

    const afterAt = fragment.slice(atIdx + 1)
    const slashIdx = afterAt.lastIndexOf('/')

    const prefix = slashIdx >= 0 ? afterAt.slice(slashIdx + 1) : afterAt
    const dirPath = slashIdx >= 0 ? afterAt.slice(0, slashIdx + 1) : ''
    const dirLabel = '@' + (slashIdx >= 0 ? afterAt.slice(0, slashIdx + 1) : '')

    return { dirPath, prefix, dirLabel }
  }, [text, cursorPos])

  /** 是否绝对路径（Unix `/` 开头或 Windows 盘符） */
  const isAbsolutePath = (p: string): boolean =>
    p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)

  /** 读目录内容（实时读盘、不缓存，保证与磁盘同步） */
  const readDirectory = useCallback(
    async (dirPath: string, signal: AbortSignal): Promise<DirEntry[]> => {
      // 调用方已解析为完整路径
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

  /** 触发自动补全 */
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

      // 展示实际目录路径（如 "C:/code/project" 或 "C:/code/project/src/"）
      const displayLabel = dirPath ? parentDir + '/' : workspace

      // 进了子目录却无任何条目 = 空目录：仍显示下拉，让用户能通过「空目录」项确认路径并删掉 @
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

  /** 关闭自动补全 */
  const closeAutocomplete = useCallback(() => {
    setState((s) => ({ ...s, visible: false, items: [] }))
  }, [])

  /** 文本 / 光标 / 工作区变化 → 重新触发或关闭补全 */
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
function makeEmptyDirItem(): DirEntry {
  return {
    name: t('(空目录)'),
    type: 'dir',
    size: null,
  }
}

interface PathAutocompleteProps {
  /** 匹配的条目 */
  items: DirEntry[]
  /** 目录标签（如 "C:/code/project/src/"） */
  dirLabel: string
  /** 当前目录相对工作区的路径前缀（如 "src/"） */
  relativePrefix: string
  isEmptyDir: boolean
  /** 选中后的回调：传入完整路径 */
  onSelect: (fullPath: string) => void
  onClose: () => void
  /** 键盘导航的选中索引 */
  selectedIndex: number
  setSelectedIndex: (idx: number) => void
  /** 距离底部的偏移 px（避免遮挡 textarea） */
  bottomOffset?: number
}

/** 路径自动补全下拉菜单 */
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
  const displayItems = isEmptyDir ? [makeEmptyDirItem()] : items

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
