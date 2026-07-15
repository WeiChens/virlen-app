/**
 * SearXNG Search Provider — 接入自建 SearXNG 实例
 *
 * SearXNG 是一个开源的元搜索引擎，可以自部署，无需 API Key。
 * 它聚合了 Google、Bing、DuckDuckGo 等多个搜索引擎的结果。
 *
 * 部署文档: https://docs.searxng.org
 * 本接入使用 SearXNG 的 JSON API。
 */
import type {
  ISearchProvider,
  SearchParams,
  SearchResult,
  SearchResultItem,
} from '@/domain/search/types'

/** SearXNG JSON API 响应结构 */
interface SearXNGResponse {
  query: string
  results: SearXNGResultItem[]
  infoboxes: any[]
  suggestions: string[]
  answers: string[]
  number_of_results?: number
}

interface SearXNGResultItem {
  title: string
  url: string
  content: string
  engine: string
  publishedDate?: string
  thumbnail?: string
  img_src?: string
  score?: number
  category?: string
}

/** SearXNG 搜索引擎类别 */
type SearXNGCategory =
  | 'general'
  | 'news'
  | 'images'
  | 'videos'
  | 'files'
  | 'it'
  | 'science'

export class SearXNGProvider implements ISearchProvider {
  readonly name = 'SearXNG'
  readonly id = 'searxng'

  private baseUrl: string

  /**
   * @param baseUrl SearXNG 实例的根 URL，如 "https://search.example.com"
   */
  constructor(config: SearXNGConfig) {
    // 移除末尾斜杠
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
  }

  async search(
    params: SearchParams,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const startTime = Date.now()

    // 映射时间范围到 SearXNG 的时间过滤参数
    const timeRangeMap: Record<string, string> = {
      day: 'day',
      week: 'week',
      month: 'month',
      year: 'year',
    }

    const queryParams = new URLSearchParams({
      q: params.query,
      format: 'json',
      categories: this.mapCategory(params),
      language: params.language || 'zh-CN',
      pageno: '1',
    })

    // 时间范围
    if (params.timeRange && timeRangeMap[params.timeRange]) {
      queryParams.set('time_range', timeRangeMap[params.timeRange])
    }

    const response = await fetch(
      `${this.baseUrl}/search?${queryParams.toString()}`,
      {
        signal,
        headers: {
          Accept: 'application/json',
          // SearXNG 需要 User-Agent
          'User-Agent': 'Virlen/1.0',
        },
      },
    )

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      throw new Error(`SearXNG error (${response.status}): ${errorBody}`)
    }

    const data: SearXNGResponse = await response.json()
    const elapsedMs = Date.now() - startTime

    const items: SearchResultItem[] = data.results
      .slice(0, params.maxResults ?? 10)
      .map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content?.slice(0, 500) ?? '',
        content: item.content,
        publishedDate: item.publishedDate,
        source: item.engine,
        imageUrl: item.img_src,
        score: item.score,
      }))

    return {
      items,
      totalResults: data.number_of_results ?? items.length,
      rawResponse: data,
    }
  }

  async validateConfig(): Promise<boolean> {
    if (!this.baseUrl) return false
    try {
      const res = await fetch(`${this.baseUrl}/search?q=test&format=json`, {
        headers: { 'User-Agent': 'Virlen/1.0' },
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** 根据参数映射 SearXNG 分类 */
  private mapCategory(params: SearchParams): SearXNGCategory {
    if (params.timeRange === 'day') return 'news'
    return 'general'
  }
}

export interface SearXNGConfig {
  /** SearXNG 实例的 URL，如 "https://search.example.com" */
  baseUrl: string
}
