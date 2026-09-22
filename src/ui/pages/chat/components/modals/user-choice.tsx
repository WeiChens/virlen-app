/**
 * user-choice-modal — AI 向用户发起选择的弹窗
 *
 * 当 AI 调用 user_choice tool 时弹出，用户选择后继续 AI 的回复。
 * 内联实现 Modal，不依赖组件库中的 Modal 组件。
 *
 * 键盘操作（只用键盘也能完成选择，与 `modals/authorization` 同一套约定）：
 *  - Tab / Shift+Tab / ↑ ↓ ← →   在「选项 → 自定义输入框 → 暂存 → 自定义 → 取消 → 确认」之间循环切换；
 *  - Space                       选中 / 取消选中当前选项（选项上唯一的切换方式）；
 *  - Enter                       **有选中项（或填了自定义回复）时提交，没选时忽略**；
 *                                焦点在「暂存 / 自定义 / 取消 / 确认」按钮上时则等同于点击该按钮；
 *  - Ctrl / Cmd + Enter          任意位置直接提交（同样要求有选中项）；
 *  - Esc                         取消。
 *
 * 为什么打开时不把焦点放在「确认」上：Enter 是两段式的（先空格选中、再回车提交），
 * 而一项未选时「确认」是 disabled、不可聚焦，焦点因此落在弹窗容器上（永远可聚焦）。
 */
import { useState, useEffect, useRef } from 'react'
import { sessionStore } from '@/ui/store'
import './user-choice.scss'
import MarkdownRenderer from '../message/markdown-renderer'
import { navDelta, wrapIndex } from '@/ui/components/shared/keyboardNav'
import { t, tpl } from '@/ui/i18n'

interface Props {
  visible: boolean
  sessionId: string
  question: string
  options: string[]
  multi: boolean
  onConfirm: (result: UserChoiceResult) => void
  onCancel: () => void
  onShelve?: () => void
}

/** 用户选择的结渠：选中的选项 + 自定义补充回复 */
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
}: Props) {
  // AI 可能不传 options，兜底为空数组
  const safeOptions = Array.isArray(options) ? options : []

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showCustom, setShowCustom] = useState(false)
  const [customReply, setCustomReply] = useState('')
  const backdropRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const customInputRef = useRef<HTMLInputElement>(null)

  // 从 sessionId 解析会话标题
  const sessionTitle =
    visible && sessionId ? sessionStore.getSession(sessionId)?.title || '' : ''

  useEffect(() => {
    if (visible) {
      setSelected(new Set())
      setShowCustom(false)
      setCustomReply('')
      // 焦点落在弹窗容器上（永远可聚焦）。
      // 不抢「确认」：一项未选时它是 disabled、不可聚焦；而 Enter 本身就是「有选才提交」。
      modalRef.current?.focus()
    }
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

  function toggle(option: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(option)) {
        next.delete(option)
      } else {
        if (!multi) {
          next.clear()
        }
        next.add(option)
      }
      return next
    })
  }

  function handleConfirm() {
    onConfirm({
      selected: Array.from(selected),
      customReply: customReply.trim(),
    })
  }

  const canConfirm = selected.size > 0 || customReply.trim().length > 0

  /**
   * 弹窗里可键盘导航的项（按 DOM 顺序）—— 由各元素上的 data-nav 标记，条件渲染自动增删。
   * 跳过 disabled（一项未选时「确认」不可用）：与浏览器 tab 顺序一致，
   * 否则 .focus() 静默失败、高亮会「卡」在相邻项上。
   */
  function navNodes(): HTMLElement[] {
    return Array.from(
      modalRef.current?.querySelectorAll<HTMLElement>(
        '[data-nav]:not([disabled])',
      ) ?? [],
    )
  }

  /** 切换第 index 个选项（只拿 data-index 回查，越界忽略） */
  function toggleAt(index: number) {
    const opt = safeOptions[index]
    if (opt === undefined) return
    toggle(opt)
  }

  /**
   * 弹窗级键盘处理。
   * 挂在**遮罩层**（而不是内层弹窗）上：内层弹窗的事件会冒泡到这里，
   * 点遮罩空白处时焦点也落在遮罩上（tabIndex={-1}）—— 两条路径都能收到按键。
   * Esc 不在这里接 —— 上面已有 document 监听，两处同时处理会 reject 两次。
   */
  function handleModalKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // 中文输入法正在选字：Enter / 方向键都属于输入法，不能当成弹窗操作。
    // （自定义回复框里「回车选词」曾经会被当成确认弹窗。）
    const native = e.nativeEvent
    if (native.isComposing || native.keyCode === 229) return

    const active = document.activeElement as HTMLElement | null
    const isOption = active?.dataset.nav === 'option'

    // Ctrl / Cmd + Enter：任意位置直接提交（同样要求“有选”）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (canConfirm) handleConfirm()
      return
    }

    // 空格：切换选项（按钮上的空格是浏览器原生行为，不拦）
    if (e.key === ' ' && isOption) {
      e.preventDefault()
      toggleAt(Number(active.dataset.index))
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
    // 「有选才提交，没选忽略」—— 选项上也是这套：
    // 选中/取消一律走空格，因此这里既不切换选中，也不做任何「引导」动作
    if (!canConfirm) return
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

        <div className="choice-body">
          <div className="choice-options">
            {safeOptions.map((opt, index) => {
              const isSelected = selected.has(opt)
              return (
                <div
                  key={opt}
                  className={`choice-option ${isSelected ? 'selected' : ''}`}
                  data-nav="option"
                  data-index={index}
                  tabIndex={0}
                  role="checkbox"
                  aria-checked={isSelected}
                  onClick={() => toggle(opt)}>
                  <span className="choice-checkbox">
                    {multi ? (
                      <span
                        className={`check-box ${isSelected ? 'checked' : ''}`}>
                        {isSelected ? '✓' : ''}
                      </span>
                    ) : (
                      <span
                        className={`radio-box ${isSelected ? 'checked' : ''}`}>
                        {isSelected ? '●' : ''}
                      </span>
                    )}
                  </span>
                  <span className="choice-label">{opt}</span>
                </div>
              )
            })}
          </div>

          {/* 自定义回复输入框 —— 默认隐藏，点击「自定义」按钮后显示 */}
          {showCustom && (
            <div className="choice-custom-reply">
              <input
                ref={customInputRef}
                className="custom-reply-input"
                data-nav="input"
                placeholder={
                  selected.size > 0
                    ? t('请输入补充内容')
                    : t('输入自定义回复内容')
                }
                value={customReply}
                onChange={(e) => setCustomReply(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="choice-footer">
          <div className="choice-footer-left">
            {onShelve && (
              <button className="btn-shelve" data-nav="button" onClick={onShelve}>
                {t('暂存')}
              </button>
            )}
            <button
              className="btn-custom"
              data-nav="button"
              onClick={() => {
                setShowCustom((v) => !v)
                // 展开时自动聚焦输入框
                setTimeout(() => customInputRef.current?.focus(), 0)
              }}>
              {showCustom ? t('收起自定义') : t('自定义')}
            </button>
          </div>
          <div className="choice-footer-right">
            <button className="btn-cancel" data-nav="button" onClick={onCancel}>
              {t('取消')}
            </button>
            <button
              className="btn-confirm"
              data-nav="button"
              onClick={handleConfirm}
              disabled={!canConfirm}>
              {t('确认')}{multi ? tpl(' (已选 $__count__)', { count: selected.size }) : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
