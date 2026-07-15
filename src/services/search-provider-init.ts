/**
 * 搜索供应商初始化示例
 *
 * 演示如何在应用启动时注册和配置搜索供应商。
 * 实际项目中，可以从持久化存储（如 IndexedDB）中读取配置后注册。
 *
 * 使用方式：
 *   在 main.ts 的 init() 函数中调用 searchProviderInit()，
 *   与 providerService.initProviders() 类似。
 *
 * 示例：
 *   // main.ts
 *   import { searchProviderInit } from './services/search-provider-init'
 *
 *   async function init() {
 *     // ... 其他初始化
 *     providerService.initProviders()
 *     await searchProviderInit()  // ← 初始化搜索供应商
 *   }
 */
import { searchProviderRegistry } from '@/domain'
import {
  TavilySearchProvider,
  SearXNGProvider,
} from '@/infrastructure/search-providers'

/**
 * 初始化并注册所有搜索供应商
 *
 * 这里演示了三种注册方式：
 *   1. Tavily — 需 API Key，AI 专用搜索引擎
 *   2. Bing — 需 Azure API Key
 *   3. SearXNG — 自建开源实例，无需 API Key
 *
 * 实际应用中应从配置存储中读取，这里仅为演示。
 */
export async function searchProviderInit(): Promise<void> {
  const providers = await searchProviderRegistry.list()
  console.log(
    `[SearchProvider] Initialized ${providers.length} provider(s):`,
    providers.map((p) => p.name).join(', '),
  )
}
