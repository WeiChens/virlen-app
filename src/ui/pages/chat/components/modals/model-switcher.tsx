/**
 * model-switcher — 模型切换下拉
 * 从 settingsState 读取 providers，从 store 获取当前会话的模型
 */
import { useState, useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState, sessionStore, chatState } from '@/ui/store'
import type { ModelInfo } from '@/types'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import './model-switcher.scss'

function ModelSwitcher() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const enabledProviders = settingsState.value.providers.filter(
    (p) => p.enabled,
  )

  const sessionId = chatState.value.currentSessionId
  const defaultModel = chatState.value.selectModel

  // 有会话时从 session 读取，无会话时从 defaultModel 读取
  const session = sessionId ? sessionStore.getSession(sessionId) : null
  const currentProviderId = sessionId
    ? session?.providerConfigId || ''
    : defaultModel?.providerConfigId
  const currentModelId = sessionId
    ? session?.modelId || ''
    : defaultModel?.modelId

  const currentProvider = enabledProviders.find(
    (p) => p.id === currentProviderId,
  )
  const currentModel = currentProvider?.models.find((m) => m === currentModelId)

  // 自动选中第一个可用模型（首次加载无默认值时）
  useEffect(() => {
    if (!defaultModel?.providerConfigId) {
      const firstProvider = enabledProviders.find((p) => p.models.length > 0)
      if (!firstProvider) return
      const firstModel = firstProvider.models[0]
      chatState.setValue('selectModel', {
        providerConfigId: firstProvider.id,
        modelId: firstModel,
      })
    }
  }, [])

  // 外部点击关闭
  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [open])

  function handleSelect(providerId: string, modelId: string) {
    if (sessionId) {
      sessionStore.updateSession(sessionId, {
        providerConfigId: providerId,
        modelId,
      })
    } else {
      chatState.setValue('selectModel', {
        providerConfigId: providerId,
        modelId,
      })
    }
    setOpen(false)
  }

  function getDisplayLabel(): { provider: string; model: string } {
    if (currentProvider && currentModel) {
      return {
        provider: currentProvider.name,
        model: currentModel,
      }
    }
    if (enabledProviders.length === 0) {
      return { provider: '未配置', model: '请先添加模型服务' }
    }
    return { provider: '选择模型', model: '点击选择' }
  }

  const label = getDisplayLabel()

  return (
    <div className="model-switcher" ref={containerRef}>
      <button
        className={`model-switcher-trigger ${open ? 'open' : ''} ${!currentProviderId ? 'empty' : ''}`}
        onClick={() => setOpen(!open)}
        title="切换模型">
        {/* <div className="trigger-icon-wrap">
          {currentProvider && getProviderIcon(currentProvider.type, 16)}
        </div> */}
        <div className="trigger-labels">
          {/* <span className="trigger-provider">{label.provider}</span> */}
          <span className="trigger-model">{label.model}</span>
        </div>
        <DropDownSvg className="trigger-arrow" />
      </button>

      {open && (
        <div className="model-dropdown">
          {enabledProviders.length === 0 ? (
            <div className="dropdown-empty">
              <p>暂无可用模型服务</p>
              <p className="hint">请先在设置中添加并启用模型服务</p>
            </div>
          ) : (
            <div className="dropdown-list">
              {enabledProviders.map((provider) => {
                const isCurrentProvider = provider.id === currentProviderId

                return (
                  <div key={provider.id} className="dropdown-provider-group">
                    <div className="dropdown-provider-header">
                      <span className="provider-group-name">
                        {provider.name}
                      </span>
                    </div>

                    {provider.models.length === 0 ? (
                      <div className="dropdown-no-models">
                        暂无模型 — 请先"获取模型"
                      </div>
                    ) : (
                      provider.models.map((model: ModelInfo) => {
                        const isActive =
                          isCurrentProvider && model === currentModelId
                        return (
                          <button
                            key={`${provider.id}-${model}`}
                            className={`dropdown-model-item ${isActive ? 'active' : ''}`}
                            onClick={() => handleSelect(provider.id, model)}>
                            <span className="model-name">{model}</span>
                            <span className="model-meta">
                              {/* {model.contextWindow >= 1000
                                ? `${Math.round(model.contextWindow / 1000)}K ctx`
                                : `${model.contextWindow} ctx`} */}
                            </span>
                            {isActive && <span className="check-mark">✓</span>}
                          </button>
                        )
                      })
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default observer(ModelSwitcher)
