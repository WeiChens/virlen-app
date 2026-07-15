/**
 * search-engine-settings — 搜索引擎供应商配置页面
 *
 * 设计原则：
 *   - 点击模板卡片 → 弹出配置弹窗 → 配置 → 自动验证连接 → 通过后添加
 *   - 不支持手动/自定义搜索引擎
 *   - 已配置列表为单选 items，点击选中设为默认
 *   - 每个 item 右侧有 more 图标，点击展开/收起详情
 */
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState } from '@/ui/store'
import SearchEngineEditModal from './search-engine-edit-modal'
import type {
  SearchProviderConfig,
  SearchProviderType,
} from '@/domain/search/config'
import { SEARCH_PROVIDER_TEMPLATES } from '@/domain/search/config'
import { searchProviderService } from '@/services/search-provider-service'
import { searchProviderRegistry } from '@/domain/search'
import { createSearchProviderInstance } from '@/infrastructure/search-providers'
import EditSvg from '@/ui/components/icons/EditSvg'
import DeleteSvg from '@/ui/components/icons/DeleteSvg'
import MoreSvg from '@/ui/components/icons/MoreSvg'
import { t } from '@/ui/i18n'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import './search-engine-settings.scss'

function SearchEngineSettings() {
  // 弹窗状态：null=关闭, 'add-{type}'=新建某类型, 对象=编辑已有
  const [modalState, setModalState] = useState<
    | { mode: 'add'; type: SearchProviderType }
    | { mode: 'edit'; config: SearchProviderConfig }
    | null
  >(null)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [testingMap, setTestingMap] = useState<Record<string, boolean>>({})
  const [connectStatus, setConnectStatus] = useState<
    Record<string, boolean | null>
  >({})

  const searchProviders = settingsState.value.searchProviders
  const defaultId = settingsState.value.defaultSearchProviderId

  // 已添加过的类型不再显示在快捷卡片中
  const addedTypes = new Set(searchProviders.map((p) => p.type))
  const availableTemplates = SEARCH_PROVIDER_TEMPLATES.filter(
    (t) => !addedTypes.has(t.type),
  )

  /** 获取供应商类型的显示标签 */
  function getTypeLabel(type: SearchProviderType): string {
    return SEARCH_PROVIDER_TEMPLATES.find((t) => t.type === type)?.label ?? type
  }

  // ==================== 测试连接 ====================

  async function handleTest(id: string) {
    setTestingMap((prev) => ({ ...prev, [id]: true }))
    try {
      const provider = await searchProviderRegistry.get(id)
      if (!provider) {
        showToast(t('供应商未注册'))
        return
      }
      const ok = await provider.validateConfig()
      setConnectStatus((prev) => ({ ...prev, [id]: ok }))
      showToast(ok ? t('✅ 连接成功') : t('❌ 连接失败，请检查配置'))
    } catch (e: any) {
      setConnectStatus((prev) => ({ ...prev, [id]: false }))
      showToast(t('连接失败: ') + (e.message ?? String(e)))
    } finally {
      setTestingMap((prev) => ({ ...prev, [id]: false }))
    }
  }

  // ==================== 添加（自动验证后加入）====================

  async function handleSaveNew(config: {
    name: string
    type: SearchProviderType
    apiKey: string
    baseUrl: string
  }) {
    const now = Date.now()
    const newConfig: SearchProviderConfig = {
      id: `search-${config.type}-${now}`,
      name: config.name,
      type: config.type,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }

    // 1. 先临时创建实例，验证连接
    const provider = createSearchProviderInstance(newConfig)
    try {
      const valid = await provider.validateConfig()
      if (!valid) {
        showToast(t('❌ 连接验证失败，请检查 API Key 和地址是否正确'))
        return
      }
    } catch (e: any) {
      showToast(t('验证连接时出错: ') + (e.message ?? String(e)))
      return
    }

    // 2. 验证通过 → 持久化并注册
    await searchProviderService.addConfig(newConfig)

    // 3. 新添加的自动设为默认（单选模式）
    settingsState.setValue('defaultSearchProviderId', newConfig.id)
    await searchProviderRegistry.setDefault(newConfig.id)

    setModalState(null)
    setExpandedId(null)
    showToast(t('✅ 已添加') + `: ${config.name}`)
  }

  // ==================== 编辑（修改后验证）====================

  async function handleSaveEdit(config: {
    name: string
    type: SearchProviderType
    apiKey: string
    baseUrl: string
  }) {
    if (!modalState || modalState.mode !== 'edit') return

    const updated: SearchProviderConfig = {
      ...modalState.config,
      name: config.name,
      type: config.type,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      updatedAt: Date.now(),
    }

    // 1. 先验证新配置
    try {
      const provider = createSearchProviderInstance(updated)
      const valid = await provider.validateConfig()
      if (!valid) {
        showToast(t('❌ 连接验证失败，请检查配置'))
        return
      }
    } catch (e: any) {
      showToast(t('验证连接时出错: ') + (e.message ?? String(e)))
      return
    }

    // 2. 验证通过 → 持久化并更新注册
    await searchProviderService.updateConfig(updated)
    setModalState(null)
    showToast(t('✅ 已保存'))
  }

  // ==================== 点击选择（设为默认）====================

  async function handleSelect(id: string) {
    if (id === defaultId) return // 已经是启用的，无需操作
    settingsState.setValue('defaultSearchProviderId', id)
    await searchProviderRegistry.setDefault(id)
    showToast(
      t('已启用: ') + (searchProviders.find((p) => p.id === id)?.name ?? ''),
    )
  }

  // ==================== 切换更多详情展开/收起 ====================

  function handleToggleMore(id: string, e: React.MouseEvent) {
    e.stopPropagation() // 阻止事件冒泡，避免触发选中
    setExpandedId(expandedId === id ? null : id)
  }

  // ==================== 删除 ====================

  async function handleDelete(id: string) {
    const flag = await MessageBox.warn(
      t('删除搜索引擎'),
      t('确定要删除这个搜索引擎吗？此操作无法撤销'),
    )
    if (!flag) return

    const wasDefault = id === defaultId
    await searchProviderService.removeConfig(id)
    if (expandedId === id) setExpandedId(null)

    // 如果删除的是启用的供应商，且还有其他已配置的，自动将第一个设为启用
    if (wasDefault) {
      const remaining = settingsState.value.searchProviders
      if (remaining.length > 0) {
        const firstEnabled = remaining.find((p) => p.enabled) ?? remaining[0]
        settingsState.setValue('defaultSearchProviderId', firstEnabled.id)
        await searchProviderRegistry.setDefault(firstEnabled.id)
        // 重新注册这个供应商（removeConfig 时被注销了）
        await searchProviderService.addConfig(firstEnabled)
        showToast(t('已切换启用: ') + firstEnabled.name)
      }
    }
  }

  // ==================== 渲染 ====================

  return (
    <div className="search-engine-settings">
      {/* ===== 添加入口 ===== */}
      <div className="add-section">
        <h3>{t('添加搜索引擎')}</h3>
        <p className="add-hint">
          {t('选择一个搜索引擎供应商，配置后即可在对话中使用网络搜索')}
        </p>

        <div className="template-grid">
          {availableTemplates.map((tmpl) => (
            <button
              key={tmpl.type}
              className="template-card"
              onClick={() => setModalState({ mode: 'add', type: tmpl.type })}>
              <div className="template-header">
                <img
                  className="template-icon"
                  src={tmpl.icon}
                  alt={tmpl.label}
                />
                <span className="template-label">{tmpl.label}</span>
              </div>
              <span className="template-desc">{tmpl.description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ===== 已配置列表 ===== */}
      {searchProviders.length > 0 && (
        <>
          <div className="section-header">
            <h3>{t('已配置的搜索引擎')}</h3>
            <span className="section-count">{searchProviders.length}</span>
          </div>

          <div className="provider-list">
            {searchProviders.map((provider) => {
              const isActive = provider.id === defaultId
              const isExpanded = expandedId === provider.id
              return (
                <div
                  key={provider.id}
                  className={`provider-item ${isActive ? 'is-active' : ''} ${isExpanded ? 'is-expanded' : ''}`}>
                  {/* 主行：单选点击区域 */}
                  <div
                    className="provider-item-row"
                    onClick={() => handleSelect(provider.id)}>
                    {/* 单选指示器 */}
                    <div
                      className={`radio-indicator ${isActive ? 'checked' : ''}`}>
                      {isActive && <div className="radio-dot" />}
                    </div>

                    {/* 信息 */}
                    <div className="provider-item-info">
                      <span className="provider-item-name">
                        {provider.name}
                      </span>
                    </div>

                    {/* 状态标签 */}
                    {isActive && (
                      <span className="active-badge">{t('启用')}</span>
                    )}

                    {/* More 图标 */}
                    <button
                      className="more-btn"
                      onClick={(e) => handleToggleMore(provider.id, e)}
                      title={t('更多')}>
                      <MoreSvg />
                    </button>
                  </div>

                  {/* 展开详情（点击 More 后显示） */}
                  {isExpanded && (
                    <div className="provider-item-body">
                      <div className="detail-row">
                        <span className="detail-label">{t('地址')}</span>
                        <span className="detail-value">{provider.baseUrl}</span>
                      </div>
                      {provider.apiKey && (
                        <div className="detail-row">
                          <span className="detail-label">{t('API Key')}</span>
                          <span className="detail-value mask">
                            {'••••••••' + provider.apiKey.slice(-4)}
                          </span>
                        </div>
                      )}
                      <div className="item-actions">
                        <button
                          className="action-btn"
                          onClick={() => handleTest(provider.id)}
                          disabled={testingMap[provider.id]}>
                          {testingMap[provider.id]
                            ? t('测试中...')
                            : t('🔗 测试连接')}
                        </button>

                        <button
                          className="action-btn"
                          onClick={() =>
                            setModalState({
                              mode: 'edit',
                              config: provider,
                            })
                          }>
                          <EditSvg /> {t('编辑')}
                        </button>

                        <button
                          className="action-btn danger"
                          onClick={() => handleDelete(provider.id)}>
                          <DeleteSvg /> {t('删除')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* 空状态 */}
      {searchProviders.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <p className="empty-text">{t('尚未配置搜索引擎')}</p>
          <p className="empty-hint">
            {t('添加一个搜索引擎后，AI 即可在对话中实时搜索互联网信息')}
          </p>
        </div>
      )}

      {/* ===== 新建弹窗 ===== */}
      {modalState?.mode === 'add' && (
        <SearchEngineEditModal
          visible
          onClose={() => setModalState(null)}
          onSave={handleSaveNew}
          templateType={modalState.type}
        />
      )}

      {/* ===== 编辑弹窗 ===== */}
      {modalState?.mode === 'edit' && (
        <SearchEngineEditModal
          visible
          onClose={() => setModalState(null)}
          onSave={handleSaveEdit}
          initialConfig={modalState.config}
        />
      )}
    </div>
  )
}

export default observer(SearchEngineSettings)
