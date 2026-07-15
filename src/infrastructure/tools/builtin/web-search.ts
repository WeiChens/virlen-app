/**
 * web_search 工具 — 网络搜索功能
 *
 * 通过 SearchProviderPort 注册中心调用已配置的搜索供应商执行搜索。
 * 支持切换不同的搜索供应商（Tavily、Bing、SearXNG 等），
 * 用户可以在设置中配置默认搜索供应商。
 *
 * 使用方式（AI 视角）：
 *   当用户要求搜索互联网信息时，调用此工具。
 *
 * 后续扩展：
 *   - 可以增加搜索供应商选择参数，支持在单次调用中指定使用哪个供应商
 *   - 可以缓存搜索结果，减少重复请求
 */
import { t } from '@/ui/i18n'
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { searchProviderRegistry } from '@/domain/search'
import type { SearchResultItem } from '@/domain/search/types'

toolRegistry.register(
  {
    name: 'web_search',
    label: t('网络搜索'),
    description:
      'Search the internet for up-to-date information. ' +
      'Use this tool when you need current data, recent news, or information not available in your training data. ' +
      'The search is powered by a configurable search provider (e.g., Tavily, Bing, SearXNG). ' +
      'Returns search results with titles, URLs, and snippets. ' +
      'When include_content=true, also returns the full page content when the provider supports it.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query. Be specific and use keywords for better results.',
        },
        max_results: {
          type: 'number',
          description:
            'Maximum number of search results to return. Default: 10, Max: 50.',
          default: 10,
        },
        time_range: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description:
            'Time range filter for the search results. ' +
            '"day" = past 24h, "week" = past week, "month" = past month, "year" = past year. ' +
            'Use this when the user asks for recent or latest information.',
        },
      },
      required: ['query'],
    },
  },
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
)

/**
 * 格式化搜索结果供 LLM 阅读
 */
function formatSearchResults(
  items: SearchResultItem[],
  query: string,
  providerName: string,
  elapsedMs?: number,
): string {
  const lines: string[] = []
  lines.push(
    `🔍 Search results for "${query}" (via ${providerName})${elapsedMs ? ` in ${elapsedMs}ms` : ''}:`,
  )
  lines.push('')

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    lines.push(`[${i + 1}] ${item.title}`)
    lines.push(`    URL: ${item.url}`)
    lines.push(`    ${item.snippet}`)

    if (item.publishedDate) {
      lines.push(`    Published: ${item.publishedDate}`)
    }
    if (item.source) {
      lines.push(`    Source: ${item.source}`)
    }
    if (item.score !== undefined) {
      lines.push(`    Relevance: ${(item.score * 100).toFixed(0)}%`)
    }

    // 如果有全文内容，附带（但限制长度避免 token 溢出）
    if (item.content && item.content.length > 0) {
      const maxContentLen = 2000
      const content =
        item.content.length > maxContentLen
          ? item.content.slice(0, maxContentLen) + '... [truncated]'
          : item.content
      lines.push(`    Content: ${content}`)
    }

    lines.push('')
  }
  lines.push(`--- End of search results (${items.length} items) ---`)
  return lines.join('\n')
}
