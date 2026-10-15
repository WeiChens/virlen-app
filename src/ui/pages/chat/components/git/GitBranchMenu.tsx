/**
 * GitBranchMenu — 分支浮层（搜索 / 列表 / 新建并切换）。
 *
 * 三条口径：
 * - 名字合法性**只信 Rust 的 `git check-ref-format`**（`git-service.checkRefFormat`）—— 自己写正则
 *   必然漏规则（`..` / 结尾 `.lock` / 控制字符…），漏了就是「界面放行、git 报错」的错位；
 * - 搜索词没有精确命中时，最后一行变成「新建分支 xxx」，起点 = 当前 HEAD（VS Code 同款）；
 * - 切换失败（脏工作区与目标冲突）时**不关浮层**，错误留在面板顶部 —— 用户就地在别的分支上再试。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { gitStore } from '@/ui/store/gitStore'
import { checkRefFormat, switchBranch } from '@/services/git-service'

interface Props {
  disabled: boolean
  onClose: () => void
}

export const GitBranchMenu = observer(function GitBranchMenu({
  disabled,
  onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const [canCreate, setCanCreate] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const q = query.trim()
  const list = gitStore.branches
  const exact = list.some((b) => b.name === q)
  const filtered = q
    ? list.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()))
    : list

  // 新建行的可用性：非空、无精确命中、且 `check-ref-format` 认它
  useEffect(() => {
    if (!q || exact) {
      setCanCreate(false)
      return
    }
    let alive = true
    void checkRefFormat(q).then((ok) => {
      if (alive) setCanCreate(ok)
    })
    return () => {
      alive = false
    }
  }, [q, exact])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 点浮层外关闭（与项目其它下拉同一套：mousedown 判断包含关系）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  async function pick(name: string, create: boolean): Promise<void> {
    const ok = await switchBranch(name, create)
    if (ok) onClose()
  }

  return (
    <div className="git-branch-menu" ref={boxRef}>
      <input
        ref={inputRef}
        value={query}
        placeholder={t('搜索或新建分支')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
          if (e.key === 'Enter' && canCreate) void pick(q, true)
        }}
      />
      <div className="git-branch-list">
        {canCreate && (
          <button
            type="button"
            className="git-branch-item create"
            disabled={disabled}
            onClick={() => void pick(q, true)}>
            <span className="git-branch-label">
              {tpl('新建分支 $__name__（起点 = 当前 HEAD）', { name: q })}
            </span>
          </button>
        )}
        {filtered.map((b) => (
          <button
            key={`${b.is_remote ? 'r' : 'l'}:${b.name}`}
            type="button"
            className={`git-branch-item${b.is_head ? ' current' : ''}`}
            // 当前分支再点一次没有意义（git 自己会提示 already on），直接禁掉更省心
            disabled={disabled || b.is_head}
            title={b.subject}
            onClick={() => void pick(b.name, false)}>
            <span className="git-branch-label">{b.name}</span>
            {b.upstream_gone && (
              <span className="git-branch-tag gone">{t('上游已删除')}</span>
            )}
            {!b.upstream_gone && (b.ahead > 0 || b.behind > 0) && (
              <span className="git-branch-tag">
                ↑{b.ahead} ↓{b.behind}
              </span>
            )}
          </button>
        ))}
        {filtered.length === 0 && !canCreate && (
          <div className="git-empty">{t('没有匹配的分支')}</div>
        )}
      </div>
    </div>
  )
})

export default GitBranchMenu
