/**
 * ProviderSelect — 引导流程内的模型服务商下拉选择器
 *
 * 自定义下拉框：展示服务商图标 + 名称，展开后附带宽高信息（baseUrl）。
 * 点击外部自动关闭。
 */
import { useState, useRef, useEffect } from 'react'
import { t } from '@/ui/i18n'
import { getProviderIcon } from '@/ui/pages/Settings/provider-icons'
import { providerService } from '@/services/provider-service'
import './style.scss'

interface Props {
  value: string | null
  onChange: (v: string) => void
}

function ProviderSelect({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  // 必须在渲染期读模板表，不能在模块顶层读：本模块经 `App.tsx` 静态导入，ES 模块求值先于 `main.ts` 的
  // `main()` —— 那一刻 `providerCatalog()` 的快照还是 `null`，会 fail-fast 抛错，整个应用起不来。
  const options = providerService.getDefaultProviderList()
  const selected = options.find((opt) => opt.templateName === value)

  return (
    <div className="provider-select" ref={ref}>
      <button
        className="provider-select-trigger"
        onClick={() => setOpen(!open)}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}>
        {selected ? (
          <>
            <span className="provider-select-icon">
              {getProviderIcon(selected.templateName)}
            </span>
            <span className="provider-select-label">{t(selected.label)}</span>
          </>
        ) : (
          <span className="provider-select-placeholder">
            {t('请选择模型服务商')}
          </span>
        )}
        <span className={`provider-select-arrow${open ? ' open' : ''}`}>▼</span>
      </button>

      {open && (
        <div className="provider-select-dropdown" role="listbox">
          {options.map((opt) => (
            <button
              key={opt.templateName}
              className={`provider-select-item${value === opt.templateName ? ' active' : ''}`}
              role="option"
              aria-selected={value === opt.templateName}
              onClick={() => {
                onChange(opt.templateName)
                setOpen(false)
              }}
              type="button">
              <span className="provider-select-icon">
                {getProviderIcon(opt.templateName)}
              </span>
              <span className="provider-select-label">{t(opt.label)}</span>
              <span className="provider-select-url">{opt.baseUrl}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default ProviderSelect
