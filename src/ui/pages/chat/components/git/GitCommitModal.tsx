/**
 * GitCommitModal — 一条提交的详情：**头（短 hash / 标题 / 作者 / 时间）+ 完整提交信息 + 变更清单 + 差异**。
 *
 * 四条口径：
 * 1. **清单相对第一个父提交**（Rust `git::show` 已定死）：merge 提交相对谁看没有唯一答案，
 *    `git show` 给的是 combined diff（只有冲突那几行），不是「这个合并带来了什么」。界面上要把
 *    这件事说清楚 —— 有多个父时头里标一条提示，否则用户会以为「这个合并什么都没改」。
 * 2. **差异按文件按需取**（不缓存、关掉即弃）：一次拉整个提交的 diff，大提交上是几十 MB，
 *    而用户往往只看一两个文件（与 `GitDiffModal` 同一取舍）。
 * 3. **默认选中第一条**：点开提交总要先看到点什么；清单为空（空提交 / 纯合并）时给空态说明。
 * 4. 弹窗内的 `mousedown` 必须 `stopPropagation`、Esc / ↑↓ 走**捕获阶段**：本弹窗 portal 到 body，
 *    宿主（提交记录 / 提交图弹窗、源代码管理面板）的关闭逻辑都按 DOM 包含关系或 document 监听判定
 *    —— 少这两行就是「关详情连整个弹窗一起关掉」（与 `GitLogModal` 同款坑）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, tpl } from '@/ui/i18n'
import { baseName, dirName, singleSideOf } from '@/domain/git'
import type { GitCommitDetail, GitCommitFile, GitDiffSides } from '@/domain/git'
import { formatCommitTime } from '@/utils/time'
import FileTypeIcon from '@/ui/components/icons/FileTypeIcon'
import { MonacoDiffView } from '../message/MonacoDiffView'
import { loadCommitDetail, loadCommitFileSides } from '@/services/git-service'
import VirtualList from './VirtualList'
import { SideResizer, useSideWidth } from './use-side-width'

interface Props {
  oid: string
  onClose: () => void
}

/** 清单里一行的路径展示：改名要让人看见「从哪来」，否则会以为是两个无关文件 */
function fileTitle(file: GitCommitFile): string {
  return file.orig_path ? `${file.orig_path} → ${file.path}` : file.path
}

export function GitCommitModal({ oid, onClose }: Props) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<GitCommitFile | null>(null)
  const [sides, setSides] = useState<GitDiffSides | null>(null)
  const [sidesError, setSidesError] = useState<string | null>(null)
  const [sidesLoading, setSidesLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 左清单宽度（与差异弹窗共用一份偏好） */
  const sideWidth = useSideWidth()

  // ① 详情（头 + 清单）：打开时取一次
  useEffect(() => {
    let alive = true
    loadCommitDetail(oid)
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setCurrent(d.files[0] ?? null)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [oid])

  // ② 差异：换文件才重取（同一提交里没有第二个基准）
  useEffect(() => {
    if (!current) {
      setSides(null)
      return
    }
    let alive = true
    setSidesLoading(true)
    setSidesError(null)
    loadCommitFileSides(oid, current.path, current.orig_path)
      .then((data) => {
        if (alive) setSides(data)
      })
      .catch((e: unknown) => {
        if (alive) setSidesError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setSidesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [oid, current])

  const files = detail?.files ?? []
  /** 左清单虚拟列表的行高（与 `.git-diff-side-row` 的固定高度一致） */
  const fileHeights = useMemo(() => files.map(() => 24), [files])
  /** 清单扁平顺序（↑↓ 按它走） */
  const index = current ? files.findIndex((f) => f.path === current.path) : -1

  function step(delta: number): void {
    if (files.length === 0) return
    const next = files[index < 0 ? 0 : index + delta]
    if (next) setCurrent(next)
  }
  const stepRef = useRef(step)
  stepRef.current = step

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 只关详情，不冒泡（宿主的 Esc 监听会把整串弹窗都关掉）
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (!rootRef.current?.contains(document.activeElement)) return
      if (document.activeElement?.closest('.monaco-editor')) return
      e.preventDefault()
      e.stopPropagation()
      stepRef.current(e.key === 'ArrowDown' ? 1 : -1)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const singleSide = useMemo(() => (sides ? singleSideOf(sides) : null), [sides])
  const subject = detail?.message.split('\n')[0] || t('（无提交信息）')
  const body = detail?.message.trim() ?? ''

  return createPortal(
    <div
      className="git-diff-backdrop"
      // ⚠️ 必须 `stopPropagation`：宿主（提交记录 / 提交图 / 面板）的「点浮层外关闭」按 DOM 包含关系
      //    判定，而本弹窗嵌在它们的遮罩里 —— 不拦住就是「点一下详情的遮罩，整串弹窗全关」。
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}>
      <div
        className={`git-diff-modal git-commit-modal${sideWidth.resizing ? ' is-resizing' : ''}`}
        ref={rootRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="git-diff-head">
          <code className="git-commit-hash" title={detail?.oid ?? oid}>
            {detail?.short_oid ?? oid.slice(0, 7)}
          </code>
          <span className="git-diff-path" title={subject}>
            {subject}
          </span>
          {/* merge 提交：清单是「相对第一个父提交」的，不说清就会被当成本次合并的全部内容 */}
          {detail && detail.parents.length > 1 && (
            <span className="git-diff-note">{t('合并提交：变更相对第一个父提交')}</span>
          )}
          <button
            type="button"
            className="git-close"
            onClick={onClose}
            title={t('关闭')}>
            ✕
          </button>
        </div>

        <div className="git-commit-meta">
          {detail && (
            <span
              className="git-commit-author"
              title={`${detail.author_name} <${detail.author_email}>`}
            >
              {detail.author_name}
            </span>
          )}
          {detail && (
            <span className="git-commit-time" title={detail.author_time}>
              {formatCommitTime(detail.author_time) || detail.author_time}
            </span>
          )}
          {detail && files.length > 1 && (
            <span className="git-diff-note">
              {tpl('$__count__ 个文件有变更', { count: files.length })}
            </span>
          )}
        </div>

        {/* 完整提交信息（正文）：标题已经在头里，这里只在「有正文」时展开 */}
        {detail && body !== subject.trim() && (
          <pre className="git-commit-message">{body}</pre>
        )}

        <div className="git-diff-main">
          {error || !detail || files.length === 0 ? (
            <aside className="git-diff-side" style={{ width: sideWidth.width }}>
              {error && <div className="git-diff-message error">{error}</div>}
              {!error && !detail && (
                <div className="git-diff-message">{t('加载中…')}</div>
              )}
              {detail && files.length === 0 && (
                <div className="git-diff-message">
                  {t('这个提交没有文件变更')}
                </div>
              )}
            </aside>
          ) : (
            // 大提交（上千文件）不能一次性铺 DOM：左清单同样走虚拟列表
            <VirtualList
              className="git-diff-side"
              style={{ width: sideWidth.width }}
              items={files}
              heights={fileHeights}
              render={(file) => {
                const name = baseName(file.path)
                return (
                  <button
                    type="button"
                    key={`${file.status}:${file.path}`}
                    className={`git-diff-side-row${
                      file.path === current?.path ? ' active' : ''
                    }`}
                    title={fileTitle(file)}
                    onClick={() => setCurrent(file)}>
                    <FileTypeIcon
                      filename={name}
                      className="git-diff-side-icon"
                    />
                    <span className="git-diff-side-name">{name}</span>
                    <span className="git-diff-side-dir">
                      {/* 改名：旧路径也要看得见，否则以为「凭空多了个文件」 */}
                      {file.orig_path ? fileTitle(file) : dirName(file.path)}
                    </span>
                    <span className={`git-row-letter s-${file.status}`}>
                      {file.status}
                    </span>
                  </button>
                )
              }}
            />
          )}
          <SideResizer side={sideWidth} />

          <div className="git-diff-body">
            {!current && !error && detail && (
              <div className="git-diff-message">{t('这个提交没有文件变更')}</div>
            )}
            {current && sidesLoading && (
              <div className="git-diff-message">{t('加载中…')}</div>
            )}
            {sidesError && (
              <div className="git-diff-message error">{sidesError}</div>
            )}
            {current && !sidesLoading && !sidesError && sides?.binary && (
              <div className="git-diff-message">
                {t('二进制文件，无法显示差异')}
              </div>
            )}
            {current && !sidesLoading && !sidesError && sides && !sides.binary && (
              <MonacoDiffView
                oldText={sides.old_text ?? ''}
                newText={sides.new_text ?? ''}
                fileName={current.path}
                singleSide={singleSide ?? undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default GitCommitModal
