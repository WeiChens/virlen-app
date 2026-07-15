/**
 * quick-input-menu — 快捷输入菜单
 * 从 settingsState 读取快捷输入模板列表，点击填入输入框
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { settingsState } from '@/ui/store'
import type { QuickInputTemplate } from '@/ui/store'
import QuickInputSvg from '@/ui/components/icons/QuickInputSvg'
import { t } from '@/ui/i18n'

interface Props {
  /** 是否正在加载（加载中禁用） */
  loading?: boolean
  /** 选中模板后的回调 */
  onSelect: (template: QuickInputTemplate) => void
}

export default function QuickInputMenu({ loading, onSelect }: Props) {
  const [quickInputOpen, setQuickInputOpen] = useState(false)
  const quickInputRef = useRef<HTMLDivElement>(null)
  const templates = settingsState.value.quickInputTemplates

  // 外部点击关闭快捷输入弹窗
  useEffect(() => {
    if (!quickInputOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (
        quickInputRef.current &&
        !quickInputRef.current.contains(e.target as Node)
      ) {
        setQuickInputOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [quickInputOpen])

  const handleQuickInputClick = useCallback(
    (template: QuickInputTemplate) => {
      if (loading) return
      onSelect(template)
      setQuickInputOpen(false)
    },
    [loading, onSelect],
  )

  if (templates.length === 0) return null

  return (
    <div className="quick-input-wrapper" ref={quickInputRef}>
      <button
        className={`quick-input-btn ${quickInputOpen ? 'open' : ''}`}
        onClick={() => setQuickInputOpen(!quickInputOpen)}
        disabled={loading}
        title={t('快捷输入')}
        type="button">
        <QuickInputSvg />
      </button>
      {quickInputOpen && (
        <div className="quick-input-dropdown">
          <div className="quick-input-dropdown-header">{t('快捷输入')}</div>
          {templates
            .filter((t) => t.text?.trim())
            .map((t) => (
              <button
                key={t.id}
                className="quick-input-item"
                onClick={() => handleQuickInputClick(t)}
                type="button">
                <span className="quick-input-item-text">{t.text}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
