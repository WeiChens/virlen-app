/**
 * 搜索供应商初始化示例：在 `main.ts` 的 init() 中调用，与 providerService.initProviders() 并列。
 * 实际应从持久化存储读取配置后注册，这里仅为演示。
 */
import { searchProviderRegistry } from '@/domain'

/** 注册所有搜索供应商（Tavily / Bing 需 API Key，SearXNG 无需）。 */
export async function searchProviderInit(): Promise<void> {
  const providers = await searchProviderRegistry.list()
}
