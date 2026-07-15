/**
 * Tooltip — 轻量级气泡提示，支持四个方向
 *
 * 用法：
 *   <Tooltip content="提示文字" direction="top">
 *     <button>hover me</button>
 *   </Tooltip>
 *
 * direction: top | bottom | left | right（默认 top）
 */
import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import './style.scss'

interface TooltipProps {
  content: string
  children: React.ReactNode
  direction?: 'top' | 'bottom' | 'left' | 'right'
}

function Tooltip({ content, children, direction = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<number>(null)

  const show = () => {
    clearTimeout(timerRef.current)
    if (!wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const gap = 8
    switch (direction) {
      case 'bottom':
        setPos({ top: rect.bottom + gap, left: rect.left + rect.width / 2 })
        break
      case 'left':
        setPos({ top: rect.top + rect.height / 2, left: rect.left - gap })
        break
      case 'right':
        setPos({ top: rect.top + rect.height / 2, left: rect.right + gap })
        break
      case 'top':
      default:
        setPos({ top: rect.top - gap, left: rect.left + rect.width / 2 })
        break
    }
    setVisible(true)
  }

  const hide = () => {
    timerRef.current = window.setTimeout(() => setVisible(false), 80)
  }

  return (
    <span
      className="tooltip-wrapper"
      ref={wrapRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}>
      {children}
      {visible &&
        createPortal(
          <div
            className={`tooltip-bubble ${direction}`}
            style={{
              top: pos.top,
              left: pos.left,
            }}>
            {content.split('\n').map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>,
          document.body,
        )}
    </span>
  )
}

export default Tooltip
