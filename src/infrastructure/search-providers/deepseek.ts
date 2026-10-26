/**
 * DeepSeek Search Provider — 接入 DeepSeek 官方网页搜索接口
 *
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search
 * EndPoint：`POST https://api.deepseek.com/v1/tools/search`（Bearer 鉴权，与对话接口同一个 Key）
 *
 * 请求字段：`query`（1~128 字符，支持 `site:` / `after:` 等搜索语法）/ `count`（1~50，默认 10）/
 * `need_content`（默认 false，为 false 时 `content` 恒为空）。
 * 响应：`{ results: [{ rerank_score, title, url, snippet, summary, content, site_name, site_icon, date, authority }] }`
 *
 * 字段映射（⚠️ 与 Rust `native_tools/web/web_search.rs::deepseek_items` 逐字对齐，铁律 1）：
 *   - `snippet` ← `summary`（600~800 字符，官方口径「适用于给模型阅读」；为空时退回 `snippet`）
 *   - `score`   ← `rerank_score / 3`（0~3 分归一化到领域约定的 0~1，1.5 分 ≈ 50%）
 *   - `publishedDate` / `source` / `icon` ← `date` / `site_name` / `site_icon`
 * 不请求正文（`need_content` 保持默认 false）：summary 已够模型读，开正文会让每条结果膨胀成整页。
 */
import type {
  ISearchProvider,
  SearchParams,
  SearchResult,
  SearchResultItem,
  SearchTimeRange,
} from '@/domain/search/types'

/** 结果项（保持官方 snake_case，便于对照文档） */
interface DeepSeekResult {
  rerank_score?: number
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  site_name?: string | null
  site_icon?: string | null
  date?: string | null
  authority?: number
}

interface DeepSeekSearchResponse {
  results?: DeepSeekResult[]
}

/** 时间范围 → 往前推的天数（拼 `after:` 用） */
const RANGE_DAYS: Record<Exclude<SearchTimeRange, undefined>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
}

/** query 上限（官方 1~128 字符）：加 `after:` 后超限就放弃时间限定，不能把查询本身挤成 400 */
const MAX_QUERY_CHARS = 128
/** count 上限（官方 1~50） */
const MAX_COUNT = 50
/** rerank_score 满分（0~3） */
const MAX_RERANK_SCORE = 3

/**
 * 拼上时间限定：DeepSeek 没有 freshness 参数，只能走 query 里的 `after:YYYY-MM-DD` 语法。
 * ⚠️ 与 Rust `deepseek_query` 逐字对齐：日期一律按 UTC 算。
 */
function withTimeRange(query: string, range: SearchTimeRange): string {
  if (!range) return query
  const day = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const suffix = ` after:${day}`
  return query.length + suffix.length <= MAX_QUERY_CHARS
    ? query + suffix
    : query
}

export class DeepSeekSearchProvider implements ISearchProvider {
  readonly name = 'DeepSeek'
  readonly id = 'deepseek'

  private apiKey: string
  private baseUrl: string

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey
    // base 只到域名：搜索在 `/v1/tools/search`、余额在 `/user/balance`，两个前缀不同，
    // 不能把 `/v1` 算进 base（否则余额地址会变成 `/v1/user/balance`）
    this.baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
  }

  async search(
    params: SearchParams,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const started = Date.now()

    const response = await fetch(`${this.baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: withTimeRange(params.query, params.timeRange),
        count: Math.max(1, Math.min(params.maxResults ?? 10, MAX_COUNT)),
      }),
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      throw new Error(`DeepSeek API error (${response.status}): ${errorBody}`)
    }

    const data: DeepSeekSearchResponse = await response.json()

    const items: SearchResultItem[] = (data.results ?? []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.summary || r.snippet || '',
      content: r.content || undefined,
      publishedDate: r.date || undefined,
      source: r.site_name || undefined,
      icon: r.site_icon || undefined,
      score:
        typeof r.rerank_score === 'number' && Number.isFinite(r.rerank_score)
          ? Math.min(1, Math.max(0, r.rerank_score / MAX_RERANK_SCORE))
          : undefined,
    }))

    return {
      items,
      totalResults: items.length,
      elapsedMs: Date.now() - started,
      rawResponse: data,
    }
  }

  /**
   * 用余额接口验 Key（`GET /user/balance`）：只读、不计费。
   * 不用搜索接口验证 —— 一次搜索就是一次计费请求（返结果才收费，但仍要花钱）。
   */
  async validateConfig(): Promise<boolean> {
    if (!this.apiKey || this.apiKey.trim() === '') return false
    try {
      const res = await fetch(`${this.baseUrl}/user/balance`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      return res.ok
    } catch {
      return false
    }
  }
}

export interface DeepSeekConfig {
  apiKey: string
  baseUrl?: string
}
