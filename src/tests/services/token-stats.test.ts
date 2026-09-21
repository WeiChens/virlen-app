/**
 * token-stats-service 测试 — 用量统计编排
 *
 * 覆盖场景：
 * - 时间范围边界（本地时区「今日」/ 近 7 天）
 * - 单价解析优先级：用户配置 > 内置价目表 > null
 * - 聚合结果带费用（费用在前端算，Rust 只回 token）
 * - 明细逐行算费用（按行自带的 provider/model 取价）
 * - 按会话分桶时，通过 resolveSessionModel 把 sessionId 映射回模型取价
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockStats, mockRecords, mockClear, settings } = vi.hoisted(() => ({
  mockStats: vi.fn(),
  mockRecords: vi.fn(),
  mockClear: vi.fn(),
  settings: {
    value: {
      modelPricing: {} as Record<string, any>,
      usageCurrency: 'USD',
    },
  },
}))

vi.mock('@/infrastructure/statsRepo', () => ({
  statsRepo: { stats: mockStats, records: mockRecords, clear: mockClear },
}))

vi.mock('@/ui/store', () => ({ settingsState: settings }))

import {
  currentCurrency,
  loadRecords,
  loadStats,
  rangeToFromTs,
  resolvePrice,
  startOfToday,
} from '@/services/token-stats-service'

const DAY = 24 * 3600 * 1000

function bucket(key: string, prompt: number, completion: number) {
  return {
    key,
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: 0,
    totalTokens: prompt + completion,
    calls: 1,
    estimatedCalls: 0,
  }
}

describe('时间范围', () => {
  it('startOfToday 取本地零点', () => {
    const base = new Date(2026, 8, 21, 15, 30, 0).getTime() // 2026-09-21 15:30 本地
    expect(startOfToday(base)).toBe(new Date(2026, 8, 21, 0, 0, 0).getTime())
  })

  it('rangeToFromTs 覆盖 今日 / 近 7 天 / 全部', () => {
    const base = new Date(2026, 8, 21, 9, 0, 0).getTime()
    expect(rangeToFromTs('today', base)).toBe(new Date(2026, 8, 21).getTime())
    expect(rangeToFromTs('7d', base)).toBe(new Date(2026, 8, 21).getTime() - 6 * DAY)
    expect(rangeToFromTs('all', base)).toBeUndefined()
  })
})

describe('单价解析', () => {
  beforeEach(() => {
    settings.value.modelPricing = {}
    settings.value.usageCurrency = 'USD'
  })

  it('用户配置优先于内置价目表', () => {
    settings.value.modelPricing = { 'p1::gpt-4o': { input: 1, output: 2 } }
    expect(resolvePrice('p1', 'gpt-4o')).toEqual({ input: 1, output: 2 })
  })

  it('未配置时回退内置价目表', () => {
    expect(resolvePrice('p1', 'claude-3-5-sonnet')?.input).toBe(3)
  })

  it('同一模型在别的 provider 下配过价也能命中', () => {
    settings.value.modelPricing = { 'other::deepseek-chat': { input: 9, output: 9 } }
    expect(resolvePrice('p1', 'deepseek-chat')).toEqual({ input: 9, output: 9 })
  })

  it('未收录模型返回 null（费用按 0 计，不影响页面）', () => {
    expect(resolvePrice('p1', 'unknown-model-xyz')).toBeNull()
  })
})

describe('loadStats', () => {
  beforeEach(() => {
    settings.value.modelPricing = { 'p1::gpt-4o': { input: 1, output: 10 } }
    settings.value.usageCurrency = 'USD'
    mockStats.mockReset()
  })

  it('聚合结果带上费用，合计 = 各桶费用之和', async () => {
    mockStats.mockResolvedValue({
      buckets: [bucket('gpt-4o', 1_000_000, 100_000)],
      totals: bucket('', 1_000_000, 100_000),
      firstTs: 1,
      lastTs: 2,
    })
    const view = await loadStats('7d', 'model')
    expect(view.buckets).toHaveLength(1)
    // 1M 输入 × $1 + 0.1M 输出 × $10 = $1 + $1
    expect(view.buckets[0].cost.total).toBeCloseTo(2)
    expect(view.totals.cost.total).toBeCloseTo(2)
    expect(view.totals.currency).toBe('USD')
  })

  it('按会话分桶时用 resolveSessionModel 反查模型取价', async () => {
    mockStats.mockResolvedValue({
      buckets: [bucket('s1', 1_000_000, 0)],
      totals: bucket('', 1_000_000, 0),
      firstTs: null,
      lastTs: null,
    })
    const view = await loadStats('7d', 'session', {
      resolveSessionModel: () => ({ providerConfigId: 'p1', modelId: 'gpt-4o' }),
    })
    expect(view.buckets[0].cost.total).toBeCloseTo(1)
  })

  it('会话已删除（解析不到模型）时费用为 0 而非抛错', async () => {
    mockStats.mockResolvedValue({
      buckets: [bucket('gone', 1_000_000, 0)],
      totals: bucket('', 1_000_000, 0),
      firstTs: null,
      lastTs: null,
    })
    const view = await loadStats('7d', 'session', {
      resolveSessionModel: () => undefined,
    })
    expect(view.buckets[0].cost.total).toBe(0)
  })

  it('合计费用按「模型」拆解算，与当前分桶维度无关（回归：按天分桶时合计算成 0）', async () => {
    mockStats.mockImplementation((q: any) =>
      Promise.resolve(
        q.groupBy === 'model'
          ? {
              buckets: [
                bucket('gpt-4o', 1_000_000, 0),
                bucket('deepseek-chat', 1_000_000, 0),
              ],
              totals: bucket('', 2_000_000, 0),
              firstTs: null,
              lastTs: null,
            }
          : {
              buckets: [bucket('2026-09-21', 2_000_000, 0)],
              totals: bucket('', 2_000_000, 0),
              firstTs: null,
              lastTs: null,
            },
      ),
    )

    const view = await loadStats('7d', 'day')
    // 时间桶里没有模型信息 → 单桶费用仍是 0（合理）
    expect(view.buckets[0].cost.total).toBe(0)
    // 但合计必须算对：gpt-4o 输入 $1 + deepseek-chat 输入 $0.28（每 1M）
    expect(view.totals.cost.total).toBeCloseTo(1.28)
    // 模型维度的桶对外暴露（饼图「按模型」用它，不需要额外再查一次）
    expect(view.modelBuckets.map((b) => b.key)).toEqual([
      'gpt-4o',
      'deepseek-chat',
    ])
    // 当前维度 + 模型维度共两次聚合
    expect(mockStats).toHaveBeenCalledTimes(2)
    expect(mockStats).toHaveBeenLastCalledWith(
      expect.objectContaining({ groupBy: 'model' }),
    )
  })

  it('已经按模型分桶时不再重复查一次', async () => {
    mockStats.mockResolvedValue({
      buckets: [bucket('gpt-4o', 1_000_000, 0)],
      totals: bucket('', 1_000_000, 0),
      firstTs: null,
      lastTs: null,
    })
    const view = await loadStats('all', 'model')
    expect(view.totals.cost.total).toBeCloseTo(1)
    // 本就是模型维度：modelBuckets 直接复用当前桶
    expect(view.modelBuckets).toEqual(view.buckets)
    expect(mockStats).toHaveBeenCalledTimes(1)
  })
})

describe('loadRecords', () => {
  beforeEach(() => {
    settings.value.modelPricing = {}
    settings.value.usageCurrency = 'USD'
    mockRecords.mockReset()
  })

  it('逐行按自己的 provider/model 算费用', async () => {
    mockRecords.mockResolvedValue({
      total: 1,
      records: [
        {
          id: 1,
          ts: 1,
          sessionId: 's1',
          sessionTitle: '会话',
          messageId: 'm1',
          model: 'gpt-4o-mini',
          providerType: 'openai',
          providerConfigId: 'p1',
          kind: 'chat_round',
          round: 1,
          promptTokens: 1_000_000,
          completionTokens: 0,
          cachedTokens: 0,
          totalTokens: 1_000_000,
          estimated: false,
          traceId: null,
        },
      ],
    })
    const { records, total } = await loadRecords('today')
    expect(total).toBe(1)
    // 内置价：gpt-4o-mini 输入 $0.15 / 1M
    expect(records[0].cost.input).toBeCloseTo(0.15)
  })
})

describe('币种', () => {
  it('默认 USD，可切 CNY', () => {
    settings.value.usageCurrency = 'USD'
    expect(currentCurrency()).toBe('USD')
    settings.value.usageCurrency = 'CNY'
    expect(currentCurrency()).toBe('CNY')
  })
})
