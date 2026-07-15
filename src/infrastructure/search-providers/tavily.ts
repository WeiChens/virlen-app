/**
 * Tavily Search Provider — 接入 Tavily AI Search API
 *
 * Tavily 是专为 AI Agent 设计的搜索引擎 API，支持：
 *   - 返回带全文内容的搜索结果
 *   - 自动摘要
 *   - 新闻/通用搜索
 *
 * 官网: https://tavily.com
 * API 文档: https://docs.tavily.com
 */
import type {
  ISearchProvider,
  SearchParams,
  SearchResult,
  SearchResultItem,
} from '@/domain/search/types'

/** Tavily API 响应结构 */
interface TavilyResponse {
  query: string
  answer?: string
  results: TavilyResultItem[]
  response_time: number
  follow_up_questions?: string[]
}

interface TavilyResultItem {
  title: string
  url: string
  content: string
  score: number
  published_date?: string
  source?: string
}

/** Tavily 搜索类型 */
type TavilySearchDepth = 'basic' | 'advanced'
type TavilyTopic = 'general' | 'news'

export class TavilySearchProvider implements ISearchProvider {
  readonly name = 'Tavily'
  readonly id = 'tavily'

  private apiKey: string
  private baseUrl: string

  constructor(config: TavilyConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl || 'https://api.tavily.com'
  }

  async search(
    params: SearchParams,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const depth: TavilySearchDepth = 'basic'
    const topic: TavilyTopic = params.timeRange === 'day' ? 'news' : 'general'

    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: params.query,
        api_key: this.apiKey,
        max_results: params.maxResults ?? 10,
        search_depth: depth,
        topic,
        days: params.timeRange === 'day' ? 1 : undefined,
        include_answer: false,
      }),
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      throw new Error(`Tavily API error (${response.status}): ${errorBody}`)
    }

    const data: TavilyResponse = await response.json()

    return {
      items: data.results.map(
        (item): SearchResultItem => ({
          title: item.title,
          url: item.url,
          snippet: item.content.slice(0, 300),
          content: item.content,
          score: item.score,
        }),
      ),
      totalResults: data.results.length,
      rawResponse: data,
    }
  }

  async validateConfig(): Promise<boolean> {
    if (!this.apiKey || this.apiKey.trim() === '') return false
    try {
      const res = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query: 'test',
          api_key: this.apiKey,
          max_results: 1,
        }),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

export interface TavilyConfig {
  apiKey: string
  baseUrl?: string
}
