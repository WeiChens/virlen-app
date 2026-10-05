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
import { t } from '@/ui/i18n'

export interface SelectOption {
  value: any
  label: string
  title?: string,
}

/** 下拉面板高度上限（与 style.scss 的 .custom-select__dropdown max-height 一致） */
const DROPDOWN_MAX_HEIGHT = 240
/** 量不到真实行高时的兜底值（medium 字号下的实测行高）；jsdom 没有布局引擎，单测会走到这里 */
const FALLBACK_ROW_HEIGHT = 34
/** style.scss 里 .custom-select__option 的 margin-bottom */
const ROW_GAP = 2
/** style.scss 里 .custom-select__dropdown 的 padding（4px × 2） */
const DROPDOWN_PADDING = 8

/**
 * 估算展开后的下拉面板高度。
 *
 * 行高由调用方**实测**传入，因此面板高度会跟着用户字号变：
 * 字号调大 → 行高变大 → 面板更高。
 */
export function dropdownContentHeight(rowHeight: number, count: number): number {
  return rowHeight * count + ROW_GAP * Math.max(count - 1, 0) + DROPDOWN_PADDING
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
  placeholder = t('请选择'),
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
    /* 行高必须实测，不能写死「每行 34px」：行高 = 字号 × 行高倍率 + 上下内边距，
       用户把字号调大时每行会一起变高，写死就会低估面板高度，
       「下面还放得下吗」的判断跟着错 → 面板被视口裁掉。 */
    const row = dropdownRef.current?.querySelector<HTMLElement>('.custom-select__option')
    const rowHeight = row?.getBoundingClientRect().height || FALLBACK_ROW_HEIGHT
    const h = Math.min(
      dropdownContentHeight(rowHeight, options.length),
      DROPDOWN_MAX_HEIGHT,
    )
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
      /* 选中项的说明也挂到触发器上：不展开下拉也能看到（如终端权限的风险提示） */
      title={selectedOption?.title}
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
              onMouseEnter={() => setActiveIndex(i)}
              title={opt.title}>
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
