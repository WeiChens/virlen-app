/**
 * 搜索供应商工厂 — 根据持久化配置创建 ISearchProvider 实例
 *
 * 类比 infrastructure/provider/index.ts 中的 createProviderInstance()
 * 将序列化的 SearchProviderConfig 转为运行时 ISearchProvider 实例。
 */
import type { ISearchProvider } from '@/domain/search/types'
import type { SearchProviderConfig } from '@/domain/search/config'
import { TavilySearchProvider } from './tavily'
import { SearXNGProvider } from './searxng'
import { BochaSearchProvider } from './bocha'

/**
 * 根据配置创建搜索供应商实例
 *
 * @param config 从 localStorage 读取的持久化配置
 * @returns ISearchProvider 实例
 * @throws 当配置类型不支持时抛出错误
 */
export function createSearchProviderInstance(
  config: SearchProviderConfig,
): ISearchProvider {
  switch (config.type) {
    case 'tavily':
      return new TavilySearchProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || undefined,
      })
    // case 'searxng':
    //   return new SearXNGProvider({
    //     baseUrl: config.baseUrl,
    //   })
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
