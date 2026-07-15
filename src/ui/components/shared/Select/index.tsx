/**
 * Select — 自定义下拉选择器
 *
 * 替换原生 <select>，提供统一视觉风格和更好的交互体验。
 *
 * 功能：
 *  - 点击展开/收起
 *  - 点击外部自动关闭
 *  - 键盘导航（↑↓ 切换选项，Enter/Space 选中，Esc 关闭）
 *  - Portal 渲染下拉面板，避免 overflow 裁剪
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import './style.scss'

export interface SelectOption {
  value: any
  label: string
}

interface SelectProps {
  value: any
  onChange: (value: any) => void
  options: SelectOption[]
  className?: string
  disabled?: boolean
  placeholder?: string
  width?: number | string
}

function Select({
  value,
  onChange,
  options,
  className = '',
  disabled = false,
  placeholder = '请选择',
  width,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  )

  const close = useCallback(() => {
    setOpen(false)
    setActiveIndex(-1)
  }, [])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        close()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open, close])

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const h = Math.min(options.length * 34 + 8, 240)
    setDropdownStyle({
      left: rect.left,
      width: rect.width,
      ...(spaceBelow >= h || spaceBelow >= rect.top
        ? { top: rect.bottom + 4 }
        : { bottom: window.innerHeight - rect.top + 4 }),
    })
  }, [options.length])

  useEffect(() => {
    if (!open) return
    updateDropdownPosition()
    const fn = () => updateDropdownPosition()
    document.addEventListener('scroll', fn, true)
    window.addEventListener('resize', fn)
    return () => {
      document.removeEventListener('scroll', fn, true)
      window.removeEventListener('resize', fn)
    }
  }, [open, updateDropdownPosition])

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value)
      setActiveIndex(idx >= 0 ? idx : 0)
    }
  }, [open, options, value])

  const handleSelect = useCallback(
    (opt: SelectOption) => {
      onChange(opt.value)
      close()
    },
    [onChange, close],
  )

  const handleTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        if (!open) {
          setOpen(true)
        } else if (e.key === 'Enter' || e.key === ' ') {
          if (activeIndex >= 0 && activeIndex < options.length) {
            handleSelect(options[activeIndex])
          }
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!open) { setOpen(true) } else {
          setActiveIndex((p) => (p <= 0 ? options.length - 1 : p - 1))
        }
      } else if (e.key === 'ArrowDown' && open) {
        e.preventDefault()
        setActiveIndex((p) => (p >= options.length - 1 ? 0 : p + 1))
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        close()
      }
    },
    [disabled, open, activeIndex, options, handleSelect, close],
  )

  return (
    <div
      className={['custom-select', className, disabled ? 'is-disabled' : '', open ? 'is-open' : ''].filter(Boolean).join(' ')}
      ref={triggerRef}
      tabIndex={disabled ? -1 : 0}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      style={width ? { width: typeof width === 'number' ? `${width}px` : width } : undefined}
      onKeyDown={handleTriggerKeyDown}
      onClick={() => { if (!disabled) setOpen((v) => !v) }}>
      <div className="custom-select__trigger">
        <span className={['custom-select__value', !selectedOption ? 'is-placeholder' : ''].filter(Boolean).join(' ')}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <span className="custom-select__arrow">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </div>
      {open && createPortal(
        <div className="custom-select__dropdown" ref={dropdownRef} style={dropdownStyle} role="listbox">
          {options.map((opt, i) => (
            <div
              key={opt.value}
              className={['custom-select__option', opt.value === value ? 'is-selected' : '', i === activeIndex ? 'is-active' : ''].filter(Boolean).join(' ')}
              role="option"
              aria-selected={opt.value === value}
              onClick={(e) => { e.stopPropagation(); handleSelect(opt) }}
              onMouseEnter={() => setActiveIndex(i)}>
              {opt.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

export default Select
