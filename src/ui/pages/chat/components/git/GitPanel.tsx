/**
 * GitPanel — 仓库头（分支 / ahead-behind / 提交记录 / 提交图 / 刷新）+ 变更列表 + 提交区。
 *
 * 变更列表**一次只看一段**：顶部 tab 切换「更改（含未跟踪）→ 暂存区 → 冲突」。
 * 两段并排时每列只剩一半宽度（面板宽只有 496px），长路径与行内操作只能互相挤；
 * 段口径与差异弹窗共用 `sections.ts`（冲突段无批量入口、且只在该段非空时出现）。
 * 批量入口成功后 tab 跟到内容去的那一段（全部暂存 → 暂存区，全部取消暂存 → 更改）。
 * 提交区只挂在「暂存区」tab 下 —— 提交只跟暂存区有关；显隐还看暂存区是否非空
 * （amend 模式例外：只改提交信息也得有地方写）。
 * 选中模式同资源管理器：单击选中、Ctrl 加减、Shift 范围，**双击**才开差异。
 * 行内操作在该行属于选中集时作用于同侧全部（按钮文案带数量）。
 * 只读沙盒下所有写入口禁用（Rust 侧同样会拒，这里是双保险）。
 *
 * 变更行“拖到输入框 / 右键引用到输入框” = 把文件挂成对话附件：路径在这里统一换成**绝对路径**
 *（输入框只认真实路径），并剔除**已删除**的文件（磁盘上已不存在，挂上去只会换来一句
 *「无法访问该路径」）。两者共用 `attachPaths`，口径只有一份。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { runInAction } from 'mobx'
import { t, tpl } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import { gitStore } from '@/ui/store/gitStore'
import { groupChanges, sectionStatTotals, statOf } from '@/domain/git'
import { toAbsolutePath } from '@/utils/common'
import { showToast } from '@/ui/components/shared/Toast'
import {
  abortPick,
  commit,
  discard,
  fetchRemote,
  loadCommitDetail,
  pullRemote,
  pushRemote,
  refreshBranches,
  resumePick,
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
import GitMergeMenu from './GitMergeMenu'
import GitDiffModal from './GitDiffModal'
import GitLogModal from './GitLogModal'
import GitGraphModal from './GitGraphModal'
import GitStashModal from './GitStashModal'
import {
  changeSections,
  rowKey,
  splitRowKey,
  type GitChangeSection,
  type GitSectionKey,
} from './sections'
import VirtualList from './VirtualList'

interface Props {
  onClose: () => void
  /** 把一批真实路径挂到输入框（聊天页把它接到 `ChatInput.attachPaths`） */
  onAttachPaths: (paths: string[]) => void
}

/** 变更列表只有一行标题信息：段标题 + 文件行都住在同一段里，现在是「一次只看一段」，
    段标题换成顶部 tab（计数与批量入口都在那一行）—— 两段并排时每列只有一半宽度，
    长路径与行内操作互相挤。 */

/** 行高（px）—— 虚拟列表靠它算前缀和，**必须与 `.git-list .git-row` 一致**：
    24 是行内那颗 22px 按钮的下限（20px 时按钮会被裁掉半截） */
const ROW_H = 24

/** 某一段空掉时的提示（各段说自己的话，不用一句通用的「没有更改」） */
function emptySectionText(key: GitSectionKey): string {
  switch (key) {
    case 'staged':
      return t('没有暂存的更改')
    case 'conflicts':
      return t('没有冲突')
    default:
      return t('没有未暂存的更改')
  }
}

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

export const GitPanel = observer(function GitPanel({
  onClose,
  onAttachPaths,
}: Props) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [diffTarget, setDiffTarget] = useState<GitRowTarget | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  /**
   * 贮藏浮层（列表 + 新建）：面板里放不下第三块常驻区域，收进「更多」
   */
  const [stashOpen, setStashOpen] = useState(false)
  /** 合并浮层（选一个分支并进当前 HEAD） */
  const [mergeOpen, setMergeOpen] = useState(false)
  /** 选中集（键 = `rowKey`，保持点击先后）；`anchorRef` 是 Shift 范围选择的起点 */
  const [selected, setSelected] = useState<string[]>([])
  const anchorRef = useRef<string | null>(null)
  /** 「修改上一次提交」：开着时提交走 `--amend`（改信息 / 把暂存内容并入上一条） */
  const [amend, setAmend] = useState(false)
  /** 变更列表当前 tab（`sections` 的 key）：一次只看一段 */
  const [tab, setTab] = useState<GitSectionKey>('unstaged')
  /** 头部「更多」菜单：三个远程动作 / 合并浮层 / 贮藏浮层 / 撤销上次提交 / 修改上一次提交 ——
   * 都不常用，常驻会挤掉分支名 */
  const more = useContextMenu()
  const moreBtnRef = useRef<HTMLButtonElement>(null)

  const snapshot = gitStore.snapshot
  const groups = groupChanges(snapshot)
  /** 行数统计（只在面板打开时取；没回来时 `null`，行内就不画数字） */
  const stats = gitStore.stats
  const readonly = settingsState.value.sandboxMode === 'readonly'
  const busy = gitStore.busy !== null
  const disabled = readonly || busy
  const head = snapshot?.head

  const sections = changeSections(groups, { stage, unstage })

  /** 当前快照的行键（顺序即列表顺序）；写操作后行会换段/消失，选中集要按它对账。 */
  const flatKeys = sections.flatMap((section) =>
    section.entries.map((entry) => rowKey(section.side, entry.path)),
  )
  const selectedLive = selected.filter((key) => flatKeys.includes(key))
  const selectedSet = new Set(selectedLive)

  /**
   * 变更列表改成**一次只看一段**（顶部 tab 切换）：并排两列时每列只有一半宽度，
   * 长路径与行内操作互相挤。冲突段只在这一段非空时出现（常驻一个「冲突 0」只是噪音）。
   */
  const visibleSections = sections.filter(
    (section) => section.key !== 'conflicts' || section.entries.length > 0,
  )
  /** 当前段（tab 指向的那段；冲突处理完之后自动回落到第一段） */
  const activeSection =
    visibleSections.find((section) => section.key === tab) ?? visibleSections[0]

  /**
   * 第一次拿到快照时按「有内容的那一段」定一次初值：全暂存完再打开面板不该先看到空列表，
   * 有冲突则先看冲突（三段里唯一「必须处理」的）。之后一切以用户点的 tab 为准。
   */
  const tabInitedRef = useRef(false)
  useEffect(() => {
    if (tabInitedRef.current || !snapshot) return
    tabInitedRef.current = true
    const target =
      visibleSections.find(
        (section) => section.key === 'conflicts' && section.entries.length > 0,
      ) ?? visibleSections.find((section) => section.entries.length > 0)
    if (target) setTab(target.key)
  }, [snapshot, visibleSections])

  /** 当前段每行的高度（都是 `ROW_H`）：长度不变就复用同一份数组，虚拟列表别每帧重算前缀和 */
  const activeHeights = useMemo(
    () => new Array<number>(activeSection.entries.length).fill(ROW_H),
    [activeSection.entries.length],
  )

  /** 当前段的行数合计（**只算这一段**：同一个文件两段都有改动时各算各的，相加没有意义） */
  const activeTotals = sectionStatTotals(activeSection.side, activeSection.entries, stats)
  /** 暂存段的合计：那个 tab 不单占一行汇总，数字落到提交区的提示上 */
  const stagedTotals = sectionStatTotals('staged', groups.staged, stats)

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
   * 批量入口（全部暂存 / 全部取消暂存）：成功后把 tab 跟到内容去的那一段 ——
   * 全部暂存完文件都在暂存区，留在「更改」只能看到空列表；取消暂存同理回「更改」。
   * 失败（返回 false）时留在原地，错误已由 git-service 报过。
   */
  async function runBulk(section: GitChangeSection): Promise<void> {
    if (!section.bulk) return
    const ok = await section.bulk.run()
    if (!ok) return
    setTab(section.key === 'unstaged' ? 'staged' : 'unstaged')
  }

  /**
   * 引用到输入框：仓库根相对 → 绝对路径。
   * 已删除的文件剔掉 —— 它们在磁盘上已不存在，输入框那边的 `stat` 只会失败。
   */
  function attachPaths(paths: string[]): void {
    const root = gitStore.repo?.root
    if (!root || paths.length === 0) return
    const gone = new Set(
      (snapshot?.entries ?? [])
        .filter((row) => row.x === 'D' || row.y === 'D')
        .map((row) => row.path),
    )
    const alive = paths.filter((path) => !gone.has(path))
    if (alive.length < paths.length) showToast(t('已删除的文件无法引用'))
    if (alive.length > 0) {
      onAttachPaths(alive.map((path) => toAbsolutePath(path, root)))
    }
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

  /** 头部菜单项：高频动作仍是分支 / 落差 / 记录 / 图 / 刷新，这里只放不常用的
   *（获取 / 拉取 / 推送 / 合并 / 贮藏 / 撤销提交 / amend） */
  function moreItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        key: 'fetch',
        label: t('获取远程更新'),
        // 三个远程动作都是写操作（要过 Rust 的写闸）：只读沙盒 / 忙时一律禁用
        disabled,
        onClick: () => void fetchRemote(),
      },
      {
        key: 'pull',
        label: t('拉取远程更新'),
        // 拉取 / 推送按分支名进行 —— 游离 HEAD 上没有这个前提（Rust 侧同样会拒）
        disabled: disabled || !head?.branch,
        onClick: () => void pullRemote(),
      },
      {
        key: 'push',
        label: t('推送本地提交'),
        disabled: disabled || !head?.branch,
        onClick: () => void pushRemote(),
      },
    ]
    items.push({
      key: 'merge',
      label: t('合并分支…'),
      divider: true,
      // 开浮层是读操作（只读沙盒下也能看分支列表）；真正合并的那一下在浮层里再按只读 / busy 禁用。
      // 没有提交时合并无从谈起（HEAD 还没诞生）
      disabled: busy || !head?.oid,
      onClick: () => {
        if (!mergeOpen) void refreshBranches()
        setMergeOpen(true)
      },
    })
    items.push({
      key: 'stash',
      label: t('贮藏更改…'),
      // 开浮层是读操作（只读沙盒下也能看列表）；浮层里的写入口自己再按只读 / busy 禁用
      disabled: busy,
      onClick: () => setStashOpen(true),
    })
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

  // 进行中的挑选 / 还原：冲突解决到一半时，面板顶部必须给两条出路（界面上没有终端可用）
  const pick = gitStore.pick

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

      {/* 挑选 / 还原进行中：冲突后 `git commit` 也能了结它（与合并同一口径），
          但「解不动」的人必须有地方可退 —— 这两颗按钺就是全部出路 */}
      {pick && (
        <div className="git-pick-warn">
          <span className="git-pick-warn-text" title={pick.oid ?? undefined}>
            {pick.kind === 'cherry-pick'
              ? t('正在挑选提交：解决冲突后暂存并继续')
              : t('正在还原提交：解决冲突后暂存并继续')}
          </span>
          <button
            type="button"
            disabled={disabled}
            title={t('冲突已解决并已暂存时才能继续')}
            onClick={() => void resumePick(pick.kind)}>
            {t('继续')}
          </button>
          <button
            type="button"
            disabled={disabled}
            title={t('工作区会回到动作之前')}
            onClick={() => void abortPick(pick.kind)}>
            {t('中止')}
          </button>
        </div>
      )}

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
      {/* 已有弹窗报错  */}
      {/* {gitStore.error && <div className="git-empty error">{gitStore.error}</div>} */}

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

      {gitStore.repo && (
        <>
          {/* tab 栏：三段变更一次只看一段（并排两列时每列只有一半宽度，长路径与行内操作互相挤）。
              计数挂在 tab 上，当前段的批量入口在行尾 —— 段自己的标题行因此可以省掉。 */}
          <div className="git-tabs" role="tablist">
            {visibleSections.map((section) => (
              <button
                key={section.key}
                type="button"
                role="tab"
                aria-selected={section.key === activeSection.key}
                className={`git-tab${section.key === activeSection.key ? ' is-active' : ''}${section.key === 'conflicts' ? ' is-danger' : ''
                  }`}
                onClick={() => setTab(section.key)}>
                <span className="git-tab-name">{section.title}</span>
                <span className="git-tab-count">{section.entries.length}</span>
              </button>
            ))}
            <span className="git-spacer" />
            {/* 一段只有一条时没有「全部」可言 */}
            {activeSection.bulk && activeSection.entries.length > 1 && (
              <button
                type="button"
                className="git-bulk-btn"
                title={activeSection.bulk.label}
                disabled={disabled}
                onClick={() => void runBulk(activeSection)}>
                {activeSection.bulk.label}
              </button>
            )}
          </div>



          <div className="git-list-box">
            <section className="git-section" role="tabpanel">
              {activeSection.entries.length > 0 ? (
                <VirtualList
                  // 换 tab = 换一份内容与滚动位置（不给 key 会沿用上一段的 scrollTop）
                  key={activeSection.key}
                  className="git-list"
                  items={activeSection.entries}
                  heights={activeHeights}
                  render={(entry) => {
                    const key = rowKey(activeSection.side, entry.path)
                    // 批量目标在这里算一次：行只负责「按钮被点了」，不重复一遍选中集口径
                    const paths = actionPaths(key, activeSection.side)
                    return (
                      <GitChangeRow
                        key={key}
                        entry={entry}
                        side={activeSection.side}
                        stat={statOf(stats, activeSection.side, entry.path)}
                        disabled={disabled}
                        selected={selectedSet.has(key)}
                        batch={paths.length}
                        dragPaths={paths}
                        onAttach={attachPaths}
                        onSelect={(mod) => selectRow(key, mod)}
                        onStage={() => void stage(paths)}
                        onUnstage={() => void unstage(paths)}
                        onDiscard={() => void discard(paths)}
                        onOpenDiff={setDiffTarget}
                      />
                    )
                  }}
                />
              ) : (
                <div className="git-empty">{emptySectionText(activeSection.key)}</div>
              )}
            </section>
          </div>
          {/* 行数汇总挂在 tab **下方**、只描述当前这一段（跨段总和会跟列表对不上）：
              文件数来自快照（统计没回来时也准），行数来自统计。
              暂存那一段不占这一行 —— 它的数字落在提交区的提示上（见 `.git-hint`）；
              冲突段没有行数可言（conflicts 不在统计里），也不给。 */}
          {activeSection.key === 'unstaged' && activeSection.entries.length > 0 && (
            <div
              className="git-stats-summary"
              title={t('未跟踪文件按全文新增计；二进制与冲突文件不计入行数')}>
              <span>
                {tpl('已编辑 $__count__ 个文件', { count: activeTotals.files })}
              </span>
              <span className="git-spacer" />
              {stats && (
                <>
                  <span className="git-stat-add">+{activeTotals.added}</span>
                  <span className="git-stat-del">−{activeTotals.deleted}</span>
                  {/* 有文件数不出来（二进制 / 未跟踪过大）→ 合计只是「已知部分」 */}
                  {activeTotals.partial && <span className="git-stat-more">…</span>}
                </>
              )}
            </div>
          )}

          {snapshot?.truncated && (
            <div className="git-notice">
              {t('变更过多，仅显示前 5000 条（请先处理未跟踪目录或补 .gitignore）')}
            </div>
          )}

          {/* 提交区挂在「暂存区」这一 tab 下（提交只跟暂存区有关），amend 模式下即使暂存区为空
              也要出现 —— 只改提交信息是它最常见的用途 */}
          {activeSection.key === 'staged' &&
            (groups.staged.length > 0 || (amend && !!head?.oid)) && (
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
                  rows={4}
                />
                <div className="git-commit-row">
                  {/* 暂存那一段的行数合计就落在这句提示上（那个 tab 不再单占一行汇总） */}
                  <span className="git-hint">
                    {gitStore.busy ? (
                      tpl('执行中：$__op__', { op: gitStore.busy })
                    ) : groups.staged.length > 0 ? (
                      <>
                        {tpl('已暂存 $__count__ 个文件', {
                          count: groups.staged.length,
                        })}
                        {stats && (
                          <>
                            <span className="git-stat-add"> +{stagedTotals.added}</span>
                            <span className="git-stat-del"> −{stagedTotals.deleted}</span>
                            {stagedTotals.partial && (
                              <span className="git-stat-more"> …</span>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      t('修改提交信息（不改动文件内容）')
                    )}
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

      {stashOpen && (
        <GitStashModal readonly={readonly} onClose={() => setStashOpen(false)} />
      )}

      {mergeOpen && (
        <GitMergeMenu disabled={disabled} onClose={() => setMergeOpen(false)} />
      )}

      {diffTarget && (
        <GitDiffModal
          target={diffTarget}
          sections={sections}
          disabled={disabled}
          onAttach={attachPaths}
          onClose={() => setDiffTarget(null)}
        />
      )}

      {logOpen && (
        <GitLogModal disabled={disabled} onClose={() => setLogOpen(false)} />
      )}

      {graphOpen && (
        <GitGraphModal disabled={disabled} onClose={() => setGraphOpen(false)} />
      )}
    </>
  )
})

export default GitPanel
