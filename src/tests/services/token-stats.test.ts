/**
 * token-stats-service 测试 — 用量统计编排
 *
 * 覆盖场景：
 * - 时间范围边界（本地时区「今日」/ 近 7 天）
 * - 单价解析优先级：用户配置 > 内置价目表 > null
 * - 聚合结果带费用（费用在前端算，Rust 只回 token）
 * - 明细逐行算费用（按行自带的 provider/model 取价）
 * - 按会话分桶时，通过 resolveSessionModel 把 sessionId 映射回模型取价
 * - 明细客户端筛选 / 排序（会话、模型关键字；Prompt/输出/缓存/合计排序）
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
  densifyTimeBuckets,
  filterAndSortRecords,
  loadRecords,
  loadStats,
  outputTokPerSec,
  parseTimeKey,
  rangeToBounds,
  rangeToFromTs,
  resolvePrice,
  startOfToday,
  summarizeRecords,
  timeKeyOf,
  type CostedRecord,
} from '@/services/token-stats-service'
import { USD_TO_CNY } from '@/domain/pricing'

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

  it('rangeToBounds 覆盖 昨天（含上界）与自定义区间', () => {
    const base = new Date(2026, 8, 21, 9, 0, 0).getTime() // 2026-09-21 09:00 本地
    const today0 = new Date(2026, 8, 21).getTime()
    // 昨天：[昨天 0 点, 今天 0 点 - 1ms]
    expect(rangeToBounds('yesterday', base)).toEqual({
      fromTs: today0 - DAY,
      toTs: today0 - 1,
    })
    // 自定义：两端归一化（颠倒也从小到大）
    expect(rangeToBounds('custom', base, { from: 500, to: 100 })).toEqual({
      fromTs: 100,
      toTs: 500,
    })
    // 自定义缺省 → 不过滤；预设范围只有下界
    expect(rangeToBounds('custom', base, null)).toEqual({})
    expect(rangeToBounds('7d', base)).toEqual({ fromTs: today0 - 6 * DAY })
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

  it('切到 CNY 时内置价按固定汇率折算，用户自填价原样（不二次折算）', () => {
    settings.value.usageCurrency = 'CNY'
    // 内置 claude-3-5-sonnet 输入 $3 → ¥21.6
    expect(resolvePrice('p1', 'claude-3-5-sonnet')?.input).toBeCloseTo(3 * USD_TO_CNY)
    // 用户自填价按当前币种存/算，不乘汇率
    settings.value.modelPricing = { 'p1::gpt-4o': { input: 1, output: 2 } }
    expect(resolvePrice('p1', 'gpt-4o')).toEqual({ input: 1, output: 2 })
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
          durationMs: 2_000,
          traceId: null,
        },
      ],
    })
    const { records, total } = await loadRecords('today')
    expect(total).toBe(1)
    // 内置价：gpt-4o-mini 输入 $0.15 / 1M
    expect(records[0].cost.input).toBeCloseTo(0.15)
    // 输出速度：0 completion ÷ 2s = 不可计算（没有输出 token）
    expect(outputTokPerSec(records[0])).toBeNull()
  })
})

describe('币种', () => {
  it('默认人民币，可切 USD', () => {
    ;(settings.value as any).usageCurrency = undefined
    expect(currentCurrency()).toBe('CNY')
    settings.value.usageCurrency = 'USD'
    expect(currentCurrency()).toBe('USD')
    settings.value.usageCurrency = 'CNY'
    expect(currentCurrency()).toBe('CNY')
  })
})

describe('输出速度（tok/s）', () => {
  it('completion ÷ 请求耗时（秒）', () => {
    expect(outputTokPerSec({ completionTokens: 500, durationMs: 10_000 })).toBe(50)
    expect(outputTokPerSec({ completionTokens: 1, durationMs: 3_000 })).toBeCloseTo(0.333, 3)
  })

  it('拿不到耗时就返回 null（旧流水 / 时钟异常），不是 0', () => {
    // 回归：展示 0 tok/s 会把「没数据」读成「很慢」
    expect(outputTokPerSec({ completionTokens: 500, durationMs: 0 })).toBeNull()
    expect(outputTokPerSec({ completionTokens: 500 })).toBeNull()
    expect(outputTokPerSec({ completionTokens: 500, durationMs: -1 })).toBeNull()
    // 没有输出 token（如纯 tool_call / 估算失败）也无可比速度
    expect(outputTokPerSec({ completionTokens: 0, durationMs: 1_000 })).toBeNull()
  })

  it('可按 tok/s 排序，算不出的行沉底', () => {
    const rec = (id: number, completionTokens: number, durationMs: number): CostedRecord =>
      ({
        id,
        ts: 0,
        sessionId: 's1',
        sessionTitle: '会话',
        messageId: null,
        model: 'gpt-4o',
        providerType: null,
        providerConfigId: null,
        kind: 'chat_round',
        round: null,
        promptTokens: 0,
        completionTokens,
        cachedTokens: 0,
        totalTokens: completionTokens,
        estimated: false,
        durationMs,
        traceId: null,
        cost: { input: 0, output: 0, cached: 0, total: 0 },
      })
    const data = [
      rec(1, 100, 10_000), // 10 tok/s
      rec(2, 100, 1_000), // 100 tok/s
      rec(3, 100, 0), // 旧流水：算不出
    ]
    const out = filterAndSortRecords(data, {}, 'tokPerSec', 'desc')
    expect(out.map((r) => r.id)).toEqual([2, 1, 3])
  })
})

describe('summarizeRecords（明细汇总，作用于全部筛选结果）', () => {
  const rec = (p: Partial<CostedRecord>): CostedRecord => ({
    id: 0,
    ts: 0,
    sessionId: 's1',
    sessionTitle: '会话',
    messageId: null,
    model: 'gpt-4o',
    providerType: null,
    providerConfigId: null,
    kind: 'chat_round',
    round: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimated: false,
    durationMs: 0,
    traceId: null,
    cost: { input: 0, output: 0, cached: 0, total: 0 },
    ...p,
  })

  it('对全部记录求和（非当前页），tok/s 按可测行加权，费用温总', () => {
    const s = summarizeRecords([
      rec({
        promptTokens: 100,
        completionTokens: 200,
        cachedTokens: 50,
        totalTokens: 300,
        durationMs: 1_000,
        cost: { input: 0.1, output: 0.2, cached: 0.05, total: 0.35 },
      }),
      rec({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        durationMs: 1_000,
        cost: { input: 0.01, output: 0.02, cached: 0, total: 0.03 },
      }),
      // 未记耗时 → 不参与 tok/s（但 token 与费用仍计入合计）
      rec({ promptTokens: 1, completionTokens: 5, totalTokens: 6, durationMs: 0 }),
    ])
    expect(s.count).toBe(3)
    expect(s.promptTokens).toBe(111)
    expect(s.completionTokens).toBe(225)
    expect(s.cachedTokens).toBe(50)
    expect(s.totalTokens).toBe(336)
    expect(s.rateSamples).toBe(2)
    // (200 + 20) / (2000 ms / 1000) = 110
    expect(s.tokPerSec).toBeCloseTo(110)
    // 费用逐项求和
    expect(s.cost.total).toBeCloseTo(0.38)
    expect(s.cost.input).toBeCloseTo(0.11)
    expect(s.cost.output).toBeCloseTo(0.22)
    expect(s.cost.cached).toBeCloseTo(0.05)
  })

  it('无可测行时 tok/s 为 null（不当 0）', () => {
    const s = summarizeRecords([rec({ completionTokens: 10, durationMs: 0 })])
    expect(s.tokPerSec).toBeNull()
    expect(s.rateSamples).toBe(0)
  })

  it('空集合返回全 0 且 tok/s 为 null', () => {
    expect(summarizeRecords([])).toEqual({
      count: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cached: 0, total: 0 },
      tokPerSec: null,
      rateSamples: 0,
    })
  })
})

describe('filterAndSortRecords（明细客户端筛选 / 排序）', () => {
  const rec = (p: Partial<CostedRecord>): CostedRecord => ({
    id: 0,
    ts: 0,
    sessionId: 's1',
    sessionTitle: '会话',
    messageId: null,
    model: 'gpt-4o',
    providerType: null,
    providerConfigId: null,
    kind: 'chat_round',
    round: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimated: false,
    durationMs: 0,
    traceId: null,
    cost: { input: 0, output: 0, cached: 0, total: 0 },
    ...p,
  })
  const zero = { input: 0, output: 0, cached: 0, total: 0 }
  const data: CostedRecord[] = [
    rec({
      id: 1,
      ts: 100,
      sessionTitle: '重构 Agent 引擎',
      model: 'gpt-4o',
      promptTokens: 10,
      completionTokens: 5,
      cost: { ...zero, total: 0.3 },
    }),
    rec({
      id: 2,
      ts: 200,
      sessionTitle: '修 bug',
      model: 'claude-sonnet-5',
      promptTokens: 30,
      completionTokens: 1,
      cost: { ...zero, total: 0.1 },
    }),
    rec({
      id: 3,
      ts: 300,
      sessionTitle: '写文档',
      model: 'deepseek-chat',
      kind: 'compress',
      promptTokens: 20,
      completionTokens: 9,
      cost: { ...zero, total: 0.5 },
    }),
  ]

  it('会话关键字子串匹配（忽略大小写）', () => {
    const out = filterAndSortRecords(data, { sessionKeyword: 'agent' }, 'ts', 'desc')
    expect(out.map((r) => r.id)).toEqual([1])
  })

  it('模型关键字子串匹配', () => {
    const out = filterAndSortRecords(data, { modelKeyword: 'SONNET' }, 'ts', 'desc')
    expect(out.map((r) => r.id)).toEqual([2])
  })

  it('类型精确过滤', () => {
    const out = filterAndSortRecords(data, { kind: 'compress' }, 'ts', 'desc')
    expect(out.map((r) => r.id)).toEqual([3])
  })

  it('按 Prompt token 升序排序', () => {
    const out = filterAndSortRecords(data, {}, 'promptTokens', 'asc')
    expect(out.map((r) => r.id)).toEqual([1, 3, 2])
  })

  it('数值相等时按时间倒序兜底（排序稳定）', () => {
    const tie = [
      rec({ id: 1, ts: 100, totalTokens: 5 }),
      rec({ id: 2, ts: 300, totalTokens: 5 }),
      rec({ id: 3, ts: 200, totalTokens: 5 }),
    ]
    const out = filterAndSortRecords(tie, {}, 'totalTokens', 'asc')
    expect(out.map((r) => r.id)).toEqual([2, 3, 1])
  })

  it('多个条件同时生效（AND）', () => {
    const out = filterAndSortRecords(
      data,
      { sessionKeyword: '修', modelKeyword: 'claude', kind: 'chat_round' },
      'ts',
      'desc',
    )
    expect(out.map((r) => r.id)).toEqual([2])
  })
})

/**
 * 时间轴补零（回归：只在有流水的时段才有列，看起来像「数据错了」）。
 *
 * Rust 的聚合只回有数据的桶，补零必须由服务层在前端做。
 */
describe('时间桶补零（时间轴连续）', () => {
  beforeEach(() => {
    settings.value.modelPricing = {}
    settings.value.usageCurrency = 'USD'
    mockStats.mockReset()
  })

  /** 所有查询都回同一套数据（模型维度另给一份） */
  const respond = (byGroup: Record<string, any>, fallback: any) =>
    mockStats.mockImplementation((q: any) =>
      Promise.resolve(byGroup[q.groupBy] ?? fallback),
    )

  it('今日 + 按小时：只在 7、8 点用过，也要从 0 点铺到当前小时', async () => {
    const now = new Date(2026, 8, 21, 15, 30).getTime()
    const totals = bucket('', 300, 30)
    respond(
      {
        hour: {
          buckets: [
            bucket('2026-09-21 07', 100, 10),
            bucket('2026-09-21 08', 200, 20),
          ],
          totals,
          firstTs: 1,
          lastTs: 2,
        },
      },
      { buckets: [bucket('gpt-4o', 300, 30)], totals, firstTs: 1, lastTs: 2 },
    )

    const view = await loadStats('today', 'hour', { now })
    expect(view.degraded).toBe(false)
    expect(view.groupBy).toBe('hour')
    expect(view.buckets.map((b) => b.key)).toEqual(
      Array.from(
        { length: 16 },
        (_, h) => `2026-09-21 ${String(h).padStart(2, '0')}`,
      ),
    )
    expect(view.buckets[7].promptTokens).toBe(100)
    expect(view.buckets[8].promptTokens).toBe(200)
    // 空档是「值为 0 的桶」，不是「没有这一列」
    expect(view.buckets[0].totalTokens).toBe(0)
    expect(view.buckets[0].calls).toBe(0)
    // 补零不改变总量（合计仍来自 SQL）
    expect(view.totals.totalTokens).toBe(330)
  })

  it('近 7 天 + 按天：只有一天有数据也出满 7 列', async () => {
    const now = new Date(2026, 8, 21, 15, 30).getTime()
    const totals = bucket('', 50, 5)
    respond(
      {
        day: {
          buckets: [bucket('2026-09-18', 50, 5)],
          totals,
          firstTs: 1,
          lastTs: 2,
        },
      },
      { buckets: [bucket('gpt-4o', 50, 5)], totals, firstTs: 1, lastTs: 2 },
    )

    const view = await loadStats('7d', 'day', { now })
    expect(view.buckets.map((b) => b.key)).toEqual([
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
    ])
    expect(view.buckets[3].totalTokens).toBe(55)
    expect(view.buckets.filter((b) => b.totalTokens === 0)).toHaveLength(6)
  })

  it('全部：轴从最早一条流水那天铺到今天', async () => {
    const now = new Date(2026, 8, 21, 10, 0).getTime()
    const totals = bucket('', 50, 5)
    respond(
      {
        day: {
          buckets: [bucket('2026-08-01', 50, 5)],
          totals,
          firstTs: 1,
          lastTs: 2,
        },
      },
      { buckets: [bucket('gpt-4o', 50, 5)], totals, firstTs: 1, lastTs: 2 },
    )

    const view = await loadStats('all', 'day', { now })
    // 8/1 ~ 9/21 = 31 + 21 天
    expect(view.buckets).toHaveLength(52)
    expect(view.buckets[0].key).toBe('2026-08-01')
    expect(view.buckets[51].key).toBe('2026-09-21')
  })

  it('跨度过大时自动放粗粒度（全部 + 按小时 → 按周）并回传 degraded', async () => {
    const now = new Date(2026, 8, 21, 10, 0).getTime()
    const totals = bucket('', 50, 5)
    respond(
      {
        hour: {
          buckets: [bucket('2020-01-01 00', 50, 5)],
          totals,
          firstTs: 1,
          lastTs: 2,
        },
        week: {
          buckets: [bucket('2020-01', 50, 5)],
          totals,
          firstTs: 1,
          lastTs: 2,
        },
      },
      { buckets: [bucket('gpt-4o', 50, 5)], totals, firstTs: 1, lastTs: 2 },
    )

    const view = await loadStats('all', 'hour', { now })
    expect(view.degraded).toBe(true)
    expect(view.groupBy).toBe('week')
    // 主查询确实以更粗的粒度重查了一次（小时跨度 6 年多 → 降级）
    expect(mockStats).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'week' }),
    )
    // 轴覆盖全部数据，不截断（2020-01 起到今天 ≈ 351 周）
    expect(view.buckets.length).toBeGreaterThan(300)
    expect(view.buckets[0].key).toBe('2020-00')
    // 末尾是「本周」（还没数据 → 0）；数据周的桶仍在，没被补零吞掉
    expect(view.buckets.find((b) => b.key === '2020-01')?.totalTokens).toBe(55)
    expect(view.buckets[view.buckets.length - 1].totalTokens).toBe(0)
  })
})

describe('时间桶工具函数', () => {
  it('时段 key 与 Rust strftime 口径一致（周：1/1 之前算第 00 周）', () => {
    // 2026-01-01 是周四 → 第一个周一为 01-05，1/1~1/4 属第 00 周
    expect(timeKeyOf('week', new Date(2026, 0, 1))).toBe('2026-00')
    expect(timeKeyOf('week', new Date(2026, 0, 5))).toBe('2026-01')
    expect(timeKeyOf('week', new Date(2026, 0, 12))).toBe('2026-02')
    expect(timeKeyOf('day', new Date(2026, 8, 21))).toBe('2026-09-21')
    expect(timeKeyOf('hour', new Date(2026, 8, 21, 7))).toBe('2026-09-21 07')
    expect(timeKeyOf('month', new Date(2026, 8, 21))).toBe('2026-09')
  })

  it('parseTimeKey 与 timeKeyOf 互逆（周按周一解析）', () => {
    for (const unit of ['hour', 'day', 'week', 'month'] as const) {
      const d = new Date(2026, 8, 21, 7)
      const key = timeKeyOf(unit, d)
      const back = parseTimeKey(unit, key)
      expect(back).not.toBeNull()
      expect(timeKeyOf(unit, back!)).toBe(key)
    }
    // 认不出来的 key 返回 null（调用方据此放弃补零）
    expect(parseTimeKey('day', 'gpt-4o')).toBeNull()
  })

  it('densifyTimeBuckets：缺的补 0，口径不一致的 key 兜底保留', () => {
    const out = densifyTimeBuckets(
      'day',
      ['2026-09-01', '2026-09-02', '2026-09-03'],
      [bucket('2026-09-02', 10, 1), bucket('2026-99-01', 20, 2)],
    )
    expect(out.map((b) => b.key)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-99-01',
    ])
    expect(out[0].totalTokens).toBe(0)
    expect(out[1].totalTokens).toBe(11)
    // 数据不能因为补零被吞掉
    expect(out[3].totalTokens).toBe(22)
  })
})
