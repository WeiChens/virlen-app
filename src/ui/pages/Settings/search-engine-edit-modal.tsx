/**
 * search-engine-edit-modal — 搜索供应商编辑 / 添加弹窗：添加模式传 `templateType`（锁定类型、
 * 预填名称与地址），编辑模式传 `initialConfig`（可改所有字段）。
 */
import { useState, useEffect } from 'react'
import Modal from '@/ui/components/shared/Modal'
import type {
  SearchProviderConfig,
  SearchProviderType,
} from '@/domain/search/config'
import { SEARCH_PROVIDER_TEMPLATES } from '@/domain/search/config'
import { t } from '@/ui/i18n'
import PwdShow from '@/ui/components/icons/pwdShow'
import PwdHide from '@/ui/components/icons/pwdHide'
import { showToast } from '@/ui/components/shared/Toast'
import './search-engine-edit-modal.scss'
import { openUrl } from '@tauri-apps/plugin-opener'

interface Props {
  visible: boolean
  onClose: () => void
  onSave: (config: {
    name: string
    type: SearchProviderType
    apiKey: string
    baseUrl: string
  }) => void
  /** 添加模式：传入模板类型（如 'tavily'），锁定类型选择 */
  templateType?: SearchProviderType
  /** 编辑模式：传入已有配置 */
  initialConfig?: SearchProviderConfig
}

export default function SearchEngineEditModal({
  visible,
  onClose,
  onSave,
  templateType,
  initialConfig,
}: Props) {
  const isEdit = !!initialConfig
  const isAdd = !!templateType && !initialConfig

  const [label, setLabel] = useState('')
  const [type, setType] = useState<SearchProviderType>('tavily')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [validating, setValidating] = useState(false)

  const currentTemplate = SEARCH_PROVIDER_TEMPLATES.find((t) => t.type === type)

  useEffect(() => {
    if (!visible) return

    if (isEdit && initialConfig) {
      // —— 编辑模式：回填已有配置 ——
      setLabel(initialConfig.name)
      setType(initialConfig.type)
      setApiKey(initialConfig.apiKey)
      setBaseUrl(initialConfig.baseUrl)
    } else if (isAdd && templateType) {
      // —— 添加模式：从模板预填 ——
      const tmpl = SEARCH_PROVIDER_TEMPLATES.find(
        (t) => t.type === templateType,
      )
      setLabel(tmpl?.label ?? templateType)
      setType(templateType)
      setApiKey('')
      setBaseUrl(tmpl?.defaultBaseUrl ?? '')
    }

    setShowKey(false)
  }, [visible, templateType, initialConfig])
  const officialLink = SEARCH_PROVIDER_TEMPLATES.find(
    (t) => t.type === type,
  )?.officialLink
  const isValid =
    label.trim() &&
    type &&
    (currentTemplate?.requireApiKey ? apiKey.trim() : true) &&
    baseUrl.trim()

  const handleSave = async () => {
    if (!isValid) return
    if (!baseUrl.trim()) {
      showToast(t('请输入 API 地址'))
      return
    }

    // 保存并触发父组件的验证逻辑
    setValidating(true)
    try {
      await onSave({
        name: label.trim(),
        type,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
      })
    } finally {
      setValidating(false)
    }
  }

  const title = isEdit ? t('编辑搜索引擎') : t('配置搜索引擎')

  return (
    <Modal
      visible={visible}
      title={title}
      onClose={onClose}
      width={460}
      closeOnClickOutside={false}
      move
      footer={
        <>
          <button
            className="btn-cancel"
            onClick={onClose}
            disabled={validating}>
            {t('取消')}
          </button>
          <button
            className="btn-confirm"
            onClick={handleSave}
            disabled={!isValid || validating}>
            {validating ? t('验证中...') : isEdit ? t('保存') : t('添加')}
          </button>
        </>
      }>
      <div className="search-engine-edit-form">
        <div className="form-group">
          <label>{t('供应商')}</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('例如：我的 Tavily')}
            autoComplete="off"
            disabled
          />
        </div>
        {/* 名称 */}
        <div className="form-group">
          <label>{t('官网链接')}</label>
          <div
            onClick={() => {
              if (!officialLink) return
              openUrl(officialLink)
            }}
            className="official-link">
            {officialLink}
          </div>
        </div>

        {currentTemplate?.requireApiKey && (
          <div className="form-group">
            <label>{t('API Key')}</label>
            <div className="input-with-action">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('输入 API Key...')}
                autoComplete={showKey ? 'off' : 'new-password'}
              />
              <button
                type="button"
                className={`toggle-vis ${showKey ? 'active' : ''}`}
                onClick={() => setShowKey(!showKey)}
                title={showKey ? t('隐藏') : t('显示')}>
                {showKey ? <PwdShow /> : <PwdHide />}
              </button>
            </div>
          </div>
        )}

        {currentTemplate && !currentTemplate.requireApiKey && (
          <div className="form-group">
            <div className="no-key-hint">
              <span className="hint-icon">🔓</span>
              <span>{t('此搜索引擎无需 API Key，只需填写服务地址即可')}</span>
            </div>
          </div>
        )}

        <div className="form-group">
          <label>{t('API 地址')}</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://..."
            autoComplete="off"
            disabled
          />
        </div>
      </div>
    </Modal>
  )
}
