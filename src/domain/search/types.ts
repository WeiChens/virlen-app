/**
 * 搜索供应商领域类型定义
 *
 * ISearchProvider — 所有搜索引擎供应商需要实现的接口
 * 类似于 IProvider（LLM 供应商），但针对搜索场景
 */

// ============================================================
// 1. 搜索供应商接口定义
// ============================================================

/** 搜索供应商接口 — 所有搜索供应商必须实现此接口 */
export interface ISearchProvider {
  /** 供应商名称（展示用，如 "Tavily", "Bing", "SearXNG"） */
  readonly name: string

  /** 供应商唯一标识（如 "tavily", "bing", "searxng"） */
  readonly id: string

  /** 执行搜索 */
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult>

  /** 验证配置是否有效（如 API Key 是否正确） */
  validateConfig(): Promise<boolean>
}

// ============================================================
// 2. 搜索参数与结果类型
// ============================================================

/** 搜索参数 */
export interface SearchParams {
  /** 搜索关键词 */
  query: string

  /** 返回结果数量上限，默认 10 */
  maxResults?: number

  /** 搜索语言（如 "zh-CN", "en-US"），部分供应商支持 */
  language?: string

  /** 搜索区域（如 "cn", "us"），部分供应商支持 */
  region?: string

  /** 搜索时间范围 */
  timeRange?: SearchTimeRange

  /** 额外供应商特定参数（透传） */
  extraParams?: Record<string, any>
}

/** 搜索时间范围 */
export type SearchTimeRange =
  | 'day' // 过去 24 小时
  | 'week' // 过去一周
  | 'month' // 过去一个月
  | 'year' // 过去一年
  | undefined // 不限时间

/** 单条搜索结果项 */
export interface SearchResultItem {
  /** 标题 */
  title: string

  /** URL 链接 */
  url: string

  icon?: string

  /** 摘要/描述 */
  snippet: string

  /** 全文内容（仅当 includeContent=true 且供应商支持时返回） */
  content?: string

  /** 发布时间（ISO 8601 格式，部分供应商支持） */
  publishedDate?: string

  /** 来源站点名称 */
  source?: string

  /** 结果分数/相关性（0-1） */
  score?: number
}

/** 搜索结果 */
export interface SearchResult {
  /** 搜索结果列表 */
  items: SearchResultItem[]

  /** 总结果数（部分供应商返回近似值） */
  totalResults?: number

  /** 搜索耗时（ms） */
  elapsedMs?: number

  /** 是否有更多结果 */
  hasMore?: boolean

  /** 搜索建议（拼写纠正等） */
  suggestion?: string

  /** 供应商原始响应（调试用） */
  rawResponse?: any
}

/** 搜索供应商摘要（用于 UI 列表展示） */
export interface SearchProviderSummary {
  id: string
  name: string
}
