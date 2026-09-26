/**
 * Tooltip — 轻量级气泡提示，支持四个方向
 *
 * 用法：
 *   <Tooltip content="提示文字" direction="top">
 *     <button>hover me</button>
 *   </Tooltip>
 *
 * direction: top | bottom | left | right（默认 top）
 * disabled: 临时禁用气泡（本元素上已弹了右键菜单这类浮层时传 true）
 */
import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import './style.scss'

interface TooltipProps {
  content: string
  children: React.ReactNode
  direction?: 'top' | 'bottom' | 'left' | 'right'
  /**
   * 临时禁用气泡：本元素上已经弹了别的浮层（如右键菜单）时用。
   *
   * 为什么不能靠鼠标事件收掉：右键菜单弹出时鼠标还停在元素上，不会触发 `mouseleave` →
   * 气泡不会自己隐藏，而它的 `z-index`（9999）高于菜单（600），会直接盖在菜单上。
   * 所以需要调用方显式禁用。
   */
  disabled?: boolean
}

function Tooltip({ content, children, direction = 'top', disabled = false }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<number>(null)

  const show = () => {
    clearTimeout(timerRef.current ?? undefined)
    // 被禁用时一律不弹（一次也不能先弹出来再被盖住，会闪一下）
    if (disabled) return
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
      {/* `!disabled` 是双保险：disabled 是在气泡已显示后变 true 的（右键那一刻），
          只靠 show() 早退拦不住已经亮着的那一个 */}
      {visible &&
        !disabled &&
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
