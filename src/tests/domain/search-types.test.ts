/**
 * Search 领域类型测试 — 搜索供应商相关类型定义
 *
 * 覆盖场景：
 * - ISearchProvider 接口结构
 * - SearchParams 参数构建
 * - SearchResult / SearchResultItem 结构
 * - SearchTimeRange 枚举值
 * - 各搜索供应商摘要结构
 */
import { describe, it, expect } from 'vitest'
import type {
  ISearchProvider,
  SearchParams,
  SearchResult,
  SearchResultItem,
  SearchTimeRange,
  SearchProviderSummary,
} from '@/domain/search/types'

describe('SearchTimeRange', () => {
  it('应包含所有预期的时间范围值', () => {
    const ranges: SearchTimeRange[] = ['day', 'week', 'month', 'year', undefined]

    // 验证每个值都可以赋值
    const testRange = (range: SearchTimeRange) => {
      // 编译时类型检查：确保类型正确
      const params: SearchParams = { query: 'test', timeRange: range }
      expect(params.timeRange).toBe(range)
    }

    for (const r of ranges) {
      testRange(r)
    }
  })
})

describe('SearchParams', () => {
  it('query 是必填字段', () => {
    const params: SearchParams = { query: '如何学习 Rust' }
    expect(params.query).toBe('如何学习 Rust')
  })

  it('所有可选字段应能正常赋值', () => {
    const params: SearchParams = {
      query: 'test',
      maxResults: 20,
      language: 'zh-CN',
      region: 'cn',
      timeRange: 'week',
      extraParams: { site: 'github.com' },
    }
    expect(params.maxResults).toBe(20)
    expect(params.language).toBe('zh-CN')
    expect(params.region).toBe('cn')
    expect(params.timeRange).toBe('week')
    expect(params.extraParams).toEqual({ site: 'github.com' })
  })

  it('maxResults 默认应为 undefined（由供应商决定默认值）', () => {
    const params: SearchParams = { query: 'test' }
    expect(params.maxResults).toBeUndefined()
  })
})

describe('SearchResultItem', () => {
  it('title 和 url 是必填字段', () => {
    const item: SearchResultItem = {
      title: 'Rust 程序设计语言',
      url: 'https://www.rust-lang.org',
      snippet: 'Rust 是一门系统编程语言...',
    }
    expect(item.title).toBeTruthy()
    expect(item.url).toBeTruthy()
    expect(item.snippet).toBeTruthy()
  })

  it('可选字段应正确赋值', () => {
    const item: SearchResultItem = {
      title: 'Test',
      url: 'https://example.com',
      snippet: 'description',
      content: '全文内容...',
      publishedDate: '2024-01-15T00:00:00Z',
      source: '示例站点',
      score: 0.95,
    }
    expect(item.content).toBe('全文内容...')
    expect(item.publishedDate).toBe('2024-01-15T00:00:00Z')
    expect(item.source).toBe('示例站点')
    expect(item.score).toBe(0.95)
  })

  it('score 范围应在 0~1 之间', () => {
    const validScores = [0, 0.5, 1.0, 0.333]
    for (const score of validScores) {
      const item: SearchResultItem = {
        title: 't',
        url: 'https://example.com',
        snippet: 's',
        score,
      }
      expect(item.score).toBeGreaterThanOrEqual(0)
      expect(item.score).toBeLessThanOrEqual(1)
    }
  })
})

describe('SearchResult', () => {
  it('items 是必填字段', () => {
    const result: SearchResult = {
      items: [
        {
          title: 'Rust',
          url: 'https://rust-lang.org',
          snippet: 'A language empowering everyone',
        },
      ],
    }
    expect(result.items).toHaveLength(1)
  })

  it('应能构建带完整可选字段的搜索结果', () => {
    const result: SearchResult = {
      items: [
        { title: 'T1', url: 'https://a.com', snippet: 'S1' },
        { title: 'T2', url: 'https://b.com', snippet: 'S2' },
      ],
      totalResults: 1000,
      elapsedMs: 123,
      hasMore: true,
      suggestion: '您是不是想找：Rust 语言',
      rawResponse: { some: 'data' },
    }
    expect(result.totalResults).toBe(1000)
    expect(result.elapsedMs).toBe(123)
    expect(result.hasMore).toBe(true)
    expect(result.suggestion).toContain('Rust')
  })

  it('空结果列表应有效', () => {
    const result: SearchResult = { items: [] }
    expect(result.items).toHaveLength(0)
  })
})

describe('SearchProviderSummary', () => {
  it('应包含 id 和 name 字段', () => {
    const summary: SearchProviderSummary = {
      id: 'tavily',
      name: 'Tavily',
    }
    expect(summary.id).toBe('tavily')
    expect(summary.name).toBe('Tavily')
  })
})

describe('ISearchProvider 接口结构', () => {
  it('接口定义应包含 name、id、search 和 validateConfig', () => {
    // 实现一个最小化的 mock 验证接口契约
    const mockProvider: ISearchProvider = {
      name: 'MockProvider',
      id: 'mock',
      search: async (params) => ({
        items: [{ title: 'Mock', url: 'https://mock.com', snippet: 'Mock result' }],
      }),
      validateConfig: async () => true,
    }

    expect(mockProvider.name).toBe('MockProvider')
    expect(mockProvider.id).toBe('mock')
    expect(typeof mockProvider.search).toBe('function')
    expect(typeof mockProvider.validateConfig).toBe('function')
  })

  it('search 方法应支持 AbortSignal', () => {
    const controller = new AbortController()
    const provider: ISearchProvider = {
      name: 'Test',
      id: 'test',
      search: async (_params, signal) => {
        expect(signal).toBeDefined()
        return { items: [] }
      },
      validateConfig: async () => true,
    }
    expect(() => provider.search({ query: 'test' }, controller.signal)).not.toThrow()
  })
})
