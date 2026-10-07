/** 搜索供应商工厂 —— 把序列化的 SearchProviderConfig 转为运行时 ISearchProvider 实例（类比 provider/index.ts）。 */
import type { ISearchProvider } from '@/domain/search/types'
import type { SearchProviderConfig } from '@/domain/search/config'
import { TavilySearchProvider } from './tavily'
import { BochaSearchProvider } from './bocha'

/** 根据配置创建搜索供应商实例；配置类型不支持时抛错。 */
export function createSearchProviderInstance(
  config: SearchProviderConfig,
): ISearchProvider {
  switch (config.type) {
    case 'tavily':
      return new TavilySearchProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
      })
    case 'bocha':
      return new BochaSearchProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
      })
    default:
      throw new Error(
        `Unknown search provider type: "${(config as any).type}". ` +
          `Supported types: tavily, bocha.`,
      )
  }
}
