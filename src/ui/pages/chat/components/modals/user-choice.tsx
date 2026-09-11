/**
 * user-choice-modal — AI 向用户发起选择的弹窗
 *
 * 当 AI 调用 user_choice tool 时弹出，用户选择后继续 AI 的回复。
 * 内联实现 Modal，不依赖组件库中的 Modal 组件。
 */
import { useState, useEffect, useRef } from 'react'
import { sessionStore } from '@/ui/store'
import './user-choice.scss'
import MarkdownRenderer from '../message/markdown-renderer'

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
  const customInputRef = useRef<HTMLInputElement>(null)

  // 从 sessionId 解析会话标题
  const sessionTitle =
    visible && sessionId ? sessionStore.getSession(sessionId)?.title || '' : ''

  useEffect(() => {
    if (visible) {
      setSelected(new Set())
      setShowCustom(false)
      setCustomReply('')
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

  if (!visible) return null

  return (
    <div className="user-choice-backdrop" ref={backdropRef}>
      <div className="user-choice-modal">
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
            {safeOptions.map((opt) => {
              const isSelected = selected.has(opt)
              return (
                <div
                  key={opt}
                  className={`choice-option ${isSelected ? 'selected' : ''}`}
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
                placeholder={
                  selected.size > 0
                    ? '请输入补充内容'
                    : '输入自定义回复内容'
                }
                value={customReply}
                onChange={(e) => setCustomReply(e.target.value)}
                onKeyDown={(e) => {
                  // Enter 快速确认
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (canConfirm) handleConfirm()
                  }
                }}
              />
            </div>
          )}
        </div>

        <div className="choice-footer">
          <div className="choice-footer-left">
            {onShelve && (
              <button className="btn-shelve" onClick={onShelve}>
                暂存
              </button>
            )}
            <button
              className="btn-custom"
              onClick={() => {
                setShowCustom((v) => !v)
                // 展开时自动聚焦输入框
                setTimeout(() => customInputRef.current?.focus(), 0)
              }}>
              {showCustom ? '收起自定义' : '自定义'}
            </button>
          </div>
          <div className="choice-footer-right">
            <button className="btn-cancel" onClick={onCancel}>
              取消
            </button>
            <button
              className="btn-confirm"
              onClick={handleConfirm}
              disabled={!canConfirm}>
              确认{multi ? ` (已选 ${selected.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
