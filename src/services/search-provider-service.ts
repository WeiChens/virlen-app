/**
 * search-provider-service — 搜索供应商持久化 & 初始化（类比 provider-service.ts）。
 *
 * localStorage ←→ settingsState.searchProviders ←→ searchProviderRegistry（内存）。
 * 启动时 main.ts 调 initSearchProviders()：读配置 → 建实例 → 注册 → 设默认。
 */
import { searchProviderRegistry } from '@/domain/search'
import { createSearchProviderInstance } from '@/infrastructure/search-providers'
import { settingsState } from '@/ui/store'
import type { SearchProviderConfig } from '@/domain/search/config'
import type { ISearchProvider } from '@/domain/search/types'

class SearchProviderServiceImpl implements SearchProviderService {
  /** 启动时从持久化配置重建实例；对应 providerService.initProviders()。 */
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
    searchProviderRegistry.list()
  }

  async addConfig(config: SearchProviderConfig): Promise<void> {
    const list = [...settingsState.value.searchProviders, config]
    settingsState.setValue('searchProviders', list)

    if (config.enabled) {
      const provider = createSearchProviderInstance(config)
      await searchProviderRegistry.register(config.id, provider)
    }

    // 如果是第一个供应商，自动设为默认
    if (!settingsState.value.defaultSearchProviderId) {
      settingsState.setValue('defaultSearchProviderId', config.id)
      await searchProviderRegistry.setDefault(config.id)
    }
  }

  async updateConfig(config: SearchProviderConfig): Promise<void> {
    await searchProviderRegistry.unregister(config.id)

    const list = settingsState.value.searchProviders.map((p) =>
      p.id === config.id ? config : p,
    )
    settingsState.setValue('searchProviders', list)

    if (config.enabled) {
      const provider = createSearchProviderInstance(config)
      await searchProviderRegistry.register(config.id, provider)
    }
  }

  async removeConfig(id: string): Promise<void> {
    await searchProviderRegistry.unregister(id)

    const list = settingsState.value.searchProviders.filter(
      (p) => p.id !== id,
    )
    settingsState.setValue('searchProviders', list)

    // 删的是默认供应商则重置默认（取下一个启用的）
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

  /** 仅运行时注册（不持久化），用于动态注册场景。 */
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
