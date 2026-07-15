/**
 * provider-edit-modal — Provider 编辑/添加表单
 * 纯 UI 组件，不依赖 store，通过 props 传值
 */
import { useState, useEffect } from 'react'
import Modal from '@/ui/components/shared/Modal'
import type { ModelInfo, ProviderConfig, ProviderType } from '@/types'
import './provider-edit-modal.scss'
import { showToast } from '@/ui/components/shared/Toast'
import { t, tpl } from '@/ui/i18n'
import PwdShow from '@/ui/components/icons/pwdShow'
import PwdHide from '@/ui/components/icons/pwdHide'
import Select from '@/ui/components/shared/Select'
import { openUrl } from '@tauri-apps/plugin-opener'
import { isURL } from '@/utils/common'
import { createProviderInstance } from '@/infrastructure/provider'
import { providerService } from '@/services/provider-service'

interface Props {
  visible: boolean
  onClose: () => void
  onSave: (config: {
    name: string
    type: ProviderType
    apiKey: string
    baseUrl: string
    models: ModelInfo[]
    templateName: any
    reasoningEffort?: string
  }) => void
  template?: {
    templateName: string
    type: ProviderType
    label: string
    baseUrl: string
    allowReasoningEffortList?: string[]
  }
  initialConfig?: {
    name: string
    templateName: string
    type: ProviderType
    apiKey: string
    baseUrl: string
    models: ModelInfo[]
    reasoningEffort?: string
  }
}

export default function ProviderEditModal({
  visible,
  onClose,
  onSave,
  template,
  initialConfig,
}: Props) {
  const isEdit = !!initialConfig

  const [label, setLabel] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [type, setType] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [newModelId, setNewModelId] = useState('')
  const [fetching, setFetching] = useState(false)
  const [reasoningEffort, setReasoningEffort] = useState('')
  useEffect(() => {
    if (visible) {
      if (initialConfig) {
        setLabel(initialConfig.name)
        setType(initialConfig.type)
        setApiKey(initialConfig.apiKey)
        setBaseUrl(initialConfig.baseUrl)
        setTemplateName(initialConfig.templateName)
        setModels(initialConfig.models || [])
        setReasoningEffort(initialConfig.reasoningEffort || '')
      } else if (template) {
        setLabel(t(template.label))
        setType(template.type)
        setApiKey('')
        setBaseUrl(template.baseUrl)
        setTemplateName(template.templateName)
        setModels([])
        setReasoningEffort('')
      } else {
        // 无模板时默认 openai 类型
        setType('openai')
        setApiKey('')
        setBaseUrl('')
        setTemplateName('custom')
        setModels([])
        setReasoningEffort('')
      }
      setShowKey(false)
      setNewModelId('')
    }
  }, [visible, initialConfig, template])

  const isValid = label.trim() && type && (template || baseUrl.trim())

  function addModel() {
    const id = newModelId.trim()
    if (!id) return
    if (models.includes(id)) return
    setModels([...models, id])
    setNewModelId('')
  }

  function removeModel(modelId: string) {
    setModels(models.filter((m) => m !== modelId))
  }

  // 编辑模式下：当外部 stores 更新了 models 时同步到弹窗内部 state
  useEffect(() => {
    if (isEdit && initialConfig?.models?.length) {
      setModels(initialConfig.models)
    }
  }, [isEdit, initialConfig?.models?.length])

  function handleSave() {
    if (!isValid) return
    if (!baseUrl.trim()) {
      showToast(t('请输入 API 地址'))
      return
    }
    if (isURL(baseUrl.trim()) === false) {
      showToast(t('请输入正确的 API 地址'))
      return
    }
    onSave({
      name: label.trim(),
      type: type as ProviderType,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      models,
      templateName: templateName,
      reasoningEffort: reasoningEffort || undefined,
    })
  }
  const onFetchModels = () => {
    if (!apiKey.trim()) {
      showToast(t('请输入 API Key'))
      return
    }
    const config: ProviderConfig = {
      name: label.trim(),
      type: type as ProviderType,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      models,
      reasoningEffort: reasoningEffort || undefined,
      templateName: templateName as any,
      id: initialConfig ? initialConfig.name : `temp-${templateName}`,
      enabled: true,
      createdAt: null,
      updatedAt: null,
    }
    const provider = createProviderInstance(config)
    setFetching(true)
    provider
      .listModels()
      .then((fetchedModels) => {
        setModels(fetchedModels)
      })
      .catch((e) => {
        console.error('获取失败:', e.message || e.toString())
        showToast(
          tpl('获取失败: $__error__', { error: e.message || e.toString() }),
          3000,
        )
      })
      .finally(() => {
        setFetching(false)
      })
  }
  const currentTemplate = providerService
    .getDefaultProviderList()
    .find((t) => t.templateName === templateName)
  const allowTypeList = currentTemplate?.allowTypeList || []

  const allowReasoningEffortList =
    currentTemplate?.allowReasoningEffortList || []

  // 当模板切换时自动更新 type 和 baseUrl
  useEffect(() => {
    if (currentTemplate && !initialConfig) {
      // 仅新建时自动填充
      const tmplType = currentTemplate.type
      setType(tmplType)
      // 查找当前 type 对应的 baseUrl
      if (allowTypeList.length > 0) {
        const matched = allowTypeList.find((t) => t.type === tmplType)
        if (matched) setBaseUrl(matched.baseUrl)
      } else {
        setBaseUrl(currentTemplate.baseUrl)
      }
      setReasoningEffort('')
    }
  }, [templateName])

  return (
    <Modal
      visible={visible}
      title={isEdit ? t('编辑模型服务') : t('添加模型服务')}
      onClose={onClose}
      width={480}
      closeOnClickOutside={false}
      move>
      <div className="provider-edit-form">
        <div className="form-group">
          <label>{t('名称')}</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('例如：我的 DeepSeek')}
            autoComplete="off"
          />
        </div>

        <div className="form-group">
          <label>{t('类型')}</label>
          {allowTypeList.length > 0 ? (
            <Select
              value={type}
              onChange={(v) => {
                setType(v)
                const baseUrl =
                  allowTypeList.find((t) => t.type === v)?.baseUrl || ''
                setBaseUrl(baseUrl)
              }}
              options={allowTypeList.map((t) => ({
                value: t.type,
                label: t.type,
              }))}
              width={200}
            />
          ) : (
            <Select
              value={type}
              onChange={(v) => setType(v)}
              disabled={templateName !== 'custom'}
              options={[
                { value: 'openai', label: 'OpenAI' },
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'gemini', label: 'Gemini' },
              ]}
              width={200}
            />
          )}
        </div>

        <div className="form-group">
          <label>{t('API 地址')}</label>
          <div className="api-input-wrapper">
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              disabled={templateName !== 'custom'}
              autoComplete="off"
            />
            {currentTemplate?.officialLink && (
              <a
                className="link"
                onClick={() => {
                  openUrl(currentTemplate.officialLink)
                }}>
                {t('服务商网址')}
              </a>
            )}
          </div>
        </div>
        <div className="form-group">
          <label>{t('API Key')}</label>
          <div className="input-with-action">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="xx-..."
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

        <div className="form-group">
          <div className="row">
            <label>{t('模型列表')}</label>
            <span
              className="clear"
              onClick={() => {
                setModels([])
              }}>
              {t('清空')}
            </span>
          </div>
          <div className="model-list-section">
            <div className="model-list-tags">
              {models.length === 0 && (
                <span className="model-empty">{t('暂未添加模型')}</span>
              )}
              {models.map((m) => (
                <span key={m} className="model-tag">
                  {m}
                  <button
                    type="button"
                    className="model-tag-remove"
                    onClick={() => removeModel(m)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="model-input-row">
              <input
                type="text"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addModel()}
                placeholder={t('输入模型 ID，回车添加')}
                autoComplete="off"
              />
              <button
                type="button"
                className="model-add-btn"
                onClick={addModel}
                disabled={!newModelId.trim()}>
                +
              </button>
              <button
                type="button"
                className="fetch-models-btn"
                onClick={onFetchModels}
                disabled={fetching}>
                {fetching ? t('获取中...') : t('自动获取模型列表')}
              </button>
            </div>
          </div>
        </div>

        {allowReasoningEffortList.length > 0 && (
          <div className="form-group">
            <label>{t('推理强度 (Reasoning Effort)')}</label>
            <Select
              value={reasoningEffort}
              onChange={(v) => setReasoningEffort(v)}
              options={[
                { value: '', label: t('默认（不设置）') },
                ...allowReasoningEffortList.map((val) => ({
                  value: val,
                  label: val,
                })),
              ]}
              width={200}
            />
            {/* <span className="form-hint">
              仅对支持 reasoning_effort 参数的模型生效（如 OpenAI o 系列）
            </span> */}
          </div>
        )}

        <div className="form-footer">
          <button className="btn-cancel" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="btn-save" onClick={handleSave} disabled={!isValid}>
            {isEdit ? t('保存') : t('添加')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
