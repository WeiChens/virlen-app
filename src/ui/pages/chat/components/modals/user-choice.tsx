/**
 * user-choice-modal — AI 调用 user_choice 工具时向用户发起的选择弹窗（内联实现 Modal）。
 *
 * 表单状态与正文在 `choice-form.ts` / `choice-body.tsx`（与「会话内卡片」共用，见
 * `inline-interactions/`）；这一层只剩**外框与键盘**。
 *
 * 键盘操作（与 `modals/authorization` 同一套约定）：
 *  - Tab / Shift+Tab / ↑↓←→  在「选项 → 自定义输入框 → 暂存 → 自定义 → 取消 → 确认」之间循环；
 *  - Space  选中 / 取消选中当前选项（选项上唯一的切换方式）；
 *  - Enter  有选中项（或填了自定义回复）时提交，没选则忽略；
 *  - Ctrl / Cmd + Enter  任意位置直接提交；Esc 取消。
 *
 * 打开时不聚焦「确认」：Enter 是两段式的（先空格选中、再回车提交），而一项未选时「确认」
 * 是 disabled、不可聚焦，故焦点落在永远可聚焦的弹窗容器上。
 */
import { useEffect, useRef } from 'react'
import { sessionStore } from '@/ui/store'
import './user-choice.scss'
import MarkdownRenderer from '../message/markdown-renderer'
import { navDelta, wrapIndex } from '@/ui/components/shared/keyboardNav'
import { t } from '@/ui/i18n'
import type { ChoiceDraft } from './choice-drafts'
import { useChoiceForm } from './choice-form'
import ChoiceBody from './choice-body'

interface Props {
  visible: boolean
  sessionId: string
  question: string
  options: string[]
  multi: boolean
  onConfirm: (result: UserChoiceResult) => void
  onCancel: () => void
  onShelve?: () => void
  /**
   * 预填草稿（暂存 → 恢复：同一个 `toolCallId` 上一次填的内容，见 `choice-drafts.ts`）。
   * ⚠️ 只在**挂载时**当初始值用：切走再切回来（可见性切换）不能重置表单，也不该被新草稿覆盖。
   */
  initialDraft?: ChoiceDraft
  /** 用户每次改动都上报（外部按 `sessionId|toolCallId` 缓存，恢复时再作为 `initialDraft` 传回） */
  onDraftChange?: (draft: ChoiceDraft) => void
}

/** 用户选择的结果：选中的选项 + 自定义补充回复 */
export interface UserChoiceResult {
  /** 选中的选项文本列表（可能为空） */
  selected: string[]
  /** 自定义补充回复（可能为空字符串） */
  customReply: string
}

export default function UserChoiceModal({
  visible,
  sessionId,
  question,
  options,
  multi,
  onConfirm,
  onCancel,
  onShelve,
  initialDraft,
  onDraftChange,
}: Props) {
  const form = useChoiceForm({ options, multi, initialDraft, onDraftChange })
  const backdropRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  // 从 sessionId 解析会话标题
  const sessionTitle =
    visible && sessionId ? sessionStore.getSession(sessionId)?.title || '' : ''

  // 每次被推到前台（含从别的待处理交互切回来）时，焦点落容器（永远可聚焦）：一项未选时「确认」
  // 是 disabled、不可聚焦，而 Enter 本身就是「有选才提交」。
  //
  // ⚠️ 这里**不再清空表单**（勾选的选项 / 自定义回复）：多个交互并发时用户可以切走再切回来接着答
  //（待应答队列见 tool-ui.tsx），清掉等于让他重填一遍。每个交互一个组件实例（key = interactionId），
  // 草稿天然按交互隔离；交互被应答出队后整个实例卸载。
  useEffect(() => {
    if (visible) modalRef.current?.focus()
  }, [visible])

  // ESC 关闭
  useEffect(() => {
    if (!visible) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [visible, onCancel])

  function handleConfirm() {
    onConfirm(form.value)
  }

  /**
   * 可键盘导航的项（按 DOM 顺序，由各元素 data-nav 标记）。跳过 disabled（一项未选时
   * 「确认」不可用）：与浏览器 tab 顺序一致，否则 .focus() 静默失败、高亮会「卡」在相邻项上。
   */
  function navNodes(): HTMLElement[] {
    return Array.from(
      modalRef.current?.querySelectorAll<HTMLElement>(
        '[data-nav]:not([disabled])',
      ) ?? [],
    )
  }

  /**
   * 弹窗级键盘处理，挂在遮罩层：内层弹窗的事件会冒泡上来，点遮罩空白处焦点也落在遮罩
   *（tabIndex={-1}），两条路径都能收到按键。Esc 不在这里接（已有 document 监听，会处理两次）。
   */
  function handleModalKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // 输入法正在选字：Enter / 方向键都属于输入法，不能当成弹窗操作
    //（自定义回复框的「回车选词」曾误触发确认）
    const native = e.nativeEvent
    if (native.isComposing || native.keyCode === 229) return

    const active = document.activeElement as HTMLElement | null
    const isOption = active?.dataset.nav === 'option'

    // Ctrl / Cmd + Enter：任意位置直接提交（同样要求“有选”）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (form.canConfirm) handleConfirm()
      return
    }

    // 带修饰键的组合属于应用 / 系统级快捷键（Alt+←/→ 在待处理交互间切换、Ctrl+Tab…）：
    // 弹窗不认，直接放行 —— 否则会被当成「弹窗内导航」抢掉
    if (e.altKey || e.ctrlKey || e.metaKey) return

    // 空格：切换选项（按钮上的空格是浏览器原生行为，不拦）
    if (e.key === ' ' && isOption) {
      e.preventDefault()
      form.toggleAt(Number(active.dataset.index))
      return
    }

    const delta = navDelta(e.key, e.shiftKey)
    if (delta !== 0) {
      // 光标在输入框里：只接管 Tab（切项），方向键留给光标移动
      const inText =
        active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA'
      if (inText && e.key !== 'Tab') return
      e.preventDefault() // 拦下 Tab 的原生跳转 → 焦点也不会跑出弹窗
      const list = navNodes()
      list[
        wrapIndex(list.indexOf(active as HTMLElement), delta, list.length)
      ]?.focus()
      return
    }

    if (e.key !== 'Enter') return
    // 焦点在按钮上：交给浏览器原生的「Enter = click」，避免同一次按键触发两次
    if (active?.tagName === 'BUTTON') return
    e.preventDefault()
    // 「有选才提交，没选忽略」：选项上也是这套，选中 / 取消一律走空格
    if (!form.canConfirm) return
    handleConfirm()
  }

  if (!visible) return null

  return (
    <div
      className="user-choice-backdrop"
      ref={backdropRef}
      tabIndex={-1}
      onKeyDown={handleModalKeyDown}>
      <div
        className="user-choice-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}>
        <div className="choice-header">
          {sessionTitle && (
            <div className="choice-session-badge">
              <span className="badge-dot" />
              {sessionTitle}
            </div>
          )}
          <h3 className="choice-title">
            <MarkdownRenderer content={question} />
          </h3>
        </div>

        <ChoiceBody
          form={form}
          onConfirm={handleConfirm}
          onCancel={onCancel}
          onShelve={onShelve}
        />
      </div>
    </div>
  )
}
