/**
 * GitBranchMenu — 分支浮层（搜索 / 切换 / 新建，右键行可重命名 / 删除）。
 *
 * 四条口径：
 * - 名字合法性**只信 Rust 的 `git check-ref-format`**（`git-service.checkRefFormat`）—— 自己写正则
 *   必然漏规则（`..` / 结尾 `.lock` / 控制字符…），漏了就是「界面放行、git 报错」的错位；
 * - 搜索词没有精确命中时，最后一行变成「新建分支 xxx」，起点 = 当前 HEAD（VS Code 同款）；
 * - 切换失败（脏工作区与目标冲突）时**不关浮层**，错误留在面板顶部 —— 用户就地在别的分支上再试。
 * - **重命名复用搜索框**（右键 → 重命名，输入框带着旧名字进入改名模式，回车确认）：为一个输入
 *   再开一层弹窗不如就地改；改名模式下不渲染「新建」行，免得两个动作抢同一个回车。
 *
 * ⚠️ **远程分支要走 `detach`**（`b.is_remote`）：`git switch origin/x` 会直接 fatal
 *（「a branch is expected, got remote branch」，退出码 128）—— git 的 switch 只收本地分支名。
 * 切完 HEAD 不在任何分支上，面板上那个「游离 HEAD」入口是回来的路。
 * 同理，远程行**不给删除 / 重命名**：那是本地 refs 的操作，对 `refs/remotes/*` 没有意义。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import { gitStore } from '@/ui/store/gitStore'
import type { GitBranchInfo } from '@/domain/git'
import {
  checkRefFormat,
  removeBranch,
  renameBranch,
  switchBranch,
} from '@/services/git-service'
import ContextMenu, {
  useContextMenu,
  type ContextMenuItem,
} from '@/ui/components/shared/ContextMenu'

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
  /** 正在重命名的分支（`null` = 普通模式：输入框用来搜 / 新建） */
  const [renaming, setRenaming] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menu = useContextMenu<GitBranchInfo>()

  const q = query.trim()
  const list = gitStore.branches
  const exact = list.some((b) => b.name === q)
  const filtered = q
    ? list.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()))
    : list
  /** 重命名模式下，同一个输入框承载「新名字」（判据与新建同一套：非空、无精确命中、git 认它） */
  const canSubmit = canCreate && (!renaming || q !== renaming)

  // 新建 / 重命名行的可用性：非空、无精确命中、且 `check-ref-format` 认它
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

  async function pick(
    name: string,
    create: boolean,
    detach = false,
  ): Promise<void> {
    const ok = await switchBranch(name, create, null, detach)
    if (ok) onClose()
  }

  /** 右键 → 重命名：把输入框切到改名模式并带上旧名字 */
  function startRename(name: string): void {
    menu.close()
    setRenaming(name)
    setQuery(name)
    inputRef.current?.focus()
    inputRef.current?.select()
  }

  /** 退出改名模式（Esc / 成功后）：输入框清空，回到搜索 */
  function cancelRename(): void {
    setRenaming(null)
    setQuery('')
  }

  async function submitRename(): Promise<void> {
    if (!renaming) return
    const ok = await renameBranch(renaming, q)
    if (ok) cancelRename()
  }

  function buildItems(b: GitBranchInfo): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        key: 'rename',
        label: t('重命名分支'),
        disabled,
        onClick: () => startRename(b.name),
      },
    ]
    // 当前分支不能删（git 会拒：Cannot delete branch ... checked out）—— 不给这一项
    if (!b.is_head) {
      items.push({
        key: 'delete',
        label: t('删除分支'),
        divider: true,
        disabled,
        onClick: () => void removeBranch(b.name),
      })
      // `-d` 对未合并的分支会拒绝，那时这是唯一的出路 —— 但它是危险动作，要靠确认框兜住
      items.push({
        key: 'delete-force',
        label: t('强制删除分支'),
        danger: true,
        disabled,
        onClick: () => void removeBranch(b.name, true),
      })
    }
    return items
  }

  return (
    <div className="git-branch-menu" ref={boxRef}>
      <input
        ref={inputRef}
        value={query}
        placeholder={
          renaming
            ? tpl('重命名分支 $__name__', { name: renaming })
            : t('搜索或新建分支')
        }
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            if (renaming) cancelRename()
            else onClose()
          }
          if (e.key === 'Enter' && canSubmit) {
            void (renaming ? submitRename() : pick(q, true))
          }
        }}
      />
      <div className="git-branch-list">
        {renaming && (
          <div className="git-branch-hint">
            {canSubmit
              ? tpl('重命名为 $__new__（回车确认，Esc 取消）', { new: q })
              : t('输入新的分支名')}
          </div>
        )}
        {!renaming && canCreate && (
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
            // 远程分支只能 detach（见文件头 ⚠️）；本地分支照旧 switch
            onClick={() => void pick(b.name, false, b.is_remote)}
            // 远程行没有本地 refs 可动（删 / 改名对 refs/remotes/* 没有意义）→ 不开菜单
            onContextMenu={(e) => {
              if (b.is_remote) return
              menu.openAt(e, b)
            }}>
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
        {filtered.length === 0 && !canCreate && !renaming && (
          <div className="git-empty">{t('没有匹配的分支')}</div>
        )}
      </div>

      {menu.state && (
        <ContextMenu
          position={menu.state.position}
          items={buildItems(menu.state.target)}
          onClose={menu.close}
        />
      )}
    </div>
  )
})

export default GitBranchMenu
