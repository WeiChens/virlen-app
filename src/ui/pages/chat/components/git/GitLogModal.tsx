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
 *
 * 行的右键菜单：项由 `commit-menu.ts` 组装（与提交图共用），菜单状态在本组件 ——
 * 一行一个菜单会让「上一次开的那个」留在屏上。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@/ui/i18n'
import { parseCommitRefs } from '@/domain/git'
import type { GitCommitLogEntry } from '@/domain/git'
import { gitStore } from '@/ui/store/gitStore'
import ContextMenu, { useContextMenu } from '@/ui/components/shared/ContextMenu'
import GitCommitRow from './GitCommitRow'
import GitCommitModal from './GitCommitModal'
import GitNewBranchPrompt from './GitNewBranchPrompt'
import { commitMenuItems } from './commit-menu'
import { useCommitPages } from './useCommitPages'

interface Props {
  /** 只读沙盒 / 有操作在跑 → 写入口禁用（Rust 侧同样会拒，这里是体验层） */
  disabled: boolean
  onClose: () => void
}

export function GitLogModal({ disabled, onClose }: Props) {
  /** 取数范围：本弹窗只列 HEAD 可达的提交 —— 右键菜单也靠它决定给不给「挑选」（见 `commit-menu`） */
  const SCOPE = 'head' as const
  const { commits, loading, loadingMore, hasMore, error, loadMore } = useCommitPages(SCOPE)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 打开的那条提交（`null` = 没开详情） */
  const [detailOid, setDetailOid] = useState<string | null>(null)
  /** 「在此提交上新建分支」针对的提交（`null` = 没开输入框） */
  const [newBranchAt, setNewBranchAt] = useState<GitCommitLogEntry | null>(null)
  /**
   * 内层弹窗（提交详情 / 新建分支）开着时 Esc 归它们管：本监听先于它们注册，
   * 抢先把这里关掉就是「Esc 关掉两层」。
   */
  const innerRef = useRef(false)
  innerRef.current = detailOid !== null || newBranchAt !== null
  /** 行右键菜单（目标行 = 被点的提交） */
  const menu = useContextMenu<GitCommitLogEntry>()

  // Esc 只关弹窗：捕获阶段拦住，别让面板那颗 Esc 监听跟着把面板也关了
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 内层弹窗开着时 Esc 归它们管（本监听先于它们注册，抢先把这里关掉就是「Esc 关掉两层」）
      if (innerRef.current) return
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

  /**
   * 右键菜单项：引用决定「切到分支 / 合并」给不给。
   * 提交记录视图**不画**引用标签（那是提交图的事），但菜单文案里带着分支名 —— 用户看得见自己点的是什么。
   */
  const menuTarget = menu.state?.target
  const menuItems = menuTarget
    ? commitMenuItems({
        entry: menuTarget,
        refs: parseCommitRefs(menuTarget.refs),
        currentBranch: gitStore.snapshot?.head.branch ?? null,
        isHead: gitStore.snapshot?.head.oid === menuTarget.oid,
        scope: SCOPE,
        disabled,
        // 菜单项只回答「被点了」：具体开哪一条在这里钉住（目标行的 oid / 那条提交）
        onOpen: () => setDetailOid(menuTarget.oid),
        onCreateBranch: () => setNewBranchAt(menuTarget),
      })
    : []

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
            <GitCommitRow
              key={c.oid}
              entry={c}
              onOpen={setDetailOid}
              onContextMenu={(e) => menu.openAt(e, c)}
            />
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

      {/* 行右键菜单：与 `.git-log-modal` 平级（Menu 自己 portal 到 body），点菜单项被当成
          「点弹窗外」的坑由 ContextMenu 在捕获阶段拦住 */}
      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={menuItems}
          onClose={menu.close}
        />
      )}

      {/* 详情弹窗嵌在这层遮罩里：它自己的遮罩会 `stopPropagation`，所以点它不会把提交记录一起关掉 */}
      {detailOid && (
        <GitCommitModal oid={detailOid} onClose={() => setDetailOid(null)} />
      )}

      {/* 新建分支的输入框（自己 portal 到 body，同样不影响这层遮罩的关闭判定） */}
      {newBranchAt && (
        <GitNewBranchPrompt
          oid={newBranchAt.oid}
          subject={newBranchAt.subject}
          disabled={disabled}
          onClose={() => setNewBranchAt(null)}
        />
      )}
    </div>,
    document.body,
  )
}

export default GitLogModal
