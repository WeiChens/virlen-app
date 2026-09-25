/**
 * web_search — 网络搜索
 *
 * 通过 SearchProviderPort 注册中心调用已配置的搜索供应商执行搜索。
 * 支持切换不同的搜索供应商（Tavily、Bing、SearXNG 等），
 * 用户可以在设置中配置默认搜索供应商。
 *
 * 使用方式（AI 视角）：当用户要求搜索互联网信息时，调用此工具。
 *
 * 后续扩展：
 *   - 可以增加搜索供应商选择参数，支持在单次调用中指定使用哪个供应商
 *   - 可以缓存搜索结果，减少重复请求
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { searchProviderRegistry } from '@/domain/search'
import { formatSearchResults } from './common'

toolRegistry.register(
    'web_search',
    (async (args: Record<string, any>, ctx: any): Promise<ToolResult> => {
    const query = args.query
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return {
        content:
          'Missing required parameter: "query". Please provide a search query.',
      }
    }

    // 1. 获取搜索供应商
    const provider = await searchProviderRegistry.getDefault()
    if (!provider) {
      return {
        content:
          'No search provider is configured. Please configure a search provider in settings (e.g., Tavily, Bing, or a self-hosted SearXNG instance).',
      }
    }

    // 2. 构建搜索参数
    const maxResults = Math.min(args.max_results ?? 10, 50)

    const searchResult = await provider.search(
      {
        query: query.trim(),
        maxResults,
        timeRange: args.time_range,
      },
      ctx?.abortSignal,
    )

    // 3. 格式化结果
    if (!searchResult.items || searchResult.items.length === 0) {
      return {
        content: `No search results found for "${query}".`,
        uiData: { length: 0, items: [] },
      }
    }

    const now = new Date().toISOString()
    const formattedResults = formatSearchResults(
      searchResult.items,
      query,
      provider.name,
      searchResult.elapsedMs,
    )

    return {
      content: formattedResults,
      uiData: {
        length: searchResult.items.length,
        items: searchResult.items.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          icon: item.icon,
        })),
        provider: provider.name,
        query,
        timestamp: now,
      },
    }
  }) as ToolExecutor,
    t('网络搜索'),
)
