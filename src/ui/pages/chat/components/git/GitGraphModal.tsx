/**
 * GitGraphModal — 提交图弹窗：左边是图（一个点 = 一次提交、一条线 = 父子关系），右边是提交行。
 *
 * 五条口径：
 * 1. **取全部分支**（`useCommitPages('all')`）：只走 HEAD 就只有一条直线，「分支关系」根本不会出现。
 *    范围本身由 Rust 定（`--branches --tags --remotes HEAD`，**不含** `refs/stash`，见 `LogScope`）；
 * 2. **页大小 200**（`GRAPH_PAGE_SIZE`）：首页要装得下各分支头 —— 50 条常常只够覆盖当前分支最近一串；
 * 3. **图的列由布局纯函数算**（`layoutGraph`），**追加一页就整份重算**：父提交可能刚被翻出来，
 *    上一页尾部的开口线要接上（增量打补丁式的更新会留下一堆接不上的线头）；
 * 4. **线与点画在列表上层的 canvas 上**（绝对定位、`pointer-events: none`），行里只留出**本行**的空位
 *    （`graphGeometry().rowGutters`：**列宽取整份布局那一份**，不能按本行占几列反算 —— 见 §11.53 ㊱⑪）
 *    —— 只按「本窗口最宽那一行」留位会让每一行都白白空出几百像素（30 个分支逐个 Merge 的仓库
 *    实测 229px，见 `domain/git/graph.ts` 模块头第 4 条）；
 *    两边的对齐靠「同一个行高常量」，见 `GraphCanvas` 的口径 1；
 * 5. **弹窗内的 mousedown 必须 `stopPropagation`、Esc 走捕获阶段**：本弹窗 portal 到 body，
 *    宿主（源代码管理面板）的「点浮层外关闭」与 Esc 监听都会把它当成自己该管的事（§11.53 ⑱ / ㉝）。
 *
 * 行的右键菜单：项由 `commit-menu.ts` 组装（与提交记录共用）—— 图形态里“点落在哪个分支上”能直接
 * 变成「切到它 / 把它合进来」，这正是提交图存在的意义。菜单状态在本组件（一行一个会留在屏上）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, tpl } from '@/ui/i18n'
import { gitStore } from '@/ui/store/gitStore'
import ContextMenu, { useContextMenu } from '@/ui/components/shared/ContextMenu'
import { commitMenuItems } from './commit-menu'
import { GRAPH_PAD_X, graphGeometry, layoutGraph, parseCommitRefs } from '@/domain/git'
import type { GitCommitLogEntry } from '@/domain/git'
import GraphCanvas from './GraphCanvas'
import GitCommitRow from './GitCommitRow'
import GitCommitModal from './GitCommitModal'
import GitNewBranchPrompt from './GitNewBranchPrompt'
import { useCommitPages } from './useCommitPages'

interface Props {
  /** 只读沙盒 / 有操作在跑 → 写入口禁用（Rust 侧同样会拒，这里是体验层） */
  disabled: boolean
  onClose: () => void
}

export function GitGraphModal({ disabled, onClose }: Props) {
  /** 取数范围：全部分支 —— 右键的「挑选」只在这个范围里才有意义（见 `commit-menu`） */
  const SCOPE = 'all' as const
  const { commits, loading, loadingMore, hasMore, error, loadMore } = useCommitPages(SCOPE)
  const listRef = useRef<HTMLDivElement>(null)
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

  // 布局只跟「提交 + 父」有关：把整条记录折成最小子集交给纯函数（它也吃不到多余字段）
  const layout = useMemo(
    () => layoutGraph(commits.map((c) => ({ oid: c.oid, parents: c.parents }))),
    [commits],
  )
  // 行内的左空位宽度 = **本行**画到的列数 × **整份布局**的列宽（唯一出口 `graphGeometry`）：
  //   ① 不是整窗口最宽那一行（那会让只用一列的行也空出几百像素 —— 用户看到的「图与文字之间一大片留白」）；
  //   ② 列宽也不能按本行反算（密集窗口里 `laneWidth(11)` = 14px 而窗口实际 7px，每行白空 60–85px）
  const geometry = useMemo(() => graphGeometry(layout), [layout])

  // Esc 只关弹窗：捕获阶段拦住，别让面板那颗 Esc 监听把面板一起关了
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

  /** 右键菜单项：引用已解析（与行上的标签同一份口径），当前分支 / HEAD 判定决定给哪几项 */
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
        className="git-log-modal git-graph-modal"
        ref={rootRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="git-log-head">
          <span className="git-log-title">{t('提交图')}</span>
          {!loading && !error && commits.length > 0 && (
            // 已加载多少条要说清楚：线在底部断掉是「还没加载到」，不是「历史到此为止」
            <span className="git-graph-count">
              {tpl('已加载 $__count__ 条提交', { count: commits.length })}
            </span>
          )}
          <span className="git-spacer" />
          <button type="button" className="git-close" onClick={onClose} title={t('关闭')}>
            ✕
          </button>
        </div>
        <div className="git-graph-body">
          <GraphCanvas
            layout={layout}
            headOid={gitStore.snapshot?.head.oid ?? null}
            listRef={listRef}
            label={t('提交图：一个点是一次提交，一条线是父子关系')}
          />
          {/* ⚠️ 图形态里列表**不能有上内边距**：canvas 的行坐标是从内容盒顶边算的，
              多出来的 padding 会让整张图与文字逐行错开（与 `.git-log-list` 的共用样式见 style.scss） */}
          <div className="git-log-list git-graph-list" ref={listRef}>
            {loading && <div className="git-log-message">{t('加载中…')}</div>}
            {!loading && error && <div className="git-log-message error">{error}</div>}
            {!loading && !error && commits.length === 0 && (
              <div className="git-log-message">{t('没有提交记录')}</div>
            )}

            {commits.map((c, i) => (
              <GitCommitRow
                key={c.oid}
                entry={c}
                onOpen={setDetailOid}
                onContextMenu={(e) => menu.openAt(e, c)}
                // 行与布局一一对应（`layoutGraph` 每条提交产一行）；万一取不到就按一列宽兜底，
                // 不让它变成 0（宽度为 0 时**线会压在字上** —— canvas 在行之上，见 style.scss）
                gutter={geometry.rowGutters[i] ?? GRAPH_PAD_X * 2 + geometry.laneWidth}
                refs={parseCommitRefs(c.refs)}
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

      {/* 详情弹窗嵌在这层遮罩里：它自己的遮罩会 `stopPropagation`，所以点它不会把提交图一起关掉 */}
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

export default GitGraphModal
