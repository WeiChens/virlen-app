/**
 * GitStashModal — 贮藏（stash）：新建 + 列表（应用 / 应用并删除 / 删除 / 撤销删除）。
 *
 * 五条口径：
 * 1. **身份用 oid**：`stash@{n}` 是列表位置，外部一次 push / drop 就会整体重编号 —— 界面只传 oid，
 *    selector 的解析由 Rust 在仓库锁内完成（`pop` / `drop` 只认 stash ref，见 `git/stash.rs`）；
 * 2. **能不能贮藏由快照说了算**：无提交 / 有冲突 / 没改动时按钮禁用并写明原因 ——
 *    `git stash push` 在「没东西可贮藏」时退出码是 **0**，不能让用户看到「成功但没有条目」；
 * 3. **未跟踪文件默认不进贮藏**：勾选才走 `-u`（它会把所有未忽略的未跟踪文件写进对象库）；
 * 4. **`--keep-index` 是「留着也存一份」**：已暂存内容仍进贮藏，同时留在索引与工作区 —— 文案写明；
 * 5. **删除可撤销**：`stash store` 能把同一个 oid 放回栈顶，所以删完给一颗「撤销」（本次会话内）。
 *
 * ⚠️ 弹窗 portal 到 body：宿主面板按 DOM 包含判定「点外面关闭」、Esc 监听挂在 document 上 ——
 * 所以 Esc 走**捕获阶段**并 stopPropagation，遮罩类名进 `GitEntry` 的忽略名单。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { gitStore } from '@/ui/store/gitStore'
import { groupChanges, parseStashMessage } from '@/domain/git'
import { formatCommitTime } from '@/utils/time'
import {
  applyStash,
  createStash,
  dropStash,
  refreshStashes,
  undoDropStash,
} from '@/services/git-service'

interface Props {
  /** 只读沙盒模式：Rust 侧同样会拒，这里是体验层的双保险 */
  readonly: boolean
  onClose: () => void
}

export const GitStashModal = observer(function GitStashModal({
  readonly,
  onClose,
}: Props) {
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [keepIndex, setKeepIndex] = useState(false)
  const [loading, setLoading] = useState(true)
  const msgRef = useRef<HTMLInputElement>(null)

  // 打开即取列表：stash list 比 status 贵，面板 / 浮层关着时没有任何地方要展示它
  useEffect(() => {
    void refreshStashes().finally(() => setLoading(false))
  }, [])

  // Esc 只关弹窗：捕获阶段拦住，别让面板那颗 Esc 监听跟着把面板也关了
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // 上方有全局确认框（「删除这条贮藏？」）时 Esc 归它：本监听在捕获阶段、先于它执行，
      // 不判断就会「Esc 关掉背后两层」
      if (document.querySelector('.modal-overlay')) return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 打开就落在消息框：想直接贮藏的人不用先找焦点
  useEffect(() => {
    msgRef.current?.focus()
  }, [])

  const snapshot = gitStore.snapshot
  const groups = groupChanges(snapshot)
  const busy = gitStore.busy !== null
  const disabled = readonly || busy
  const hasHead = !!snapshot?.head.oid
  const hasConflicts = groups.conflicts.length > 0
  /** 已跟踪的改动按**路径**去重（同一个文件可能同时在「暂存的更改」与「更改」两段） */
  const trackedPaths = new Set(
    [...groups.staged, ...groups.unstaged].map((entry) => entry.path),
  )
  const stashCount = trackedPaths.size + (includeUntracked ? groups.untracked.length : 0)

  /** 不能贮藏的原因（空串 = 可以）；文案只说事实，不猜用户想干什么 */
  const blocked = !snapshot
    ? t('正在读取仓库状态…')
    : !hasHead
      ? t('仓库还没有提交，无法贮藏')
      : hasConflicts
        ? t('有未解决的冲突，解决后再贮藏')
        : stashCount === 0
          ? groups.untracked.length > 0
            ? t('只有未跟踪文件：勾选「包含未跟踪文件」后才能贮藏')
            : t('没有可贮藏的改动')
          : ''

  const canStash = !disabled && blocked === ''

  async function submit(): Promise<void> {
    if (!canStash) return
    const ok = await createStash(message, includeUntracked, keepIndex)
    if (!ok) return
    setMessage('')
    setIncludeUntracked(false)
    setKeepIndex(false)
  }

  return createPortal(
    <div className="git-diff-backdrop" onMouseDown={onClose}>
      <div
        className="git-stash-modal"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="git-stash-head">
          <span className="git-stash-title">{t('贮藏')}</span>
          {readonly && <span className="git-stash-note">{t('只读沙盒模式')}</span>}
          <span className="git-spacer" />
          <button
            type="button"
            className="git-close"
            onClick={onClose}
            title={t('关闭')}>
            ✕
          </button>
        </div>

        <div className="git-stash-create">
          <div className="git-stash-form">
            <input
              ref={msgRef}
              type="text"
              className="git-stash-msg"
              value={message}
              placeholder={t('贮藏信息（留空则使用 git 自动描述）')}
              disabled={disabled}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void submit()
              }}
            />
            <button
              type="button"
              className="git-primary-btn"
              disabled={!canStash}
              onClick={() => void submit()}>
              {t('贮藏更改')}
            </button>
          </div>

          <div className="git-stash-opts">
            <label className="git-stash-opt" title={t('未跟踪文件默认不进贮藏')}>
              <input
                type="checkbox"
                checked={includeUntracked}
                disabled={disabled}
                onChange={(event) => setIncludeUntracked(event.target.checked)}
              />
              {t('包含未跟踪文件')}
            </label>
            {/* 没有已暂存内容时 `--keep-index` 没有作用对象，直接禁用（免得勾了看不出区别） */}
            <label
              className="git-stash-opt"
              title={t('已暂存的内容仍会进贮藏，但保留在索引与工作区里')}>
              <input
                type="checkbox"
                checked={keepIndex}
                disabled={disabled || groups.staged.length === 0}
                onChange={(event) => setKeepIndex(event.target.checked)}
              />
              {t('保留已暂存的内容')}
            </label>
          </div>

          <div className={`git-stash-hint${blocked ? ' is-blocked' : ''}`}>
            {blocked || tpl('将贮藏 $__count__ 个文件的更改', { count: stashCount })}
            {!blocked && groups.untracked.length > 0 && !includeUntracked && (
              <span className="git-stash-hint-extra">
                {tpl('另有 $__count__ 个未跟踪文件会留在工作区', {
                  count: groups.untracked.length,
                })}
              </span>
            )}
            {!blocked && keepIndex && groups.staged.length > 0 && (
              <span className="git-stash-hint-extra">
                {t('已暂存的内容会保留在工作区')}
              </span>
            )}
          </div>
        </div>

        <div className="git-stash-list">
          {loading && gitStore.stashes.length === 0 && (
            <div className="git-stash-empty">{t('加载中…')}</div>
          )}
          {!loading && gitStore.stashes.length === 0 && (
            <div className="git-stash-empty">{t('没有贮藏')}</div>
          )}
          {gitStore.stashes.map((entry) => {
            const label = parseStashMessage(entry.message)
            const time = formatCommitTime(entry.time)
            return (
              <div className="git-stash-row" key={entry.oid} data-oid={entry.oid}>
                <div className="git-stash-row-main">
                  <span className="git-stash-row-title" title={entry.message}>
                    {label.message || t('（无贮藏信息）')}
                  </span>
                  <span className="git-stash-row-meta">
                    {label.branch && (
                      <span
                        className="git-stash-branch"
                        title={tpl('贮藏时的分支：$__name__', { name: label.branch })}>
                        {label.branch}
                      </span>
                    )}
                    {label.auto && (
                      <span
                        className="git-stash-auto"
                        title={t('由 git 自动生成的消息（贮藏时没写信息）')}>
                        {t('自动')}
                      </span>
                    )}
                    <span className="git-stash-time" title={entry.time}>
                      {time || entry.time}
                    </span>
                    <code className="git-stash-oid" title={entry.oid}>
                      {entry.oid.slice(0, 7)}
                    </code>
                  </span>
                </div>
                <div className="git-stash-row-actions">
                  <button
                    type="button"
                    className="git-stash-act"
                    title={t('应用这条贮藏（条目保留）')}
                    disabled={disabled}
                    onClick={() => void applyStash(entry.oid, false)}>
                    {t('应用')}
                  </button>
                  <button
                    type="button"
                    className="git-stash-act"
                    title={t('应用这条贮藏并把它从列表里删掉')}
                    disabled={disabled}
                    onClick={() => void applyStash(entry.oid, true)}>
                    {t('应用并删除')}
                  </button>
                  <button
                    type="button"
                    className="git-stash-act danger"
                    title={t('删除这条贮藏')}
                    disabled={disabled}
                    onClick={() => void dropStash(entry.oid)}>
                    {t('删除')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {gitStore.lastDropped && (
          <div className="git-stash-undo">
            <span className="git-stash-undo-text">
              {tpl('已删除「$__message__」', {
                message:
                  parseStashMessage(gitStore.lastDropped.message).message ||
                  t('（无贮藏信息）'),
              })}
            </span>
            <span className="git-spacer" />
            <button
              type="button"
              className="git-stash-act"
              title={t('把刚删掉的贮藏放回列表顶部')}
              disabled={disabled}
              onClick={() => void undoDropStash()}>
              {t('撤销')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
})

export default GitStashModal
