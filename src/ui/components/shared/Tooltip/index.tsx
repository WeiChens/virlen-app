/**
 * Tooltip — 轻量气泡提示，direction: top（默认）| bottom | left | right
 *
 * 用法：<Tooltip content="提示文字" direction="top"><button>hover me</button></Tooltip>
 * disabled 见下（元素上已弹了右键菜单这类浮层时传 true）。
 */
import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import './style.scss'

interface TooltipProps {
  content: string
  children: React.ReactNode
  direction?: 'top' | 'bottom' | 'left' | 'right'
  /**
   * 临时禁用气泡：本元素上已弹了别的浮层（如右键菜单）时用。
   *
   * 靠鼠标事件收不掉：菜单弹出时鼠标仍停在元素上，不会触发 `mouseleave` → 气泡不隐藏，
   * 而它的 `z-index`（9999）高于菜单（600），会直接盖在菜单上，只能由调用方显式禁用。
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
    // 禁用时一律不弹（不能先弹出来再被盖住，会闪一下）
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
      {/* `!disabled` 是双保险：disabled 在气泡已显示后才变 true，show() 的早退拦不住 */}
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
