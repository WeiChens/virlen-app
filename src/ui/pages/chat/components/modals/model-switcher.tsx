/**
 * model-switcher — 模型切换下拉
 * 从 settingsState 读取 providers，从 store 获取当前会话的模型
 */
import { useState, useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { settingsState, sessionStore, chatState } from '@/ui/store'
import type { ModelInfo } from '@/types'
import DropDownSvg from '@/ui/components/icons/DropDownSvg'
import { t } from '@/ui/i18n'
import './model-switcher.scss'

function ModelSwitcher() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  // 当前选中项的 DOM 节点：每次打开列表都要把它滚进可视区（见下方 effect）
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

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

  // 打开时把选中项滚到列表中间
  //
  // 为什么不能只靠 CSS：
  // - `.dropdown-list` 是 `overflow-y: auto` 的独立滚动容器，`scrollTop` 在列表**重新挂载**时
  //   （`open && …` 每次开都重新创建）恒为 0，于是选中项在 provider 多 / 模型多时永远停在
  //   可视区之外 —— 用户看到的是「一打开就是第一家的第一个模型」，而不是自己当前用的那个。
  // - 也不能用 `scrollIntoView()`：它会把**所有**祖先滚动容器一起滚（聊天输入框、侧栏都会
  //   跟着跳），列表向上弹出时还会连带滚整个页面。所以这里只在 `.dropdown-list` 自己的
  //   `scrollTop` 上算偏移。
  //
  // 偏移怎么算：**不要**用 `offsetTop` 相减 —— 选中项的 `offsetParent` 是 `.model-dropdown`
  // （`.dropdown-list` 没有定位），而 `.dropdown-list` 的 `offsetTop` 是「相对 dropdown 的
  // 内边距」，两者原点不同，减出来的值会多算或少算一段。用 `getBoundingClientRect()` 求差
  // 最省事：`active.top - list.top` 就是「选中项顶部在内容里的位置 − 当前已滚动量」，
  // 加上 `list.scrollTop` 就得到它相对**内容顶部**的偏移。
  //
  // 用 `useEffect`（不是 `useLayoutEffect`）：列表在挂载后才拿到布局；即便晚一帧也不会闪，
  // 因为这个 effect 在首帧绘制之前就跑完了。
  useEffect(() => {
    if (!open) return
    const list = containerRef.current?.querySelector<HTMLElement>('.dropdown-list')
    if (!list) return
    // 选中项可能不在列表里：它的 provider 被停用了（`enabledProviders` 过滤掉了）、或
    // `currentModelId` 指向一个已被删除的模型。此时前面根本没有机会看到列表，
    // 就停在列表顶端（`scrollTop = 0`）—— 与「没选中项」的观感一致。
    const active = activeItemRef.current
    if (!active || !list.contains(active)) {
      list.scrollTop = 0
      return
    }
    // 量不到布局（元素高 0 / 容器高 0，典型如测试环境的假 rect）时不动 —— 拿 0 当真值
    // 会算出一笔凭空位移，把列表滚到莫名其妙的位置。
    if (list.clientHeight === 0) return
    const itemHeight = active.offsetHeight
    if (itemHeight === 0) return
    const listRect = list.getBoundingClientRect()
    const itemRect = active.getBoundingClientRect()
    const itemTop = itemRect.top - listRect.top + list.scrollTop
    // 居中：上半的留白与下半的留白尽量相等，选中项落在能一眼看到的位置。
    // 首尾两项会自然贴边（浏览器会把 scrollTop 夹到 [0, scrollHeight - clientHeight]）。
    const target = itemTop - (list.clientHeight - itemHeight) / 2
    list.scrollTop = target > 0 ? target : 0
  }, [open, currentProviderId, currentModelId])

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
      return { provider: t('未配置'), model: t('请先添加模型服务') }
    }
    return { provider: t('选择模型'), model: t('点击选择') }
  }

  const label = getDisplayLabel()

  return (
    <div className="model-switcher" ref={containerRef}>
      <button
        className={`model-switcher-trigger ${open ? 'open' : ''} ${!currentProviderId ? 'empty' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('切换模型')}>
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
              <p>{t('暂无可用模型服务')}</p>
              <p className="hint">{t('请先在设置中添加并启用模型服务')}</p>
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
                        {t('暂无模型，请先获取模型列表')}
                      </div>
                    ) : (
                      provider.models.map((model: ModelInfo) => {
                        const isActive =
                          isCurrentProvider && model === currentModelId
                        return (
                          <button
                            key={`${provider.id}-${model}`}
                            ref={isActive ? activeItemRef : undefined}
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
