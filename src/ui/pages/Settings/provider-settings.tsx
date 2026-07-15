/**
 * provider-settings — 模型服务配置
 * 从 settingsState 读取/写入，通过 providerRegistry 注册运行时 provider
 */
import { useState, useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import ProviderEditModal from './provider-edit-modal'
import type {
  ProviderConfig,
  ProviderConfigTemplate,
  ProviderType,
} from '@/types'
import EditSvg from '@/ui/components/icons/EditSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import { getProviderIcon } from './provider-icons'
import { t, tpl } from '@/ui/i18n'
import './provider-settings.scss'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import { providerPort } from '@/domain'
import { createProviderInstance } from '@/infrastructure/provider'
import { providerService } from '@/services/provider-service'

function ProviderSettings() {
  const [showAdd, setShowAdd] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(
    null,
  )
  const [addTemplate, setAddTemplate] = useState<string | null>(null)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<
    Record<string, boolean | null>
  >({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [fetchingModels, setFetchingModels] = useState<Record<string, boolean>>(
    {},
  )
  const [defaultProviderList, setDefaultProviderList] = useState(
    [] as ProviderConfigTemplate[],
  )
  useEffect(() => {
    setDefaultProviderList(providerService.getDefaultProviderList())
  }, [])

  const providers = settingsState.value.providers

  // 启动时注册所有已启用 provider
  useEffect(() => {
    for (const p of providers) {
      if (p.enabled) {
        // const provider = createProviderInstance(p)
        // if (provider) {
        //   providerPort.register(p.id, provider)
        // }
        providerService.register(p)
      }
    }
  }, [])

  async function handleTest(providerId: string) {
    const provider = settingsState.value.providers.find(
      (p) => p.id === providerId,
    )
    if (!provider) return
    setTesting((prev) => ({ ...prev, [providerId]: true }))
    try {
      const registeredProvider = await providerPort.get(providerId)
      const flag = await registeredProvider.validateApiKey(provider)
      setConnectionStatus((prev) => ({ ...prev, [providerId]: flag }))
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
      setConnectionStatus((prev) => ({ ...prev, [providerId]: false }))
    } finally {
      setTesting((prev) => ({ ...prev, [providerId]: false }))
    }
  }

  async function handleFetchModels(providerId: string) {
    const provider = settingsState.value.providers.find(
      (p) => p.id === providerId,
    )
    if (!provider) return
    setFetchingModels((prev) => ({ ...prev, [providerId]: true }))
    try {
      const registeredProvider = await providerPort.get(providerId)
      const models = await registeredProvider.listModels()
      provider.models = models
      settingsState.setValue('providers', [...settingsState.value.providers])
    } catch (e: any) {
      // showToast('获取模型失败: ' + (e.message ? e.message : e.toString()))
      throw e
    } finally {
      setFetchingModels((prev) => ({ ...prev, [providerId]: false }))
    }
  }

  function handleToggleEnabled(provider: ProviderConfig) {
    const idx = settingsState.value.providers.findIndex(
      (p) => p.id === provider.id,
    )
    if (idx === -1) return
    const updated = [...settingsState.value.providers]
    updated[idx] = { ...updated[idx], enabled: !updated[idx].enabled }
    settingsState.setValue('providers', updated)

    const updatingProvider = updated[idx]
    if (updatingProvider.enabled) {
      const p = createProviderInstance(updatingProvider)
      if (p) {
        providerService.register(updatingProvider)
      }
    } else {
      providerPort.unregister(provider.id)
    }
  }

  async function handleDelete(providerId: string) {
    // 弹窗确认删除？（删除后无法恢复，慎重）
    const flag = await MessageBox.warn(
      t('删除服务商'),
      t('确定要删除这个服务商吗？此操作无法撤销'),
    )
    if (!flag) return
    const updated = settingsState.value.providers.filter(
      (p) => p.id !== providerId,
    )
    settingsState.setValue('providers', updated)
    providerPort.unregister(providerId)
    if (expandedProvider === providerId) setExpandedProvider(null)
  }

  function handleAddFromTemplate(templateName: string) {
    setAddTemplate(templateName)
    setShowAdd(true)
  }

  function handleSaveNew(config: {
    name: string
    type: string
    apiKey: string
    baseUrl: string
    models: any[]
    templateName: ProviderConfig['templateName']
    reasoningEffort?: string
  }) {
    const id = `provider-${Date.now()}`
    const now = Date.now()
    const newProvider: ProviderConfig = {
      id,
      name: config.name,
      templateName: config.templateName,
      type: config.type as ProviderConfig['type'],
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      models: config.models,
      reasoningEffort: config.reasoningEffort,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
    const updated = [...settingsState.value.providers, newProvider]
    settingsState.setValue('providers', updated)
    const p = createProviderInstance(newProvider)
    if (p) {
      providerPort.register(newProvider.id, p)
    }
    setShowAdd(false)
    setAddTemplate(null)
    // 自动获取模型
    handleFetchModels(newProvider.id)
  }

  function handleSaveEdit(config: {
    name: string
    apiKey: string
    baseUrl: string
    models: any[]
    type: ProviderType
    reasoningEffort?: string
  }) {
    if (!editingProvider) return
    const idx = settingsState.value.providers.findIndex(
      (p) => p.id === editingProvider.id,
    )
    if (idx === -1) return
    const updated = [...settingsState.value.providers]
    updated[idx] = {
      ...updated[idx],
      name: config.name,
      type: config.type,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      models: config.models,
      reasoningEffort: config.reasoningEffort,
      updatedAt: Date.now(),
    }
    settingsState.setValue('providers', updated)
    const p = createProviderInstance(updated[idx])
    if (p) {
      providerPort.register(updated[idx].id, p)
    }
    setEditingProvider(null)
    // 自动获取模型
    if (editingProvider.models.length === 0)
      handleFetchModels(editingProvider.id)
  }

  return (
    <div className="provider-settings">
      <div className="add-provider-section">
        <h3>{t('添加模型服务')}</h3>
        <p className="add-hint">
          {t('选择一个服务商，配置 API Key 即可开始使用')}
        </p>
        <div className="template-grid">
          {defaultProviderList.map((tmpl) => (
            <button
              key={tmpl.templateName}
              className="template-card"
              onClick={() => handleAddFromTemplate(tmpl.templateName)}>
              <span className="template-icon">
                {getProviderIcon(tmpl.templateName)}
              </span>
              <span className="template-label">{t(tmpl.label)}</span>
            </button>
          ))}
        </div>
      </div>
      {providers.length > 0 && (
        <>
          <div className="section-header">
            <h3>{t('模型服务')}</h3>
          </div>
          <div className="provider-list">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className={`provider-card ${expandedProvider === provider.id ? 'expanded' : ''}`}>
                <div
                  className="provider-card-header"
                  onClick={() =>
                    setExpandedProvider(
                      expandedProvider === provider.id ? null : provider.id,
                    )
                  }>
                  <div className="provider-info">
                    <span className="provider-icon">
                      {getProviderIcon(provider.templateName)}
                    </span>
                    <div className="provider-meta">
                      <span className="provider-name">{provider.name}</span>
                      <span className="provider-url">{provider.baseUrl}</span>
                    </div>
                  </div>
                  <div className="provider-status-area">
                    {connectionStatus[provider.id] !== undefined && (
                      <span
                        className={`status-badge ${connectionStatus[provider.id] ? 'ok' : 'fail'}`}>
                        {connectionStatus[provider.id]
                          ? t('✓ 已连接')
                          : t('✗ 连接失败')}
                      </span>
                    )}
                    <label
                      className="toggle"
                      onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={provider.enabled}
                        onChange={() => handleToggleEnabled(provider)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                </div>

                {expandedProvider === provider.id && (
                  <div className="provider-card-body">
                    <div className="provider-detail-row">
                      <span className="detail-label">{t('类型')}</span>
                      <span className="detail-value">{provider.type}</span>
                    </div>
                    <div className="provider-detail-row">
                      <span className="detail-label">{t('API Key')}</span>
                      <span className="detail-value mask">
                        {provider.apiKey
                          ? '••••••••' + provider.apiKey.slice(-4)
                          : t('（未设置）')}
                      </span>
                    </div>
                    <div className="provider-detail-row">
                      <span className="detail-label">{t('模型列表')}</span>
                      <div className="detail-value scroll">
                        {provider.models.length > 0
                          ? provider.models.join(', ')
                          : t('（未获取）')}
                      </div>
                    </div>
                    {provider.reasoningEffort && (
                      <div className="provider-detail-row">
                        <span className="detail-label">
                          {t('推理强度 (Reasoning Effort)')}
                        </span>
                        <span className="detail-value">
                          {provider.reasoningEffort}
                        </span>
                      </div>
                    )}
                    <div className="provider-card-actions">
                      <button
                        className="btn-secondary"
                        onClick={() => handleTest(provider.id)}
                        disabled={testing[provider.id]}>
                        {testing[provider.id]
                          ? t('测试中...')
                          : t('🔗 测试连接')}
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={async () => {
                          try {
                            await handleFetchModels(provider.id)
                          } catch (e) {
                            showToast(
                              tpl('获取模型失败: $__error__', {
                                error:
                                  e instanceof Error ? e.message : String(e),
                              }),
                            )
                          }
                        }}
                        disabled={fetchingModels[provider.id]}>
                        {fetchingModels[provider.id]
                          ? t('获取中...')
                          : t('📋 获取模型')}
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => setEditingProvider(provider)}>
                        <EditSvg /> {t('编辑')}
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => handleDelete(provider.id)}>
                        <DeleteSvg /> {t('删除')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <ProviderEditModal
        visible={showAdd}
        onClose={() => {
          setShowAdd(false)
          setAddTemplate(null)
        }}
        onSave={handleSaveNew}
        template={defaultProviderList.find(
          (t) => t.templateName === addTemplate,
        )}
      />
      <ProviderEditModal
        visible={!!editingProvider}
        onClose={() => setEditingProvider(null)}
        onSave={handleSaveEdit}
        initialConfig={
          editingProvider
            ? {
                name: editingProvider.name,
                type: editingProvider.type,
                apiKey: editingProvider.apiKey,
                baseUrl: editingProvider.baseUrl,
                models: editingProvider.models,
                templateName: editingProvider.templateName,
                reasoningEffort: editingProvider.reasoningEffort,
              }
            : undefined
        }
      />
    </div>
  )
}

export default observer(ProviderSettings)
