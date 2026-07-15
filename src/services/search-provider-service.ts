/**
 * search-provider-service — 搜索供应商持久化 & 初始化服务
 *
 * 完全类比 provider-service.ts（LLM 供应商）的模式：
 *
 * 持久化流程：
 *   localStorage ←→ settingsState.searchProviders ←→ searchProviderService.initSearchProviders()
 *        ↑                                                    ↓
 *   存 SearchProviderConfig []                        SearchProviderRegistry (内存)
 *   （可序列化 JSON）                                  （ISearchProvider 实例）
 *
 * 生命周期：
 *   1. 应用启动时，main.ts 调用 initSearchProviders()
 *   2. 从 localStorage 读取已持久化的配置列表
 *   3. 遍历配置，用 createSearchProviderInstance() 创建实例
 *   4. 注册到全局 searchProviderRegistry
 *   5. 设置默认搜索供应商
 */
import { searchProviderRegistry } from '@/domain/search'
import { createSearchProviderInstance } from '@/infrastructure/search-providers'
import { settingsState } from '@/ui/store'
import type { SearchProviderConfig } from '@/domain/search/config'
import type { ISearchProvider } from '@/domain/search/types'

class SearchProviderServiceImpl implements SearchProviderService {
  /**
   * 应用启动时调用 — 从持久化配置重建搜索供应商实例
   *
   * 对应 providerService.initProviders()
   */
  initSearchProviders(): void {
    for (const config of settingsState.value.searchProviders) {
      if (!config.enabled) continue
      try {
        const provider = createSearchProviderInstance(config)
        searchProviderRegistry.register(config.id, provider)
      } catch (e) {
        console.error(
          `[SearchProvider] Failed to register "${config.name}" (${config.id}):`,
          e,
        )
      }
    }

    // 恢复默认搜索供应商
    const defaultId = settingsState.value.defaultSearchProviderId
    if (defaultId) {
      searchProviderRegistry.setDefault(defaultId).catch(() => {
        // 默认供应商未注册（可能已被删除），忽略
      })
    }

    // 打印初始化摘要
    searchProviderRegistry.list().then((providers) => {
      if (providers.length > 0) {
        console.log(
          `[SearchProvider] Initialized ${providers.length} provider(s):`,
          providers.map((p) => `${p.name}(${p.id})`).join(', '),
        )
      }
    })
  }

  /**
   * 添加一个新的搜索供应商配置，并注册到运行时
   *
   * @param config 搜索供应商配置
   */
  async addConfig(config: SearchProviderConfig): Promise<void> {
    // 1. 持久化配置
    const list = [...settingsState.value.searchProviders, config]
    settingsState.setValue('searchProviders', list)

    // 2. 创建实例并注册
    if (config.enabled) {
      const provider = createSearchProviderInstance(config)
      await searchProviderRegistry.register(config.id, provider)
    }

    // 3. 如果是第一个供应商，自动设为默认
    if (!settingsState.value.defaultSearchProviderId) {
      settingsState.setValue('defaultSearchProviderId', config.id)
      await searchProviderRegistry.setDefault(config.id)
    }
  }

  /**
   * 更新已有的搜索供应商配置
   */
  async updateConfig(config: SearchProviderConfig): Promise<void> {
    // 1. 先从注册中心移除旧的实例
    await searchProviderRegistry.unregister(config.id)

    // 2. 更新持久化配置
    const list = settingsState.value.searchProviders.map((p) =>
      p.id === config.id ? config : p,
    )
    settingsState.setValue('searchProviders', list)

    // 3. 如果启用，重新创建并注册
    if (config.enabled) {
      const provider = createSearchProviderInstance(config)
      await searchProviderRegistry.register(config.id, provider)
    }
  }

  /**
   * 删除搜索供应商配置
   */
  async removeConfig(id: string): Promise<void> {
    // 1. 从注册中心移除
    await searchProviderRegistry.unregister(id)

    // 2. 从持久化配置中删除
    const list = settingsState.value.searchProviders.filter(
      (p) => p.id !== id,
    )
    settingsState.setValue('searchProviders', list)

    // 3. 如果删的是默认供应商，重置默认
    if (settingsState.value.defaultSearchProviderId === id) {
      const newDefault = list.find((p) => p.enabled)
      settingsState.setValue(
        'defaultSearchProviderId',
        newDefault?.id ?? '',
      )
      if (newDefault) {
        const provider = createSearchProviderInstance(newDefault)
        await searchProviderRegistry.register(newDefault.id, provider)
        await searchProviderRegistry.setDefault(newDefault.id)
      }
    }
  }

  /**
   * 注册新的供应商实例（不持久化，仅运行时）
   * 用于需要动态注册但不需要持久化的场景
   */
  async registerProvider(id: string, provider: ISearchProvider): Promise<void> {
    await searchProviderRegistry.register(id, provider)
  }
}

export interface SearchProviderService {
  /** 应用启动时调用，从持久化配置重建实例 */
  initSearchProviders(): void

  /** 添加新的搜索供应商（持久化 + 注册） */
  addConfig(config: SearchProviderConfig): Promise<void>

  /** 更新已有的配置 */
  updateConfig(config: SearchProviderConfig): Promise<void>

  /** 删除配置 */
  removeConfig(id: string): Promise<void>

  /** 仅运行时注册（不持久化） */
  registerProvider(id: string, provider: ISearchProvider): Promise<void>
}

/** 全局搜索供应商服务单例 */
export const searchProviderService: SearchProviderService =
  new SearchProviderServiceImpl()
