/**
 * 定价模块测试 — 费用估算（纯函数）
 *
 * 覆盖场景：
 * - 三档单价分别计费（输入 / 输出 / 缓存）
 * - 缓存价缺省时回退输入价
 * - 无单价 / 全 0 时不抛错、返回 0
 * - 内置价目表的子串匹配（模型 id 带日期后缀也能命中）
 * - 金额 / token 数展示格式
 */
import { describe, it, expect } from 'vitest'
import {
  computeCost,
  findDefaultPrice,
  findDefaultPriceEntry,
  formatCost,
  formatTokens,
  priceKey,
} from '@/domain/pricing'

describe('computeCost', () => {
  it('按每 1M tokens 的三档单价分别计费', () => {
    const cost = computeCost(
      { promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 2_000_000 },
      { input: 2, output: 10, cachedInput: 0.2 },
    )
    expect(cost.input).toBeCloseTo(2)
    expect(cost.output).toBeCloseTo(5)
    expect(cost.cached).toBeCloseTo(0.4)
    expect(cost.total).toBeCloseTo(7.4)
  })

  it('缓存价缺省时回退输入价（宁可高估，不静默漏计）', () => {
    const cost = computeCost(
      { promptTokens: 0, completionTokens: 0, cachedTokens: 1_000_000 },
      { input: 3, output: 15 },
    )
    expect(cost.cached).toBeCloseTo(3)
  })

  it('没有单价时返回 0，不抛错', () => {
    expect(
      computeCost({ promptTokens: 100, completionTokens: 100, cachedTokens: 0 }, null)
        .total,
    ).toBe(0)
    expect(
      computeCost({ promptTokens: 100, completionTokens: 100, cachedTokens: 0 }, undefined)
        .total,
    ).toBe(0)
  })

  it('token 全为 0 时费用为 0', () => {
    expect(
      computeCost(
        { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        { input: 5, output: 5, cachedInput: 1 },
      ).total,
    ).toBe(0)
  })
})

describe('findDefaultPrice', () => {
  it('精确模型名可命中', () => {
    expect(findDefaultPrice('gpt-4o-mini')?.input).toBe(0.15)
  })

  it('带日期后缀的模型 id 也能命中（子串匹配）', () => {
    expect(findDefaultPrice('gpt-4o-2024-08-06')).not.toBeNull()
    expect(findDefaultPrice('claude-3-5-sonnet-20241022')?.input).toBe(3)
  })

  it('未收录的模型返回 null', () => {
    expect(findDefaultPrice('my-local-llama')).toBeNull()
    expect(findDefaultPrice('')).toBeNull()
  })
})

describe('findDefaultPriceEntry', () => {
  it('返回价 + 展示名（单价页要用它回显生效单价）', () => {
    const entry = findDefaultPriceEntry('gpt-4o-2024-08-06')
    expect(entry?.label).toBe('GPT-4o')
    expect(entry?.price.input).toBe(2.5)
  })

  it('与 findDefaultPrice 命中同一条（避免两处口径跑偏）', () => {
    for (const model of ['gpt-4o-mini', 'claude-sonnet-4-20250514', 'deepseek-chat']) {
      expect(findDefaultPriceEntry(model)?.price).toEqual(findDefaultPrice(model))
    }
  })

  it('未收录 / 空串返回 null', () => {
    expect(findDefaultPriceEntry('glm-4-plus')).toBeNull()
    expect(findDefaultPriceEntry('')).toBeNull()
  })
})

describe('格式化', () => {
  it('formatCost 小额保留更多位，避免全是 0.00', () => {
    expect(formatCost(0, 'USD')).toBe('$0')
    expect(formatCost(0.0034, 'USD')).toBe('$0.0034')
    expect(formatCost(0.234, 'CNY')).toBe('¥0.234')
    expect(formatCost(12.3456, 'USD')).toBe('$12.35')
  })

  it('formatTokens 在 k / M 之间切换', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(150_000)).toBe('150k')
    expect(formatTokens(1_500_000)).toBe('1.50M')
  })
})

describe('priceKey', () => {
  it('键为 provider::model', () => {
    expect(priceKey('p1', 'gpt-4o')).toBe('p1::gpt-4o')
  })
})
