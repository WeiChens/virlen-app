/**
 * GitPanel — 仓库头（分支 / ahead-behind / 提交记录 / 提交图 / 刷新）+ 提交区 + 三段变更列表。
 *
 * 提交区只在暂存区非空时出现；三段口径与差异弹窗共用 `sections.ts`（冲突段无批量入口）。
 * 选中模式同资源管理器：单击选中、Ctrl 加减、Shift 范围，**双击**才开差异。
 * 行内操作在该行属于选中集时作用于同侧全部（按钮文案带数量）。
 * 只读沙盒下所有写入口禁用（Rust 侧同样会拒，这里是双保险）。
 */
import { useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { runInAction } from 'mobx'
import { t, tpl } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import { gitStore } from '@/ui/store/gitStore'
import { groupChanges } from '@/domain/git'
import {
  commit,
  discard,
  initRepo,
  loadCommitDetail,
  refreshBranches,
  refreshRemotes,
  refreshStatus,
  stage,
  undoLastCommit,
  unstage,
} from '@/services/git-service'
import RefreshSvg from '@/ui/components/icons/RefreshSvg'
import HistorySvg from '@/ui/components/icons/HistorySvg'
import GraphSvg from '@/ui/components/icons/GraphSvg'
import UndoSvg from '@/ui/components/icons/UndoSvg'
import GitChangeRow, { type GitRowTarget } from './GitChangeRow'
import GitBranchMenu from './GitBranchMenu'
import GitSyncMenu from './GitSyncMenu'
import GitDiffModal from './GitDiffModal'
import GitLogModal from './GitLogModal'
import GitGraphModal from './GitGraphModal'
import { changeSections, rowKey, splitRowKey } from './sections'

interface Props {
  onClose: () => void
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
  /** 「修改上一次提交」：开着时提交走 `--amend`（把暂存内容并入上一条） */
  const [amend, setAmend] = useState(false)

  const snapshot = gitStore.snapshot
  const groups = groupChanges(snapshot)
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
        <div className="git-empty">
          {gitStore.unavailable}
          {/* 不是仓库是个**可继续**的状态：给一个出口，而不是只告诉用户「不行」 */}
          {gitStore.notRepo && (
            <div className="git-init-row">
              <button
                type="button"
                className="git-primary-btn"
                disabled={readonly || busy}
                onClick={() => void initRepo()}>
                {t('初始化仓库')}
              </button>
            </div>
          )}
        </div>
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
            {head && (head.ahead > 0 || head.behind > 0) && (
              <span className="git-track">
                {head.upstream ? `${head.upstream} ` : ''}↑{head.ahead} ↓
                {head.behind}
              </span>
            )}
            <span className="git-spacer" />
            {/* 远程同步入口：一是刷新列表（用户在终端里改过远程很常见），二是才打开浮层 */}
            <button
              type="button"
              className="git-link-btn git-sync-trigger"
              disabled={disabled}
              onClick={() => {
                if (!syncMenuOpen) void refreshRemotes()
                setSyncMenuOpen((v) => !v)
              }}
              title={t('获取 / 拉取 / 推送（凭据策略 = SSH）')}>
              {t('同步')}
            </button>
            {/* 撤销上次提交：用图标按钮，六字文字按钮会挤掉分支名 */}
            {head?.oid && (
              <button
                type="button"
                className="git-icon-btn"
                disabled={disabled}
                title={t('撤销上次提交（改动保留在暂存区）')}
                aria-label={t('撤销上次提交')}
                onClick={() => void undoLastCommit()}>
                <UndoSvg />
              </button>
            )}
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
              disabled={busy}
              onClick={() => void refreshStatus()}>
              <RefreshSvg />
            </button>
          </div>

          {groups.staged.length > 0 && (
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
                    : tpl('已暂存 $__count__ 个文件', {
                        count: groups.staged.length,
                      })}
                </span>
                {/* amend 开关：放在提交区里 —— 「能不能改上一条」与「有没有暂存内容」是同一件事的两个面 */}
                <label
                  className="git-amend"
                  title={t('把当前暂存的改动并入上一条提交')}>
                  <input
                    type="checkbox"
                    checked={amend}
                    disabled={disabled || !head?.oid}
                    onChange={(e) => void toggleAmend(e.target.checked)}
                  />
                  {t('修改上一次提交')}
                </label>
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

      {gitStore.repo && (
        <div className="git-list">
          {nothingToShow && <div className="git-empty">{t('没有更改')}</div>}

          {sections.map((section) => {
            if (section.entries.length === 0) return null
            return (
              <div className="git-section" key={section.key}>
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
                {section.entries.map((entry) => {
                  const key = rowKey(section.side, entry.path)
                  // 批量目标在这里算一次：行只负责「按钮被点了」，不重复一遍选中集口径
                  const paths = actionPaths(key, section.side)
                  return (
                    <GitChangeRow
                      key={`${section.key}:${entry.path}`}
                      entry={entry}
                      side={section.side}
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
                })}
              </div>
            )
          })}

          {snapshot?.truncated && (
            <div className="git-notice">
              {t('变更过多，仅显示前 5000 条（请先处理未跟踪目录或补 .gitignore）')}
            </div>
          )}
        </div>
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
