/**
 * GitMergeMenu — 合并浮层：把某个分支并进当前 HEAD（入口：面板头部「更多 → 合并分支…」）。
 *
 * 四条口径：
 * 1. **当前分支不列**：合并到自己没有意义（git 只会回 `Already up to date`）；
 *    游离 HEAD 时没有「当前分支」，全部可选（合并到 HEAD 是 git 的语义，不是我们的特例）；
 * 2. **「合并中」时行全部禁用、只留一条出路**：「中止合并」（`merge --abort`）——
 *    冲突时工作区已留下冲突标记，没有这个按钮，用户在界面上无路可走；
 * 3. **冲突原文不吞**：失败时错误弹窗（`run()` 的 dialog）带着 git 的 `CONFLICT` 清单，
 *    刷新后面板的「冲突」段同时把它们列出来；
 * 4. **`--no-ff` 是显式开关**：默认让 git 自己决定快进；勾上就强制生成一个合并提交。
 *
 * 与 `GitBranchMenu` 同一套浮层形态（搜索框 + 行列表 + 点外面 / Esc 关闭），
 * 样式共用 `.git-branch-*` 那几个类，只有定位与宽度不同（见 `style.scss`）。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { gitStore } from '@/ui/store/gitStore'
import { abortMerge, loadMergeState, mergeBranch } from '@/services/git-service'

interface Props {
  /** 只读沙盒 / 有操作在跑 → 所有写入口禁用（Rust 侧同样会拒，这里是体验层的双保险） */
  disabled: boolean
  onClose: () => void
}

export const GitMergeMenu = observer(function GitMergeMenu({
  disabled,
  onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const [noFf, setNoFf] = useState(false)
  /** `null` = 状态还没读回来（此时不摆「合并中」那一条，免得闪一下） */
  const [merging, setMerging] = useState<boolean | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const current = gitStore.snapshot?.head.branch ?? null
  const q = query.trim().toLowerCase()
  // `is_head` 就是「当前分支」的口径（由 Rust 的 `%(HEAD)` 给出，前端不自己比名字）
  const list = gitStore.branches.filter(
    (b) => !b.is_head && (!q || b.name.toLowerCase().includes(q)),
  )

  useEffect(() => {
    inputRef.current?.focus()
    void loadMergeState().then(setMerging)
  }, [])

  // 点浮层外关闭（与项目其它下拉同一套：mousedown 判断包含关系）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  async function run(name: string): Promise<void> {
    const ok = await mergeBranch(name, noFf)
    if (ok) {
      onClose()
      return
    }
    // 失败最可能是冲突：状态变了（进入 / 已在「合并中」），按钮与黄条都要跟着变
    setMerging(await loadMergeState())
  }

  async function abort(): Promise<void> {
    if (!(await abortMerge())) return
    setMerging(false)
  }

  return (
    <div className="git-merge-menu" ref={boxRef}>
      <div className="git-merge-head">
        <span className="git-merge-title">
          {current
            ? tpl('合并到 $__name__', { name: current })
            : t('合并到当前 HEAD')}
        </span>
        <span className="git-spacer" />
        <button
          type="button"
          className="git-close"
          onClick={onClose}
          title={t('关闭')}>
          ✕
        </button>
      </div>

      {merging && (
        <div className="git-merge-warn">
          <span className="git-merge-warn-text">
            {t('正在合并中：解决冲突后提交，或中止这次合并')}
          </span>
          <button
            type="button"
            className="git-merge-act"
            title={t('撤掉合并带入的改动与冲突标记')}
            disabled={disabled}
            onClick={() => void abort()}>
            {t('中止合并')}
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        value={query}
        placeholder={t('搜索要合并进当前分支的分支')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      />

      <div className="git-branch-list">
        {list.map((b) => (
          <button
            key={`${b.is_remote ? 'r' : 'l'}:${b.name}`}
            type="button"
            className="git-branch-item"
            // 合并中再合一次 git 会拒（需要先了结当前这次），直接禁用更省心
            disabled={disabled || merging === true}
            title={b.subject}
            onClick={() => void run(b.name)}>
            <span className="git-branch-label">{b.name}</span>
            {b.is_remote && <span className="git-branch-tag">{t('远程')}</span>}
            {(b.ahead > 0 || b.behind > 0) && (
              <span className="git-branch-tag">
                ↑{b.ahead} ↓{b.behind}
              </span>
            )}
          </button>
        ))}
        {list.length === 0 && (
          <div className="git-empty">{t('没有可合并的分支')}</div>
        )}
      </div>

      <div className="git-merge-foot">
        <label
          className="git-merge-opt"
          title={t('即使能快进也生成一个合并提交（保留分支拓扑）')}>
          <input
            type="checkbox"
            checked={noFf}
            disabled={disabled}
            onChange={(e) => setNoFf(e.target.checked)}
          />
          {t('不使用快进（--no-ff）')}
        </label>
        <div className="git-branch-hint">
          {t('点击分支即合并到当前分支；有冲突时工作区会留下冲突标记')}
        </div>
      </div>
    </div>
  )
})

export default GitMergeMenu
