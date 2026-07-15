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
  onConfirm: (selected: string | string[]) => void
  onCancel: () => void
  onShelve?: () => void
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
  const backdropRef = useRef<HTMLDivElement>(null)

  // 从 sessionId 解析会话标题
  const sessionTitle =
    visible && sessionId ? sessionStore.getSession(sessionId)?.title || '' : ''

  useEffect(() => {
    if (visible) setSelected(new Set())
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
    if (multi) {
      onConfirm(Array.from(selected))
    } else {
      const first = selected.values().next().value
      if (first) onConfirm(first)
    }
  }

  const canConfirm = selected.size > 0

  if (!visible) return null

  return (
    <div
      className="user-choice-backdrop"
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === backdropRef.current) onCancel()
      }}>
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
        </div>

        <div className="choice-footer">
          {onShelve && (
            <button className="btn-shelve" onClick={onShelve}>
              暂存
            </button>
          )}
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
