/**
 * 博查 AI Search Provider — 接入博查 AI 开放平台搜索 API
 *
 * API 文档：https://open.bocha.cn
 * EndPoint: POST https://api.bocha.cn/v1/web-search
 *
 * 鉴权方式：Authorization: Bearer {API_KEY}
 * API Key 从 https://open.bocha.cn > APIKEY 管理中获取
 *
 * 请求参数：
 *   query    - 搜索词（必填）
 *   summary  - 是否显示文本摘要，默认 false
 *   count    - 返回条数，1-50，默认 10
 *   freshness - 时间范围：noLimit/oneDay/oneWeek/oneMonth/oneYear
 *   include  - 指定搜索的网站范围，多个域名用 | 分隔
 *   exclude  - 排除搜索的网站范围，多个域名用 | 分隔
 *
 * 响应（与 Bing 格式相似）：
 *   data.webPages.value[] - 搜索结果列表
 *   每项包含：name, url, snippet, siteName, dateLastCrawled
 *
 * 验证方式：GET https://api.bocha.cn/v1/fund/remaining 查询账户余额
 */
import type {
  ISearchProvider,
  SearchParams,
  SearchResult,
  SearchResultItem,
} from '@/domain/search/types'

/** 博查 API 响应结构 */
interface BochaResponse {
  code: number
  msg: string | null
  log_id: string
  data: {
    _type: string
    queryContext: {
      originalQuery: string
    }
    webPages: {
      totalEstimatedMatches: number
      value: BochaWebPage[]
    }
  }
}

interface BochaWebPage {
  name: string
  url: string
  displayUrl?: string
  snippet: string
  siteName?: string
  siteIcon?: string
  dateLastCrawled?: string
  datePublished?: string
  language?: string
  summary: string
}

/** 博查 freshness 参数映射 */
const FRESHNESS_MAP: Record<string, string> = {
  day: 'oneDay',
  week: 'oneWeek',
  month: 'oneMonth',
  year: 'oneYear',
}

export class BochaSearchProvider implements ISearchProvider {
  readonly name = '博查'
  readonly id = 'bocha'

  private apiKey: string
  private baseUrl: string

  constructor(config: BochaConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl || 'https://api.bocha.cn/v1'
  }

  async search(
    params: SearchParams,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const startTime = Date.now()

    // 构建请求体
    const body: Record<string, any> = {
      query: params.query,
      count: params.maxResults ?? 10,
      summary: true,
    }

    // 时间范围映射
    if (params.timeRange && FRESHNESS_MAP[params.timeRange]) {
      body.freshness = FRESHNESS_MAP[params.timeRange]
    } else {
      body.freshness = 'noLimit'
    }

    // 站点范围
    if (params.extraParams?.include) {
      body.include = params.extraParams.include
    }
    if (params.extraParams?.exclude) {
      body.exclude = params.extraParams.exclude
    }

    const response = await fetch(`${this.baseUrl}/web-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      throw new Error(`博查 API error (${response.status}): ${errorBody}`)
    }

    const data: BochaResponse = await response.json()

    if (data.code !== 200) {
      throw new Error(`博查 API error: ${data.msg || `code=${data.code}`}`)
    }

    const elapsedMs = Date.now() - startTime
    const webPages = data.data?.webPages

    const items: SearchResultItem[] = (webPages?.value ?? []).map(
      (page): SearchResultItem => ({
        title: page.name,
        url: page.url,
        snippet: page.summary,
        publishedDate: page.datePublished,
        source: page.siteName,
        icon: page.siteIcon,
      }),
    )

    return {
      items,
      totalResults: webPages?.totalEstimatedMatches ?? items.length,
      elapsedMs,
      hasMore: items.length >= (params.maxResults ?? 10),
      rawResponse: data,
    }
  }

  /**
   * 使用余额查询 API 验证 API Key 是否有效
   *
   * GET https://api.bocha.cn/v1/fund/remaining
   * 返回 { success: true, code: "200", data: { success: true, remaining: number } }
   */
  async validateConfig(): Promise<boolean> {
    if (!this.apiKey || this.apiKey.trim() === '') return false
    try {
      const res = await fetch(`${this.baseUrl}/fund/remaining`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      })
      if (!res.ok) return false
      const data = await res.json()
      return data.code === '200' && data.success === true
    } catch {
      return false
    }
  }
}

export interface BochaConfig {
  apiKey: string
  baseUrl?: string
}
