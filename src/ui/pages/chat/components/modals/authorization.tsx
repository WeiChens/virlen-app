/**
 * AuthorizationModal — 通用「授权确认」弹窗
 *
 * 统一承载所有需要用户授权的操作（当前：命令执行 / 脚本执行 / 沙盒脱壳）。
 * 后续新增授权权限时，只需构造 `AuthorizationRequest`（permName/title/subTitle/desc）即可复用，
 * 不必再新增弹窗。
 *
 * 布局约定（与 `AuthorizationRequest` 一一对应）：
 *  - 标题栏：`授权确认` + 权限唯一 key（如 terminal.normal.execute）→ 让用户明确「为哪个权限授权」；
 *  - 正文三段：title（权限名称）/ sub-title（AI 说明）/ desc（命令等内容）；
 *  - hint：风险 / 警告提示（风险提示 + 绕过沙盒警告），有则显示。
 *
 * 键盘操作（只用键盘也能完成授权，与 `modals/user-choice` 同一套约定）：
 *  - 打开即聚焦「允许执行」→ **Enter = 确定**；
 *  - Esc = 拒绝（由共享 Modal 负责）；
 *  - Tab / Shift+Tab 在标题栏 ✕ 与三个按钮之间圈定循环（共享 Modal 负责）；
 *  - ↑ ↓ ← → 在「暂存 / 拒绝 / 允许执行」之间循环切换，再 Enter 即执行该项。
 */
import { useEffect, useRef } from 'react'
import Modal from '@/ui/components/shared/Modal'
import { navDelta, wrapIndex } from '@/ui/components/shared/keyboardNav'
import { t } from '@/ui/i18n'
import './authorization.scss'

interface Props {
  visible: boolean
  /** 权限唯一 key（跨 TS / Rust 稳定契约），如 `terminal.normal.execute` */
  permName: string
  /** 权限名称（展示） */
  title: string
  /** 副标题：AI 给出的操作说明（命令的 tips） */
  subTitle?: string
  /** 正文：命令文本 / 脚本正文等内容 */
  desc?: string
  /** 实际执行的 shell 命令（仅脚本等「desc 不是命令」时提供，作正文上方的一行说明） */
  command?: string
  /** 风险 / 警告提示（可空） */
  hint?: string
  /** 风险等级（仅用于配色，可空） */
  risk?: string
  onConfirm: () => void
  onCancel: () => void
  onShelve: () => void
}

export default function AuthorizationModal({
  visible,
  permName,
  title,
  subTitle,
  desc,
  command,
  hint,
  risk,
  onConfirm,
  onCancel,
  onShelve,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const shelveRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  /** 三个动作按钮（键盘导航只在它们之间循环；标题栏 ✕ 等价于「拒绝」，不另开一条路径） */
  const actionButtons = (): HTMLElement[] =>
    [shelveRef.current, cancelRef.current, confirmRef.current].filter(
      (el): el is HTMLButtonElement => !!el,
    )

  // 打开即聚焦「允许执行」→ 直接回车就是「确定」。
  // 共享 Modal 的「焦点移入弹窗」effect 是子组件、比这里先跑，因此不会把焦点抢回去。
  useEffect(() => {
    if (!visible) return
    confirmRef.current?.focus()
  }, [visible])

  // 方向键在三个动作之间循环切换；焦点不在按钮上（停在弹窗容器 / 正文）时 Enter 也算「允许执行」。
  // Tab 不在这里接管 —— 共享 Modal 已用捕获阶段的焦点圈定处理，重复接管会「一按两动」。
  useEffect(() => {
    if (!visible) return

    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current
      const overlay = root?.closest('.modal-overlay')
      if (!root || !overlay) return
      // 多层弹窗叠加时只让最上层响应（与共享 Modal 的 Esc / Tab 同一判断）
      const overlays = document.querySelectorAll('.modal-overlay')
      if (overlays[overlays.length - 1] !== overlay) return
      const active = document.activeElement as HTMLElement | null
      // 焦点可能掉到 body（点过弹窗内的非聚焦区域，如正文 / 标题）——
      // 弹窗是模态的：只要它是最上层，这一下键盘就归它
      if (active && active !== document.body && !overlay.contains(active)) return
      if (e.key === 'Tab') return

      const delta = navDelta(e.key, e.shiftKey)
      if (delta !== 0) {
        e.preventDefault() // 顺手拦下 ↑↓ 带动正文滚动
        const list = actionButtons()
        const index = list.indexOf(active as HTMLElement)
        list[wrapIndex(index, delta, list.length)]?.focus()
        return
      }

      if (e.key === 'Enter' && active?.tagName !== 'BUTTON') {
        e.preventDefault()
        onConfirm()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, onConfirm])

  return (
    <Modal
      visible={visible}
      onClose={onCancel}
      title={
        <>
          {t('授权确认')}
          {permName && (
            <code className="authorization-perm-key">{permName}</code>
          )}
        </>
      }
      width={`min(1000px, 80vw)`}>
      <div className="authorization" ref={rootRef}>
        <div className={`auth-title${risk ? ` risk-${risk}` : ''}`}>
          {title}
        </div>
        {subTitle && <p className="auth-subtitle">{subTitle}</p>}
        {hint && <p className="auth-hint">{hint}</p>}
        {(desc || command) && (
          <div className="auth-desc">
            {command && <div className="auth-desc-command">{command}</div>}
            {desc && <code>{desc}</code>}
          </div>
        )}
        <div className="actions">
          <button ref={shelveRef} className="btn-shelve" onClick={onShelve}>
            {t('暂存')}
          </button>
          <button ref={cancelRef} className="btn-cancel" onClick={onCancel}>
            {t('拒绝')}
          </button>
          <button ref={confirmRef} className="btn-confirm" onClick={onConfirm}>
            {t('允许执行')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
