/**
 * GitLogModal — 提交记录（模态列表）：一行一条提交，四样东西一眼可见 ——
 * **提交时间 / 提交信息 / 提交用户 / 短 hash**（完整的 oid 与原始时间戳进 `title`，悬停可看）。
 *
 * 六条口径：
 * 1. **分页**：「加载更多」按 `skip` 往前推（Rust 侧无状态、不缓存），**拿回不足一页**就说明到底了
 *    —— 只在「可能还有」时显示那颗按钮，不给用户一个点下去毫无反应的入口；
 * 2. **列表不缓存**：关掉即弃（与差异正文同一取舍）—— 刚提交完再打开必须看得见最新那条；
 * 3. **只显示标题**：Rust 只回 `%s`（单行），列表要的不是整段信息 —— 正文要看时再单独取（本轮不做展开）；
 * 4. **时间走相对口径**（`formatCommitTime`，唯一实现）：几分钟前 / 几小时前 / 昨天 / N 天前，
 *    超过一周才给 `2026-10-09 00:53`。⚠️ 相对文案在**渲染时**算一次，不自动走秒（弹窗是短暂形态，
 *    悬停的 `title` 里始终有原始时间戳）；
 * 5. **时间列定宽**（`style.scss` 里那一处 `width: 100px`）：相对 / 绝对两种文案的长短差很多
 *    （`刚刚` 与 `2026-10-09 00:53`），不定宽则**右侧三列的左边界会逐行浮动**、用户名看上去参差不齐；
 *    定宽 + 右对齐 + 等宽数字后，用户名的右边界与时间 / hash 两列都对齐；
 * 6. **弹窗内的 mousedown 必须 `stopPropagation`**：本弹窗 portal 到 body，而宿主（源代码管理面板）
 *    的「点浮层外关闭」按 DOM 包含关系判定（§11.53 ⑱）—— 少这一行就是「点一下提交记录，连面板一起关掉」。
 *    同理 Esc 走**捕获阶段**并拦住冒泡，否则面板那个 Esc 监听会把面板连同弹窗一起关掉。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/ui/i18n'
import { formatCommitTime } from '@/utils/time'
import type { GitCommitLogEntry } from '@/domain/git'
import { LOG_PAGE_SIZE, loadCommits } from '@/services/git-service'

interface Props {
  onClose: () => void
}

export function GitLogModal({ onClose }: Props) {
  const [commits, setCommits] = useState<GitCommitLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  /**
   * 一页落地（首屏与「加载更多」**共用这条出口**）：还有没有下一页的口径只有这一处 ——
   * 拿回整页意味着「可能还有」，不足一页就是到底了。
   */
  function accept(page: GitCommitLogEntry[], append: boolean): void {
    setCommits((prev) => (append ? [...prev, ...page] : page))
    setHasMore(page.length >= LOG_PAGE_SIZE)
  }

  function fail(e: unknown): void {
    setError(e instanceof Error ? e.message : String(e))
    setHasMore(false)
  }

  // 打开时取第一页。依赖故意为空：弹窗由 `open &&` 挂载，换目录 / 重开会整块重建（GitEntry），
  // 这里只需要「挂载这一次」。
  useEffect(() => {
    let alive = true
    loadCommits(0)
      .then((page) => {
        if (alive) accept(page, false)
      })
      .catch((e: unknown) => {
        if (alive) fail(e)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

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

  async function loadMore(): Promise<void> {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      // skip = 已经拿过的条数：分页状态就是列表长度本身，没有第二份要同步的计数
      accept(await loadCommits(commits.length), true)
    } catch (e) {
      fail(e)
    } finally {
      setLoadingMore(false)
    }
  }

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

          {commits.map((c) => {
            const time = formatCommitTime(c.author_time)
            return (
              <div className="git-log-row" key={c.oid}>
                <span className="git-log-subject" title={c.subject}>
                  {/* 空标题（`--allow-empty-message`）给个占位，免得画出一条什么都没有的行 */}
                  {c.subject || t('（无提交信息）')}
                </span>
                <span className="git-log-meta">
                  {/* 悬停给出「名字 <邮箱>」：名字被定宽截断时还看得到全名 */}
                  <span
                    className="git-log-author"
                    title={`${c.author_name} <${c.author_email}>`}>
                    {c.author_name}
                  </span>
                  <span className="git-log-time" title={c.author_time}>
                    {/* 解析不出来的时间戳照原样显示（宁可是个怪字符串，也不是一个假时间） */}
                    {time || c.author_time}
                  </span>
                  <code className="git-log-hash" title={c.oid}>
                    {c.short_oid}
                  </code>
                </span>
              </div>
            )
          })}

          {!loading && hasMore && (
            <button
              type="button"
              className="git-log-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}>
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
