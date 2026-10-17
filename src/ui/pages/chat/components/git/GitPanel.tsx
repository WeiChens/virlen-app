/**
 * GitPanel — 面板主体：仓库头（分支 / ahead-behind / **提交记录 / 提交图** / 刷新）+ 提交区 + 三段变更列表。
 *
 * 提交区**只在暂存区非空时出现**（空着的时候它只是一行占地方的噪声）；主按钮靠右 ——
 * 与全项目「主操作落在右下」一致，左侧留给状态提示。
 *
 * 三段的顺序 / 标题 / 批量入口收在 `sections.ts`（差异弹窗的左侧清单共用同一份口径；未跟踪并进
 * 「更改」段—— git 的分组仍是四组，合并只发生在展示层）。
 * ⚠️ 冲突段**不给批量入口**：冲突文件的「暂存」在 git 里是「标记已解决」，与普通暂存不是一回事
 * （真正的解决要动文件内容，属于 P3，见方案 §8.3）。
 *
 * 选中模式（与资源管理器同口径）：单击 = 选中这一行、Ctrl/Cmd 点击 = 加 / 减、Shift 点击 = 选一段范围；
 * **双击**才打开差异（单击就弹窗会让「多选几个一起暂存」这件事做不了）。
 * 行内「暂存 / 取消暂存 / 丢弃」在这一行**属于选中集**时作用于同侧选中的全部（批量），此时按钮文案
 * 会变成「… N 个文件」（点之前就知道它带走几个），否则只作用于它自己。
 *
 * 只读沙盒模式下所有写入口禁用（`sandboxMode === 'readonly'`）—— Rust 侧同样会拒，这里是双保险。
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
  refreshStatus,
  stage,
  undoLastCommit,
  unstage,
} from '@/services/git-service'
import RefreshSvg from '@/ui/components/icons/RefreshSvg'
import HistorySvg from '@/ui/components/icons/HistorySvg'
import GraphSvg from '@/ui/components/icons/GraphSvg'
import GitChangeRow, { type GitRowTarget } from './GitChangeRow'
import GitBranchMenu from './GitBranchMenu'
import GitDiffModal from './GitDiffModal'
import GitLogModal from './GitLogModal'
import GitGraphModal from './GitGraphModal'
import { changeSections, rowKey, splitRowKey } from './sections'

interface Props {
  onClose: () => void
}

export const GitPanel = observer(function GitPanel({ onClose }: Props) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [diffTarget, setDiffTarget] = useState<GitRowTarget | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
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

  /**
   * 列表顺序的行键（= 当前快照里还存在的行）：Shift 范围选择按它取区间，选中集也按它对账。
   * 对账是必要的 —— 写操作之后行会换段（暂存 → 已暂存段）甚至消失，旧键不该继续算数。
   */
  const flatKeys = sections.flatMap((section) =>
    section.entries.map((entry) => rowKey(section.side, entry.path)),
  )
  const selectedLive = selected.filter((key) => flatKeys.includes(key))
  const selectedSet = new Set(selectedLive)

  /**
   * 单击选中 / Ctrl-Cmd 加减 / Shift 取一段。
   * 锚点：单击与 Ctrl 点击会挪到刚点的这一行（与资源管理器一致），Shift 不挪 —— 于是连续 Shift
   * 都是从同一个锚点重新扩，而不是逐次叠加。
   */
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

  /**
   * 一次行内操作真正作用的对象：这一行在选中集里 → **同侧**选中的全部（批量），否则只有它自己。
   * 只取同侧 —— 批量「暂存」不该顺手把已暂存的行也走一遍（那是另一个动作，diff 基准也不同）。
   */
  function actionPaths(key: string, side: 'staged' | 'unstaged'): string[] {
    const keys = selectedSet.has(key) ? selectedLive : [key]
    const paths = keys
      .map(splitRowKey)
      .filter((row) => row.side === side)
      .map((row) => row.path)
    return [...new Set(paths)]
  }

  /**
   * 分支浮层的开关 —— 分支按钮与「游离 HEAD」徽标共用。
   * ⚠️ 两个入口缺一不可：切到**远程分支**会 detach，那时分支名就没了（`head.branch === null`），
   * 只剩这个徽标能把浮层打开、切回本地分支。
   */
  function toggleBranchMenu(): void {
    if (!branchMenuOpen) void refreshBranches()
    setBranchMenuOpen((v) => !v)
  }

  /**
   * 切「修改上一次提交」：打开时若草稿还空着，用上一条的**完整信息**回填 ——
   * amend 最常见的用途就是改信息，让人重新敲一遍不合理。
   */
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
            {/* 撤销上次提交：只在有提交时出现（空仓库里它没有意义） */}
            {head?.oid && (
              <button
                type="button"
                className="git-link-btn"
                disabled={disabled}
                onClick={() => void undoLastCommit()}
                title={t('撤销上次提交（改动保留在暂存区）')}>
                {t('撤销上次提交')}
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

      {/* 提交时 git 的 stderr（hooks 的输出 / 警告）：正常提交为空，所以它一出现就是「有事要告诉你」
          —— 之前这份输出被丢掉，用户只知道「提交了」，不知道 hook 改过文件 / 报了什么 */}
      {gitStore.hookOutput && (
        <div className="git-hook-output">
          <div className="git-hook-head">
            <span>{t('提交输出（hooks / 警告）')}</span>
            <span className="git-spacer" />
            <button
              type="button"
              className="git-close"
              title={t('关闭')}
              onClick={() =>
                runInAction(() => {
                  gitStore.hookOutput = null
                })
              }>
              ✕
            </button>
          </div>
          <pre>{gitStore.hookOutput}</pre>
        </div>
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
