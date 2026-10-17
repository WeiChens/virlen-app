/**
 * GitPanel — 仓库头（分支 / ahead-behind / 提交记录 / 提交图 / 刷新）+ 三段变更列表 + 提交区。
 *
 * 顺序：**变更列表在前、提交区在最下面**（先看改了什么再写信息）；段顺序为
 * 「更改（含未跟踪）→ 暂存的更改 → 冲突」—— 三段口径与差异弹窗共用 `sections.ts`（冲突段无批量入口）。
 * 提交区只在暂存区非空时出现。
 * 选中模式同资源管理器：单击选中、Ctrl 加减、Shift 范围，**双击**才开差异。
 * 行内操作在该行属于选中集时作用于同侧全部（按钮文案带数量）。
 * 只读沙盒下所有写入口禁用（Rust 侧同样会拒，这里是双保险）。
 */
import { useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { runInAction } from 'mobx'
import { t, tpl } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import { gitStore } from '@/ui/store/gitStore'
import { groupChanges, statOf, statTotals } from '@/domain/git'
import {
  commit,
  discard,
  loadCommitDetail,
  refreshBranches,
  refreshRemotes,
  refreshStatus,
  stage,
  syncNow,
  undoLastCommit,
  unstage,
} from '@/services/git-service'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'
import RefreshSvg from '@/ui/components/icons/RefreshSvg'
import HistorySvg from '@/ui/components/icons/HistorySvg'
import GraphSvg from '@/ui/components/icons/GraphSvg'
import MoreSvg from '@/ui/components/icons/MoreSvg'
import GitChangeRow, { type GitRowTarget } from './GitChangeRow'
import GitBranchMenu from './GitBranchMenu'
import GitSyncMenu from './GitSyncMenu'
import GitDiffModal from './GitDiffModal'
import GitLogModal from './GitLogModal'
import GitGraphModal from './GitGraphModal'
import { changeSections, rowKey, splitRowKey } from './sections'
import VirtualList from './VirtualList'

interface Props {
  onClose: () => void
}

/** 段标题与文件行**分开两个滚动容器**：标题挂在段自己的列表外（固定），只有文件行在 `.git-list` 里滚 ——
    滚一长段时那一段的标题与「全部暂存」不会跑掉，两段也各自从顶部开始滚。 */

/** 行高（px）—— 虚拟列表靠它算前缀和，**必须与 `.git-list .git-row` 一致**：
    24 是行内那颗 22px 按钮的下限（20px 时按钮会被裁掉半截） */
const ROW_H = 24

/** 输出块（hooks / 网络进度）：`pre` 等宽、限高滚动，两处共用。 */
function OutputBlock({
  title,
  text,
  onClose,
}: {
  title: string
  text: string
  onClose: () => void
}) {
  return (
    <div className="git-hook-output">
      <div className="git-hook-head">
        <span>{title}</span>
        <span className="git-spacer" />
        <button type="button" className="git-close" title={t('关闭')} onClick={onClose}>
          ✕
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  )
}

export const GitPanel = observer(function GitPanel({ onClose }: Props) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [diffTarget, setDiffTarget] = useState<GitRowTarget | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  /** 远程浮层（获取 / 拉取 / 推送 / 测试连接） */
  const [syncMenuOpen, setSyncMenuOpen] = useState(false)
  /** 选中集（键 = `rowKey`，保持点击先后）；`anchorRef` 是 Shift 范围选择的起点 */
  const [selected, setSelected] = useState<string[]>([])
  const anchorRef = useRef<string | null>(null)
  /** 「修改上一次提交」：开着时提交走 `--amend`（改信息 / 把暂存内容并入上一条） */
  const [amend, setAmend] = useState(false)
  /** 头部「更多」菜单：同步浮层 / 撤销上次提交 / 修改上一次提交 —— 三者都不常用，常驻会挤掉分支名 */
  const more = useContextMenu()
  const moreBtnRef = useRef<HTMLButtonElement>(null)

  const snapshot = gitStore.snapshot
  const groups = groupChanges(snapshot)
  /** 行数统计（只在面板打开时取；没回来时 `null`，行内就不画数字） */
  const stats = gitStore.stats
  const totals = statTotals(snapshot, stats)
  const readonly = settingsState.value.sandboxMode === 'readonly'
  const busy = gitStore.busy !== null
  const disabled = readonly || busy
  const head = snapshot?.head

  const sections = changeSections(groups, {
    stage: (paths) => void stage(paths),
    unstage: (paths) => void unstage(paths),
  })

  /** 当前快照的行键（顺序即列表顺序）；写操作后行会换段/消失，选中集要按它对账。 */
  const flatKeys = sections.flatMap((section) =>
    section.entries.map((entry) => rowKey(section.side, entry.path)),
  )
  const selectedLive = selected.filter((key) => flatKeys.includes(key))
  const selectedSet = new Set(selectedLive)

  /** 每段一份行高数组（全是 `ROW_H`）：两段是两个独立滚动容器，各自只切自己的窗口 */
  const sectionLists = useMemo(
    () =>
      sections
        .filter((section) => section.entries.length > 0)
        .map((section) => ({
          section,
          heights: section.entries.map(() => ROW_H),
        })),
    [sections],
  )

  /** 单击选中 / Ctrl-Cmd 加减 / Shift 取一段；锚点只在单击与 Ctrl 时挪动。 */
  function selectRow(key: string, mod: { shift: boolean; toggle: boolean }): void {
    if (mod.shift && anchorRef.current) {
      const from = flatKeys.indexOf(anchorRef.current)
      const to = flatKeys.indexOf(key)
      if (from >= 0 && to >= 0) {
        const range = flatKeys.slice(Math.min(from, to), Math.max(from, to) + 1)
        setSelected(mod.toggle ? [...new Set([...selectedLive, ...range])] : range)
        return
      }
    }
    if (mod.toggle) {
      setSelected(
        selectedLive.includes(key)
          ? selectedLive.filter((k) => k !== key)
          : [...selectedLive, key],
      )
    } else {
      setSelected([key])
    }
    anchorRef.current = key
  }

  /** 行内操作的作用对象：该行在选中集 → 同侧选中的全部，否则只它自己。 */
  function actionPaths(key: string, side: 'staged' | 'unstaged'): string[] {
    const keys = selectedSet.has(key) ? selectedLive : [key]
    const paths = keys
      .map(splitRowKey)
      .filter((row) => row.side === side)
      .map((row) => row.path)
    return [...new Set(paths)]
  }

  /**
   * 分支浮层开关，分支按钮与「游离 HEAD」徽标共用。
   * ⚠️ 切到远程分支会 detach（`branch === null`），那时只有徽标能打开浮层切回本地。
   */
  function toggleBranchMenu(): void {
    if (!branchMenuOpen) void refreshBranches()
    setBranchMenuOpen((v) => !v)
  }

  /** 切 amend：打开时草稿为空则回填上一条提交信息（amend 最常见的用途就是改信息）。 */
  async function toggleAmend(next: boolean): Promise<void> {
    setAmend(next)
    const oid = head?.oid
    if (!next || !oid || gitStore.commitDraft.trim()) return
    try {
      const detail = await loadCommitDetail(oid)
      runInAction(() => {
        // 期间用户可能已经开始写：只在仍为空时回填
        if (!gitStore.commitDraft.trim()) gitStore.commitDraft = detail.message
      })
    } catch {
      // 回填只是便利，取不到不必打断提交
    }
  }

  /**
   * 「更多」菜单的展开位置取自按钮本身（右下角对齐）—— 不从鼠标事件来，所以用 `openAtPoint`；
   * `anchorElement` 让「再点一次」走 toggle（否则 mousedown 先关、click 又开，看着像点不动）。
   */
  function toggleMoreMenu(): void {
    if (more.state) {
      more.close()
      return
    }
    const rect = moreBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    more.openAtPoint({ x: rect.right, y: rect.bottom + 4 }, undefined)
  }

  /** 头部菜单项：高频动作仍是分支 / 落差 / 记录 / 图 / 刷新，这里只放不常用的三个 */
  function moreItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        key: 'sync',
        label: t('同步远程（获取 / 拉取 / 推送）'),
        // 开浮层本身是读操作，只读沙盒下也能看地址、测连接
        disabled: busy,
        onClick: () => {
          if (!syncMenuOpen) void refreshRemotes()
          setSyncMenuOpen(true)
        },
      },
    ]
    // 撤销只在**有提交**时出现（空仓库里它没有意义）
    if (head?.oid) {
      items.push({
        key: 'undo',
        label: t('撤销上次提交'),
        disabled,
        onClick: () => void undoLastCommit(),
      })
    }
    items.push({
      key: 'amend',
      label: `${amend ? '✓ ' : ''}${t('修改上一次提交')}`,
      divider: true,
      // amend 改的是**上一条**：没有提交就无从谈起
      disabled: disabled || !head?.oid,
      onClick: () => void toggleAmend(!amend),
    })
    return items
  }

  const nothingToShow =
    !!snapshot &&
    groups.staged.length === 0 &&
    groups.unstaged.length === 0 &&
    groups.untracked.length === 0 &&
    groups.conflicts.length === 0

  return (
    <>
      <div className="git-head">
        <span className="git-head-title">{t('源代码管理')}</span>
        {readonly && (
          <span className="git-section-count">{t('只读沙盒模式')}</span>
        )}
        <span className="git-spacer" />
        <button
          type="button"
          className="git-close"
          onClick={onClose}
          title={t('关闭')}>
          ✕
        </button>
      </div>

      {!gitStore.probed && <div className="git-empty">{t('加载中…')}</div>}

      {gitStore.probed && gitStore.unavailable && (
        <div className="git-empty">{gitStore.unavailable}</div>
      )}

      {gitStore.repo && (
        <>
          {/* 面板覆盖的是**整个仓库**（不是只有当前工作目录）：路径一律仓库根相对，悬停可看仓库在哪 */}
          <div
            className="git-repo-bar"
            title={tpl('仓库：$__path__', { path: gitStore.repo.root })}>
            {head?.branch ? (
              <button
                type="button"
                className="git-branch-btn"
                disabled={disabled}
                onClick={toggleBranchMenu}
                title={t('切换分支')}>
                <span className="git-branch-name">{head.branch}</span>
              </button>
            ) : (
              // 游离 HEAD / 空仓库：没有分支名可点，改用一个明确的状态徽标
              // （它同样能点开分支浮层，见 `toggleBranchMenu`）
              <button
                type="button"
                className="git-detached"
                disabled={disabled}
                onClick={toggleBranchMenu}
                title={t('切换分支')}>
                {head ? t('游离 HEAD') : t('读取中…')}
              </button>
            )}
            {/* 落差状态按钮：显示 ↑超前 ↓落后，**点它就是一次同步**（先拉取快进、再推送）。
                只摆两个数字等于告诉用户「有事」却不给下一步；这里把下一步做成同一个控件。 */}
            {head && (head.ahead > 0 || head.behind > 0) && (
              <button
                type="button"
                className="git-track"
                disabled={disabled || !head.branch}
                title={
                  head.upstream
                    ? tpl('点击同步：先拉取再推送 $__upstream__', {
                      upstream: head.upstream,
                    })
                    : t('点击同步：先拉取再推送')
                }
                onClick={() => void syncNow()}>
                ↑{head.ahead} ↓{head.behind}
              </button>
            )}
            <span className="git-spacer" />
            {/* 仓库级入口：提交记录 / 提交图（都是读操作，不受只读沙盒与 busy 影响） */}
            <button
              type="button"
              className="git-icon-btn"
              title={t('提交记录')}
              aria-label={t('提交记录')}
              onClick={() => setLogOpen(true)}>
              <HistorySvg />
            </button>
            <button
              type="button"
              className="git-icon-btn"
              title={t('提交图')}
              aria-label={t('提交图')}
              onClick={() => setGraphOpen(true)}>
              <GraphSvg />
            </button>
            <button
              type="button"
              className="git-icon-btn"
              title={t('刷新')}
              aria-label={t('刷新')}
              disabled={busy}
              onClick={() => void refreshStatus()}>
              <RefreshSvg />
            </button>
            {/* 更多：同步浮层 / 撤销上次提交 / 修改上一次提交 —— 不常用的动作收进来，
                免得把分支名与落差数字挤掉（面板内容宽只有 496px）。 */}
            <button
              ref={moreBtnRef}
              type="button"
              className={`git-icon-btn${more.state ? ' is-active' : ''}`}
              title={t('更多')}
              aria-label={t('更多')}
              aria-haspopup="menu"
              aria-expanded={!!more.state}
              onClick={toggleMoreMenu}>
              <MoreSvg />
            </button>
          </div>

          {more.state && (
            <ContextMenu
              position={more.state.position}
              placement="bottom-left"
              anchorElement={moreBtnRef.current}
              items={moreItems()}
              onClose={more.close}
            />
          )}
        </>
      )}

      {gitStore.error && <div className="git-empty error">{gitStore.error}</div>}

      {/* 提交时 git 的 stderr（hooks / 警告）：正常为空，出现即有事要说 */}
      {gitStore.hookOutput && (
        <OutputBlock
          title={t('提交输出（hooks / 警告）')}
          text={gitStore.hookOutput}
          onClose={() =>
            runInAction(() => {
              gitStore.hookOutput = null
            })
          }
        />
      )}

      {/* 网络操作的输出（fetch / pull / push 的进度与摘要）—— 与上一条块同形，来源不同 */}
      {gitStore.syncOutput && (
        <OutputBlock
          title={t('操作输出')}
          text={gitStore.syncOutput}
          onClose={() =>
            runInAction(() => {
              gitStore.syncOutput = null
            })
          }
        />
      )}

      {/* 行数汇总（每一行也各有「+a −d」）：文件数来自快照（统计没回来时也准），行数来自统计 */}
      {gitStore.repo && totals.files > 0 && (
        <div
          className="git-stats-summary"
          title={t('未跟踪文件按全文新增计；二进制与冲突文件不计入行数')}>
          <span>{tpl('已编辑 $__count__ 个文件', { count: totals.files })}</span>
          <span className="git-spacer" />
          {stats && (
            <>
              <span className="git-stat-add">+{totals.added}</span>
              <span className="git-stat-del">−{totals.deleted}</span>
              {/* 有文件数不出来（二进制 / 冲突）→ 合计只是「已知部分」，用省略号说清楚 */}
              {totals.partial && <span className="git-stat-more">…</span>}
            </>
          )}
        </div>
      )}

      {gitStore.repo && (
        <>
          {nothingToShow && (
            <div className="git-list">
              <div className="git-empty">{t('没有更改')}</div>
            </div>
          )}

          {sectionLists.length > 0 && (
            <div className="git-list-box">
              {sectionLists.map(({ section, heights }) => (
                <section className="git-section" key={section.key}>
                  {/* 段标题在这一段自己的滚动列表**之外**（不随列表滚走） */}
                  <div className="git-section-title">
                    <span>{section.title}</span>
                    <span className="git-section-count">
                      {section.entries.length}
                    </span>
                    <span className="git-spacer" />
                    {/* 一段只有一条时没有「全部」可言 */}
                    {section.bulk && section.entries.length > 1 && (
                      <button
                        type="button"
                        className="git-row-btn"
                        title={section.bulk.label}
                        disabled={disabled}
                        onClick={section.bulk.run}>
                        {section.bulk.label}
                      </button>
                    )}
                  </div>
                  <VirtualList
                    className="git-list"
                    items={section.entries}
                    heights={heights}
                    render={(entry) => {
                      const key = rowKey(section.side, entry.path)
                      // 批量目标在这里算一次：行只负责「按钮被点了」，不重复一遍选中集口径
                      const paths = actionPaths(key, section.side)
                      return (
                        <GitChangeRow
                          key={key}
                          entry={entry}
                          side={section.side}
                          stat={statOf(stats, section.side, entry.path)}
                          disabled={disabled}
                          selected={selectedSet.has(key)}
                          batch={paths.length}
                          onSelect={(mod) => selectRow(key, mod)}
                          onStage={() => void stage(paths)}
                          onUnstage={() => void unstage(paths)}
                          onDiscard={() => void discard(paths)}
                          onOpenDiff={setDiffTarget}
                        />
                      )
                    }}
                  />
                </section>
              ))}
            </div>
          )}

          {snapshot?.truncated && (
            <div className="git-notice">
              {t('变更过多，仅显示前 5000 条（请先处理未跟踪目录或补 .gitignore）')}
            </div>
          )}

          {/* 提交区在**最下面**（先看改了什么再写提交信息）；amend 模式下即使暂存区为空也要出现
              —— 只改提交信息是它最常见的用途 */}
          {(groups.staged.length > 0 || (amend && !!head?.oid)) && (
            <div className="git-commit">
              <textarea
                value={gitStore.commitDraft}
                placeholder={
                  readonly
                    ? t('只读沙盒模式下无法提交')
                    : t('提交信息（Ctrl+Enter 提交）')
                }
                disabled={disabled}
                onChange={(e) =>
                  runInAction(() => {
                    gitStore.commitDraft = e.target.value
                  })
                }
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void commit(gitStore.commitDraft, amend)
                  }
                }}
              />
              <div className="git-commit-row">
                <span className="git-hint">
                  {gitStore.busy
                    ? tpl('执行中：$__op__', { op: gitStore.busy })
                    : groups.staged.length > 0
                      ? tpl('已暂存 $__count__ 个文件', {
                        count: groups.staged.length,
                      })
                      : t('修改提交信息（不改动文件内容）')}
                </span>
                <span className="git-spacer" />
                <button
                  type="button"
                  className="git-primary-btn"
                  disabled={disabled || !gitStore.commitDraft.trim()}
                  onClick={() => {
                    void (async () => {
                      const ok = await commit(gitStore.commitDraft, amend)
                      // 改完就退出 amend 模式：下一次提交默认是新的
                      if (ok) setAmend(false)
                    })()
                  }}>
                  {amend ? t('修改提交') : t('提交')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {branchMenuOpen && (
        <GitBranchMenu
          disabled={disabled}
          onClose={() => setBranchMenuOpen(false)}
        />
      )}

      {syncMenuOpen && (
        <GitSyncMenu readonly={readonly} onClose={() => setSyncMenuOpen(false)} />
      )}

      {diffTarget && (
        <GitDiffModal
          target={diffTarget}
          sections={sections}
          disabled={disabled}
          onClose={() => setDiffTarget(null)}
        />
      )}

      {logOpen && <GitLogModal onClose={() => setLogOpen(false)} />}

      {graphOpen && <GitGraphModal onClose={() => setGraphOpen(false)} />}
    </>
  )
})

export default GitPanel
