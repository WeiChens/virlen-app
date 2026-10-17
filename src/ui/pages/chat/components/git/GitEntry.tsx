/**
 * GitEntry — 聊天页标题栏的「源代码管理」入口（按钮 + 变更数徽标 + 浮层面板）。
 *
 * 与 `TodoEntry` / `ServiceEntry` 同构（同一排图标：徽标语义、点外部关闭、Esc 关闭都照抄），
 * 区别只在数据来源：这里的数据全部来自 git 自己（经 Rust），**不缓存**。
 *
 * 三条时机口径（P1 不做文件监听，见方案 §7 第 9 条）：
 * - **工作目录变化**（切会话 / 换目录）：探测 + 刷一次 —— 徽标在面板关着时也必须准；
 * - **打开面板**：刷一次；
 * - **窗口重新激活**：刷一次（面板关着也刷 —— 徽标要准；节流见 `refreshOnFocus`）。
 *
 * 入口的显隐：**探测完成且有工作目录**就出现（不要求是仓库）—— 不是仓库时面板里那个「初始化
 * 仓库」是唯一出口，藏掉入口等于把这条路封死；没装 git / 没选目录时不占工具栏。
 */
import { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t, tpl } from '@/ui/i18n'
import GitSvg from '@/ui/components/icons/GitSvg'
import { chatState } from '@/ui/store/chatState'
import { sessionStore } from '@/ui/store/sessionStore'
import { gitStore } from '@/ui/store/gitStore'
import { badgeText, changedFileCount } from '@/domain/git'
import {
  refreshOnFocus,
  refreshStatus,
  setPanelOpen,
  syncWorkspace,
} from '@/services/git-service'
import GitPanel from './GitPanel'
import './style.scss'

interface Props {
  /** 归属会话；`null` = 聊天页处于「新对话」→ 用全局选中的工作目录 */
  sessionId: string | null
}

export const GitEntry = observer(function GitEntry({ sessionId }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const dir = sessionId
    ? sessionStore.getSession(sessionId)?.workspace || null
    : chatState.value.selectedWorkspace || null

  // 目录一变就重新探测（`syncWorkspace` 对同一目录会直接返回）
  useEffect(() => {
    void syncWorkspace(dir)
  }, [dir])

  useEffect(() => {
    setPanelOpen(open)
    if (open) void refreshStatus()
  }, [open])

  useEffect(() => {
    const onFocus = (): void => {
      void refreshOnFocus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  /** 关窗处理器的最新引用（mousedown 监听只挂一次，闭包不能捕获旧状态） */
  const closeRef = useRef<() => void>(() => {
    setOpen(false)
  })
  closeRef.current = () => {
    setOpen(false)
  }

  // 点浮层外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Esc 关闭 —— 提交框里按 Esc 只 blur（正在写提交信息时误按不该把面板连同草稿一起关掉；
  // 草稿本身存在 store 里不会丢，但突然收起的浮层一样恼人）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const active = document.activeElement as HTMLElement | null
      if (active?.tagName === 'TEXTAREA' || active?.tagName === 'INPUT') {
        active.blur()
        return
      }
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // 探测完成 + 有工作目录 → 显示；不是仓库也显示（面板里有「初始化仓库」）
  if (!gitStore.probed || !gitStore.dir) return null

  const repo = gitStore.repo
  const count = repo ? changedFileCount(gitStore.snapshot) : 0
  const title = !repo
    ? t('源代码管理')
    : repo.bare
      ? t('裸仓库（没有工作区文件）')
      : count > 0
        ? tpl('源代码管理 · $__count__ 个文件有更改', { count })
        : t('源代码管理')

  return (
    <div className="git-entry" ref={wrapRef}>
      <button
        type="button"
        className={`toolbar-icon-btn git-entry-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={title}>
        <GitSvg />
        {count > 0 && <span className="git-badge">{badgeText(count)}</span>}
      </button>
      {open && (
        <div className="git-popover">
          <GitPanel onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
})

export default GitEntry
