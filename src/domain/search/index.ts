/**
 * SearchProviderRegistry — 搜索供应商注册中心
 *
 * 实现 SearchProviderPort 接口，管理所有已注册的搜索供应商实例。
 * 对应 ProviderRegistry（LLM 供应商注册中心）的模式。
 */
import type { SearchProviderPort } from '../ports/SearchProviderPort'
import type { ISearchProvider, SearchProviderSummary } from './types'
import type { SearchProviderConfig, SearchProviderType, SearchProviderTemplate } from './config'

export type { SearchProviderConfig, SearchProviderType, SearchProviderTemplate }
export { SEARCH_PROVIDER_TEMPLATES } from './config'

export class SearchProviderRegistry implements SearchProviderPort {
  private providers: Map<string, ISearchProvider> = new Map()
  private defaultProviderId: string | null = null

  async register(id: string, provider: ISearchProvider) {
    this.providers.set(id, provider)
    if (!this.defaultProviderId) {
      this.defaultProviderId = id
    }
  }

  async unregister(id: string) {
    if (this.defaultProviderId === id) {
      this.defaultProviderId =
        this.providers.size > 1
          ? this.providers.keys().next().value ?? null
          : null
    }
    return this.providers.delete(id)
  }

  async get(id: string) {
    return this.providers.get(id)
  }

  async getDefault() {
    if (!this.defaultProviderId) return undefined
    return this.providers.get(this.defaultProviderId)
  }

  async setDefault(id: string) {
    if (!this.providers.has(id)) {
      throw new Error(`Search provider "${id}" is not registered.`)
    }
    this.defaultProviderId = id
  }

  async list() {
    return Array.from(this.providers.entries()).map(([id, p]) => ({
      id,
      name: p.name,
    })) as SearchProviderSummary[]
  }
}

/** 全局搜索供应商注册中心单例 */
export const searchProviderRegistry: SearchProviderPort =
  new SearchProviderRegistry()
