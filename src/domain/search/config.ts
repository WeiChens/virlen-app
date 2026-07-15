/**
 * 搜索供应商配置模板和类型定义
 *
 * 类比 domain/provider/config.ts（LLM 供应商配置模板），
 * 定义了内置搜索供应商的元信息和可持久化的配置结构。
 */

// ============================================================
// 可持久化的搜索供应商配置（存 localStorage）
// ============================================================

/** 搜索供应商类型标识 */
export type SearchProviderType =
  | 'tavily'
  // | 'searxng'
  | 'bocha'

/** 可持久化的搜索供应商配置 */
export interface SearchProviderConfig {
  /** 配置唯一 ID（如 "tavily-1"、"my-bing"） */
  id: string

  /** UI 展示名称 */
  name: string

  /** 供应商类型 */
  type: SearchProviderType

  /** API Key（部分供应商需要） */
  apiKey: string

  /** 自定义 Base URL */
  baseUrl: string

  /** 是否启用 */
  enabled: boolean

  /** 额外配置参数（透传给供应商构造器） */
  extraParams?: Record<string, any>

  /** 创建时间 */
  createdAt: number

  /** 更新时间 */
  updatedAt: number
}

// ============================================================
// 内置搜索供应商模板
// ============================================================

export interface SearchProviderTemplate {
  type: SearchProviderType
  label: string
  description: string
  /** 是否需要 API Key */
  requireApiKey: boolean
  /** 默认 Base URL */
  defaultBaseUrl: string
  /** 官网链接 */
  officialLink?: string
  icon: string
}

export const SEARCH_PROVIDER_TEMPLATES: SearchProviderTemplate[] = [
  {
    type: 'bocha',
    label: '博查',
    description: '博查 AI 开放平台搜索引擎，搜索结果丰富，支持中文搜索',
    requireApiKey: true,
    defaultBaseUrl: 'https://api.bocha.cn/v1',
    officialLink: 'https://open.bocha.cn',
    icon: '/supplier/bocha.ico',
  },
  {
    type: 'tavily',
    label: 'Tavily',
    description: 'AI Agent 专用搜索引擎，支持返回全文内容和自动摘要',
    requireApiKey: true,
    defaultBaseUrl: 'https://api.tavily.com',
    officialLink: 'https://tavily.com',
    icon: '/supplier/tavily.png',
  },
  // {
  //   type: 'searxng',
  //   label: 'SearXNG',
  //   description: '自建开源元搜索引擎，无需 API Key，聚合多搜索引擎结果',
  //   requireApiKey: false,
  //   defaultBaseUrl: 'http://localhost:8888',
  //   officialLink: 'https://docs.searxng.org',
  // },
]
