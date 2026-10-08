/**
 * Select — 自定义下拉选择器，替代原生 <select>：统一样式、Portal 渲染面板（不被 overflow 裁剪）、
 * 点击外部关闭、键盘导航（↑↓ 切换，Enter/Space 选中，Esc 关闭）。
 *
 * 面板宽度有两种策略（`dropdownWidth`）：默认与触发器等宽；'content' 由选项文案撑开 ——
 * 长文件路径这类内容折行后行高不齐，比截断更难扫读，故单行 + 省略号，宽度上限 500px。
 * 面板经 Portal 挂在 body 上、不在调用方子树里，换肤只能靠 `dropdownClassName` 给抓手。
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

/** 面板宽度策略：'trigger' 与触发器等宽；'content' 由选项文案撑开（上限 dropdownMaxWidth） */
export type SelectDropdownWidth = 'trigger' | 'content'

/** 下拉面板高度上限（与 style.scss 的 .custom-select__dropdown max-height 一致） */
const DROPDOWN_MAX_HEIGHT = 240
/** 量不到行高时的兜底（medium 字号实测值）；jsdom 无布局引擎，单测会走到这里 */
const FALLBACK_ROW_HEIGHT = 34
/** 与 .custom-select__option 的 margin-bottom 一致 */
const ROW_GAP = 2
/** .custom-select__dropdown 的 padding（4px × 2） */
const DROPDOWN_PADDING = 8
/** 面板与视口边缘的安全距离（px）：'content' 模式的面板可比触发器宽出去几百像素 */
const VIEWPORT_MARGIN = 8
/** 'content' 模式的宽度上限默认值（px）：长路径全展开会铺满屏幕，500 够看清文件名，再长就打省略号 */
export const DROPDOWN_CONTENT_MAX_WIDTH = 500

/**
 * 估算展开后的面板高度。
 * 行高由调用方**实测**传入，因此面板高度跟着用户字号变（字号调大 → 面板更高）。
 */
export function dropdownContentHeight(rowHeight: number, count: number): number {
  return rowHeight * count + ROW_GAP * Math.max(count - 1, 0) + DROPDOWN_PADDING
}

/** 视口宽度（jsdom / SSR 里没有 window 时返回 0，由调用方退回原值） */
function viewportWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth
}

/**
 * 'content' 模式的宽度上限：调用方给的值与视口可用宽度取小（面板再宽也放不进视口），
 * 但不小于触发器宽度（比触发器还窄的下拉看着像掉了角）。
 */
export function dropdownContentMaxWidth(
  triggerWidth: number,
  preferred = DROPDOWN_CONTENT_MAX_WIDTH,
  vw = viewportWidth(),
): number {
  return Math.max(triggerWidth, Math.min(preferred, vw - VIEWPORT_MARGIN * 2))
}

/**
 * 面板比触发器宽时不能顶出视口右缘：由右边界回推左边界。
 * 未溢出时原样返回 —— 默认模式（与触发器等宽）的位置一动不动。
 */
export function clampDropdownLeft(
  left: number,
  width: number,
  vw = viewportWidth(),
): number {
  if (!vw) return left
  const maxLeft = vw - width - VIEWPORT_MARGIN
  return left > maxLeft ? Math.max(VIEWPORT_MARGIN, maxLeft) : left
}

interface SelectProps {
  value: any
  onChange: (value: any) => void
  options: SelectOption[]
  className?: string
  disabled?: boolean
  placeholder?: string
  width?: number | string
  /** 下拉面板的附加 class（面板经 Portal 挂在 body 上，深色场景换肤只能在这里给抓手） */
  dropdownClassName?: string
  /** 面板宽度策略，默认 'trigger'（与触发器等宽） */
  dropdownWidth?: SelectDropdownWidth
  /** 'content' 策略的宽度上限（px），默认 500 */
  dropdownMaxWidth?: number
}

function Select({
  value,
  onChange,
  options,
  className = '',
  disabled = false,
  placeholder = t('请选择'),
  width,
  dropdownClassName,
  dropdownWidth = 'trigger',
  dropdownMaxWidth = DROPDOWN_CONTENT_MAX_WIDTH,
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
    /* 行高必须实测，不能写死「每行 34px」：行高 = 字号 × 倍率 + 内边距，用户调大字号后
       写死会低估面板高度，「下面还放得下吗」的判断跟着错 → 面板被视口裁掉。 */
    const row = dropdownRef.current?.querySelector<HTMLElement>('.custom-select__option')
    const rowHeight = row?.getBoundingClientRect().height || FALLBACK_ROW_HEIGHT
    const h = Math.min(
      dropdownContentHeight(rowHeight, options.length),
      DROPDOWN_MAX_HEIGHT,
    )
    /* 'content' 模式的面板宽度由 `width: max-content`（+ min/max-width）定，**与 left 无关** ——
       所以这里量到的就是最终宽度，据此把面板拉回视口内（长路径的面板可比触发器宽几百像素）。
       jsdom 没有布局引擎、量到 0，退回触发器宽度即可。 */
    const panelWidth = dropdownRef.current?.getBoundingClientRect().width || rect.width
    setDropdownStyle({
      ...(dropdownWidth === 'content'
        ? {
            width: 'max-content',
            minWidth: rect.width,
            maxWidth: dropdownContentMaxWidth(rect.width, dropdownMaxWidth),
          }
        : { width: rect.width }),
      left: clampDropdownLeft(rect.left, panelWidth),
      ...(spaceBelow >= h || spaceBelow >= rect.top
        ? { top: rect.bottom + 4 }
        : { bottom: window.innerHeight - rect.top + 4 }),
    })
  }, [options.length, dropdownWidth, dropdownMaxWidth])

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
        <div
          className={[
            'custom-select__dropdown',
            dropdownWidth === 'content' ? 'is-content-width' : '',
            dropdownClassName,
          ]
            .filter(Boolean)
            .join(' ')}
          ref={dropdownRef}
          style={dropdownStyle}
          role="listbox">
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
