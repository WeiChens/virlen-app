import { useEffect, useRef, ReactNode, useState } from 'react'
import './style.scss'

export interface ModalProps {
  visible: boolean
  title?: string
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  width?: number | string
  height?: number | string
  closeOnClickOutside?: boolean
  showCloseButton?: boolean
  className?: string
  /** 是否显示遮罩层，为 false 时不阻止用户点击外部 */
  mask?: boolean
  /** 是否允许拖动弹窗，以 modal-header 作为拖拽控件 */
  move?: boolean
}

function Modal({
  visible,
  title,
  onClose,
  children,
  footer,
  width = 500,
  height = 'auto',
  closeOnClickOutside = false,
  showCloseButton = true,
  className = '',
  mask = true,
  move = false,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })

  // 点击外部关闭
  useEffect(() => {
    if (!closeOnClickOutside || !visible) return

    const handleClickOutside = (event: MouseEvent) => {
      if (
        modalRef.current &&
        !modalRef.current.contains(event.target as Node)
      ) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [visible, closeOnClickOutside, onClose])

  // ESC键关闭
  useEffect(() => {
    if (!visible) return

    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('keydown', handleEsc)
    }
  }, [visible, onClose])

  // 拖拽功能
  useEffect(() => {
    if (!move || !visible) return

    const header = headerRef.current
    if (!header) return

    const handleMouseDown = (e: MouseEvent) => {
      // 如果点击的是关闭按钮，不触发拖拽
      if ((e.target as HTMLElement).closest('.modal-close')) return
      e.preventDefault()
      isDragging.current = true
      dragStart.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      }
      header.style.cursor = 'grabbing'
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return

      setPosition({
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      })
    }

    const handleMouseUp = () => {
      isDragging.current = false
      header.style.cursor = 'grab'
    }

    header.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      header.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [move, visible, position.x, position.y])

  // visible 变化时重置位置
  useEffect(() => {
    if (visible) {
      setPosition({ x: 0, y: 0 })
    }
  }, [visible])

  if (!visible) return null

  return (
    <div className={`modal-overlay ${mask ? '' : 'no-mask'}`}>
      <div
        className={`modal-content ${className}`}
        ref={modalRef}
        style={{
          width: typeof width === 'number' ? `${width}px` : width,
          height: typeof height === 'number' ? `${height}px` : height,
          transform: move
            ? `translate(${position.x}px, ${position.y}px)`
            : undefined,
        }}>
        {/* 头部 */}
        {(title || showCloseButton) && (
          <div
            className={`modal-header ${move ? 'draggable' : ''}`}
            ref={headerRef}
            draggable={false}>
            {title && <h3>{title}</h3>}
            {showCloseButton && (
              <button className="modal-close" onClick={onClose}>
                ✕
              </button>
            )}
          </div>
        )}

        {/* 内容 */}
        <div className="modal-body">{children}</div>

        {/* 底部 */}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

// 默认底部按钮组件
interface ModalFooterButtonsProps {
  onCancel: () => void
  onConfirm: () => void
  cancelText?: string
  confirmText?: string
  confirmLoading?: boolean
}

export function ModalFooterButtons({
  onCancel,
  onConfirm,
  cancelText = '取消',
  confirmText = '确认',
  confirmLoading = false,
}: ModalFooterButtonsProps) {
  return (
    <>
      <button
        className="btn-cancel"
        onClick={onCancel}
        disabled={confirmLoading}>
        {cancelText}
      </button>
      <button
        className="btn-confirm"
        onClick={onConfirm}
        disabled={confirmLoading}>
        {confirmLoading ? '处理中...' : confirmText}
      </button>
    </>
  )
}

export default Modal
