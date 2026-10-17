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
 * 入口的显隐：**只有已有仓库（目录里有 `.git`）才出现**。没 `.git` 的目录不常驻一个用不上的
 * 图标；没装 git 时 `repo` 也不会是 `Some`，同样不出现。用户在终端 / 由 AI 跑了 `git init` 之后，
 * `refreshOnFocus` / `notifyWorkspaceActivity` 会重新探测一次（节流见 `reprobeIfMissing`），
 * 切一下窗口或继续对话，入口就自己出现。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { runInAction } from 'mobx'
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
import GitErrorModal from './GitErrorModal'
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
      const target = e.target as HTMLElement | null
      // 弹窗（portal 到 body）在 `.git-entry` 之外：点它不算「点在外面」，
      // 否则「在错误弹窗里点复制」会把背后的面板一并关掉
      if (target?.closest?.('.modal-overlay')) return
      if (!wrapRef.current?.contains(target)) closeRef.current()
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
      // 有弹窗（如错误弹窗）时 Esc 只属于它，不能顺带把面板也关了
      if (document.querySelector('.modal-overlay')) return
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

  // 入口只在**已有仓库**时出现（工作目录里有 `.git`）：没 .git 的目录不该常驻一个用不上的图标。
  // 没装 git 时 `repo` 同样不可能是 `Some` → 一起隐掉（不提示、不占位）。
  if (!gitStore.probed || !gitStore.dir || !gitStore.repo) return null

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
      {/* 错误弹窗挂在**面板外**：面板收起来 / 网络操作失败得更晚时，报错仍然看得到。
          portal 到 body：标题栏这层有 overflow 与层叠上下文，不腾出去 fixed 遮罩会被裁掉 */}
      {gitStore.errorBox &&
        createPortal(
          <GitErrorModal
            op={gitStore.errorBox.op}
            text={gitStore.errorBox.text}
            onClose={() =>
              runInAction(() => {
                gitStore.errorBox = null
              })
            }
          />,
          document.body,
        )}
    </div>
  )
})

export default GitEntry
