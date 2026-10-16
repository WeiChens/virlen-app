/**
 * GitLogModal — 提交记录（模态列表）：一行一条提交，四样东西一眼可见 ——
 * **提交时间 / 提交信息 / 提交用户 / 短 hash**（完整的 oid 与原始时间戳进 `title`，悬停可看）。
 *
 * 口径分两处（各只有一份实现，提交图弹窗共用同一份 —— §11.53 ⑰）：
 * 1. **分页 / 加载三态 / 空态 / 「加载更多」的判据**：`useCommitPages('head')`；
 * 2. **行的排布与四个字段的定宽对齐**：`GitCommitRow`。
 *
 * 本组件只剩三件自己的事：
 * - **范围是 HEAD 可达的提交**（`'head'`；提交图那份是 `'all'`）；
 * - **列表不缓存**：弹窗挂载才取数、关掉即弃 —— 刚提交完再打开必须看得见最新那条；
 * - **弹窗与宿主浮层的两条冲突**：本弹窗 portal 到 body，而宿主（源代码管理面板）的
 *   「点浮层外关闭」按 DOM 包含关系判定、Esc 监听挂在 document 上（§11.53 ⑱ / ㉝）——
 *   少这两行就是「点一下提交记录，连面板一起关掉」。
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/ui/i18n'
import GitCommitRow from './GitCommitRow'
import { useCommitPages } from './useCommitPages'

interface Props {
  onClose: () => void
}

export function GitLogModal({ onClose }: Props) {
  const { commits, loading, loadingMore, hasMore, error, loadMore } = useCommitPages('head')
  const rootRef = useRef<HTMLDivElement>(null)

  // Esc 只关弹窗：捕获阶段拦住，别让面板那颗 Esc 监听跟着把面板也关了
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 打开即把焦点收进弹窗（Esc 挂在 document 上不依赖焦点，这里是为了 Tab / 读屏有个起点）
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  return createPortal(
    <div className="git-diff-backdrop" onMouseDown={onClose}>
      <div
        className="git-log-modal"
        ref={rootRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="git-log-head">
          <span className="git-log-title">{t('提交记录')}</span>
          <span className="git-spacer" />
          <button
            type="button"
            className="git-close"
            onClick={onClose}
            title={t('关闭')}>
            ✕
          </button>
        </div>
        <div className="git-log-list">
          {loading && <div className="git-log-message">{t('加载中…')}</div>}
          {!loading && error && (
            <div className="git-log-message error">{error}</div>
          )}
          {!loading && !error && commits.length === 0 && (
            <div className="git-log-message">{t('没有提交记录')}</div>
          )}

          {commits.map((c) => (
            <GitCommitRow key={c.oid} entry={c} />
          ))}

          {!loading && hasMore && (
            <button
              type="button"
              className="git-log-more"
              disabled={loadingMore}
              onClick={loadMore}>
              {loadingMore ? t('加载中…') : t('加载更多')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default GitLogModal
