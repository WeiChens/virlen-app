// @vitest-environment node
/**
 * DeepSeek 搜索源：请求形状 / 字段映射 / 验 Key 口径。
 *
 * 与 Rust `native_tools/web/web_search.rs::search_deepseek` 是同一份语义（铁律 1），
 * 这里的断言就是那边的镜像：`snippet ← summary`、`score ← rerank_score / 3`、
 * 时间范围只能拼 `after:` 语法（官方没有 freshness 参数）、验 Key 走只读的余额接口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekSearchProvider } from '@/infrastructure/search-providers/deepseek'

/** 最小响应形状（只用到 ok / status / json / text） */
function mockResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

const fetchMock = () => vi.mocked(global.fetch)

/** 取第 n 次 fetch 的请求体（JSON 解析后） */
function requestBody(n = 0): Record<string, any> {
  return JSON.parse(fetchMock().mock.calls[n][1]!.body as string)
}

const provider = new DeepSeekSearchProvider({ apiKey: 'sk-test' })

afterEach(() => {
  fetchMock().mockReset()
})

describe('DeepSeekSearchProvider.search：请求形状', () => {
  it('打到 /v1/tools/search，Bearer 鉴权，body 只有 query + count', async () => {
    fetchMock().mockResolvedValueOnce(mockResponse({ results: [] }))

    await provider.search({ query: 'rust 异步', maxResults: 5 })

    expect(fetchMock()).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    )
    // 不传 need_content：官方默认 false，正文整页塞给模型不划算（summary 已够读）
    expect(requestBody()).toEqual({ query: 'rust 异步', count: 5 })
  })

  it('count 夹在 1~50，缺省 10（官方越界直接 400）', async () => {
    fetchMock().mockResolvedValue(mockResponse({ results: [] }))

    await provider.search({ query: 'q', maxResults: 999 })
    await provider.search({ query: 'q', maxResults: 0 })
    await provider.search({ query: 'q' })

    expect(requestBody(0).count).toBe(50)
    expect(requestBody(1).count).toBe(1)
    expect(requestBody(2).count).toBe(10)
  })

  it('自定义 baseUrl 的末尾斜杠被吞掉（避免拼出 //v1）', async () => {
    fetchMock().mockResolvedValueOnce(mockResponse({ results: [] }))

    await new DeepSeekSearchProvider({
      apiKey: 'k',
      baseUrl: 'https://example.com/',
    }).search({ query: 'q' })

    expect(fetchMock().mock.calls[0][0]).toBe('https://example.com/v1/tools/search')
  })
})

describe('DeepSeekSearchProvider.search：字段映射', () => {
  it('summary 当 snippet、rerank_score 归一到 0~1、null / 空串字段丢掉', async () => {
    fetchMock().mockResolvedValueOnce(
      mockResponse({
        results: [
          {
            rerank_score: 2.4,
            title: 'T1',
            url: 'https://a.com',
            snippet: '短摘要',
            summary: '长摘要',
            content: '',
            site_name: '站点',
            site_icon: null,
            date: '2026-06-01T00:00:00+00:00',
            authority: 3,
          },
          { title: 'T2', url: 'https://b.com', snippet: '只有短摘要', summary: '' },
        ],
      }),
    )

    const result = await provider.search({ query: 'q' })

    expect(result.totalResults).toBe(2)
    expect(result.items[0]).toMatchObject({
      title: 'T1',
      url: 'https://a.com',
      snippet: '长摘要',
      source: '站点',
      publishedDate: '2026-06-01T00:00:00+00:00',
    })
    expect(result.items[0].score).toBeCloseTo(0.8, 10)
    expect(result.items[0].icon).toBeUndefined()
    expect(result.items[0].content).toBeUndefined()
    // summary 为空 → 退回 snippet；缺字段一律 undefined
    expect(result.items[1].snippet).toBe('只有短摘要')
    expect(result.items[1].score).toBeUndefined()
    expect(result.items[1].source).toBeUndefined()
  })

  it('results 缺失 / 无结果 → 空列表（不抛错）', async () => {
    fetchMock().mockResolvedValueOnce(mockResponse({}))
    await expect(provider.search({ query: 'q' })).resolves.toMatchObject({
      items: [],
    })
  })
})

describe('DeepSeekSearchProvider.search：时间范围', () => {
  it('拼成 after:YYYY-MM-DD（官方没有 freshness 参数）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
    try {
      fetchMock().mockResolvedValueOnce(mockResponse({ results: [] }))
      await provider.search({ query: 'rust', timeRange: 'week' })
      expect(requestBody().query).toBe('rust after:2026-10-03')
    } finally {
      vi.useRealTimers()
    }
  })

  it('无时间范围原样发出', async () => {
    fetchMock().mockResolvedValueOnce(mockResponse({ results: [] }))
    await provider.search({ query: 'rust' })
    expect(requestBody().query).toBe('rust')
  })

  it('拼完超过 128 字符就放弃限定（官方上限，超了直接 400）', async () => {
    const long = 'a'.repeat(128)
    fetchMock().mockResolvedValueOnce(mockResponse({ results: [] }))
    await provider.search({ query: long, timeRange: 'day' })
    expect(requestBody().query).toBe(long)
  })
})

describe('DeepSeekSearchProvider：错误与验 Key', () => {
  it('非 2xx → 抛出带状态码与官方错误体', async () => {
    fetchMock().mockResolvedValueOnce(
      mockResponse(
        '{"error":{"message":"\'count\' must be between 1 and 50"}}',
        { ok: false, status: 400 },
      ),
    )

    await expect(provider.search({ query: 'q' })).rejects.toThrow(
      /DeepSeek API error \(400\).*between 1 and 50/,
    )
  })

  it('验 Key 走只读的余额接口，不发计费搜索', async () => {
    fetchMock().mockResolvedValueOnce(
      mockResponse({ is_available: true, balance_infos: [] }),
    )

    await expect(provider.validateConfig()).resolves.toBe(true)

    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/user/balance')
    expect(init!.method).toBe('GET')
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    )
  })

  it('Key 无效（401）→ false', async () => {
    fetchMock().mockResolvedValueOnce(
      mockResponse({ error: { message: 'invalid key' } }, { ok: false, status: 401 }),
    )
    await expect(provider.validateConfig()).resolves.toBe(false)
  })

  it('空 Key 直接 false，不发请求', async () => {
    await expect(
      new DeepSeekSearchProvider({ apiKey: '   ' }).validateConfig(),
    ).resolves.toBe(false)
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})
