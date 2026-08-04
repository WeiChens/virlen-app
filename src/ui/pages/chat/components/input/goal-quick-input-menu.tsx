/**
 * goal-quick-input-menu — 验证目标快捷输入菜单
 * 读取 settingsState.goalQuickInputTemplates，在 goal-input-row 内点击填入 Goal 输入框
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { settingsState } from '@/ui/store'
import type { QuickInputTemplate } from '@/ui/store'
import { t } from '@/ui/i18n'

interface Props {
  /** 选中模板后的回调 */
  onSelect: (template: QuickInputTemplate) => void
  /** 是否禁用 */
  disabled?: boolean
}

export default function GoalQuickInputMenu({ onSelect, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const templates = settingsState.value.goalQuickInputTemplates

  // 外部点击关闭
  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleSelect = useCallback(
    (template: QuickInputTemplate) => {
      if (disabled) return
      onSelect(template)
      setOpen(false)
    },
    [disabled, onSelect],
  )

  // 无模板则不渲染
  const items = templates.filter((t) => t.text?.trim())
  if (items.length === 0) return null

  return (
    <div className="goal-quick-input-wrapper" ref={wrapperRef}>
      <button
        className={`goal-quick-input-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={t('验证目标快捷输入')}
        type="button">
        <svg
          viewBox="0 0 1024 1024"
          version="1.1"
          xmlns="http://www.w3.org/2000/svg"
          width="13"
          height="13">
          <path
            d="M384 64L170.666667 554.666667H384V960L853.333333 384H576V64H384Z"
            p-id="12346"></path>
        </svg>
      </button>
      {open && (
        <div className="goal-quick-input-dropdown">
          <div className="goal-quick-input-header">{t('验证目标')}</div>
          {items.map((item) => (
            <button
              key={item.id}
              className="goal-quick-input-item"
              onClick={() => handleSelect(item)}
              type="button">
              <span className="goal-quick-input-item-text">{item.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
