/**
 * FileChip — 文件附件标签（输入框 / 消息气泡共用）
 *
 * 只承载「文件绝对路径」，不拷贝文件内容：
 *   [类型图标] 文件名 体积 [×]
 *
 * - hover 显示完整路径（路径才是这条数据的本体，必须可核对）
 * - 文件名过长时只省略主干，扩展名始终可见
 * - 传入 onClick 时主体可点击（消息气泡里用于打开文件）；传入 onRemove 时显示移除按钮
 */
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import { t, tpl } from '@/ui/i18n'
import type { MouseEvent } from 'react'
import './style.scss'

interface Props {
  /** 文件绝对路径 */
  path: string
  /** 展示用文件名（缺省从 path 取末段） */
  name?: string
  isDir?: boolean
  /** 文件字节数（目录无此值） */
  size?: number
  /** 点击主体（打开文件） */
  onClick?: () => void
  /** 右键（消息气泡里用于弹「打开 / 在文件管理器中显示 / 复制路径」菜单） */
  onContextMenu?: (ev: MouseEvent<HTMLSpanElement>) => void
  /** 移除该附件 */
  onRemove?: () => void
  className?: string
}

/** 从路径取文件名（兼容 / 与 \） */
export function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

/** 体积格式化（B/KB/MB/GB），空值返回空串 */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/** 拆出扩展名，让省略号只吃主干 */
function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

function FileChip({
  path,
  name,
  isDir,
  size,
  onClick,
  onContextMenu,
  onRemove,
  className,
}: Props) {
  const displayName = name || fileNameOf(path)
  const { base, ext } = splitName(displayName)
  const metaText = isDir ? t('文件夹') : formatFileSize(size)

  const body = (
    <>
      <span className="file-chip-icon">
        {isDir ? <FolderSvg /> : <FileTypeIcon filename={displayName} />}
      </span>
      <span className="file-chip-name">
        <span className="file-chip-name-base">{base}</span>
        {ext && <span className="file-chip-name-ext">{ext}</span>}
      </span>
      {metaText && <span className="file-chip-meta">{metaText}</span>}
    </>
  )

  return (
    <span
      className={`file-chip${isDir ? ' is-dir' : ''}${className ? ` ${className}` : ''}`}
      title={path}
      onContextMenu={onContextMenu}>
      {onClick ? (
        <button
          type="button"
          className="file-chip-body"
          onClick={onClick}
          aria-label={tpl('打开文件：$__path__', { path })}>
          {body}
        </button>
      ) : (
        <span className="file-chip-body">{body}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className="file-chip-remove"
          onClick={onRemove}
          title={t('移除文件')}
          aria-label={tpl('移除文件：$__path__', { path })}>
          ✕
        </button>
      )}
    </span>
  )
}

export default FileChip
