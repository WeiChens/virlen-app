/**
 * 用量记账端口测试（domain/usage）
 *
 * 覆盖场景：
 * - 未注入实现时静默丢弃（业务代码可以无条件调用）
 * - 注入后透传流水
 * - 实现抛错时不影响调用方（记账是旁路能力）
 * - 缓存量推导 cachedTokensOf
 * - 口径拉平 ledgerTokensOf（这是「缓存 token 一直是 0」的修复点）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  bindUsageLedger,
  cachedTokensOf,
  cacheIncludedInPrompt,
  ledgerTokensOf,
  recordUsage,
  type UsageLedgerRecord,
} from '@/domain/usage'

function record(): UsageLedgerRecord {
  return {
    ts: 1000,
    sessionId: 's1',
    messageId: 'm1',
    model: 'gpt-4o',
    providerType: 'openai',
    providerConfigId: 'p1',
    kind: 'chat_round',
    round: 1,
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: 0,
    totalTokens: 120,
  }
}

describe('usage ledger 端口', () => {
  beforeEach(() => {
    // 每个用例重新绑定（默认未绑定 → 空操作）
    bindUsageLedger({ append: vi.fn() })
  })

  it('记账是发射即忘（同步返回，不阻塞主流程）', () => {
    const append = vi.fn()
    bindUsageLedger({ append })
    const ret = recordUsage(record())
    expect(ret).toBeUndefined()
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('注入后透传流水（字段不被改写）', () => {
    const append = vi.fn()
    bindUsageLedger({ append })
    recordUsage(record())
    expect(append).toHaveBeenCalledTimes(1)
    expect(append.mock.calls[0][0][0]).toMatchObject({
      sessionId: 's1',
      messageId: 'm1',
      kind: 'chat_round',
      totalTokens: 120,
    })
  })

  it('实现抛错时被吞掉（不得影响聊天主流程）', () => {
    bindUsageLedger({
      append: () => {
        throw new Error('disk full')
      },
    })
    expect(() => recordUsage(record())).not.toThrow()
  })
})

describe('cachedTokensOf', () => {
  it('OpenAI 口径（total = prompt + completion）→ 0', () => {
    expect(cachedTokensOf(150, 100, 50)).toBe(0)
  })

  it('Anthropic 口径（cache 计入 total）→ 差值即缓存量', () => {
    expect(cachedTokensOf(300, 100, 50)).toBe(150)
  })

  it('异常数据不产生负数', () => {
    expect(cachedTokensOf(10, 100, 50)).toBe(0)
  })
})

describe('ledgerTokensOf（口径拉平）', () => {
  it('OpenAI 兼容：缓存算在 prompt 里 → 从 prompt 减掉，不得重复计费', () => {
    const t = ledgerTokensOf(
      {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
        cachedTokens: 800,
      },
      'openai',
    )
    expect(t.promptTokens).toBe(200)
    expect(t.cachedTokens).toBe(800)
    // 不变式：归一化后三档之和必须等于 total
    expect(t.promptTokens + t.cachedTokens + t.completionTokens).toBe(
      t.totalTokens,
    )
  })

  it('Anthropic：prompt 本来就不含缓存 → 原样保留', () => {
    const t = ledgerTokensOf(
      {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 300,
        cachedTokens: 150,
      },
      'anthropic',
    )
    expect(t.promptTokens).toBe(100)
    expect(t.cachedTokens).toBe(150)
  })

  it('Gemini 的 cachedContentTokenCount 是 prompt 子集 → 同样减掉', () => {
    const t = ledgerTokensOf(
      {
        promptTokens: 500,
        completionTokens: 60,
        totalTokens: 560,
        cachedTokens: 300,
      },
      'gemini',
    )
    expect(t.promptTokens).toBe(200)
    expect(t.cachedTokens).toBe(300)
  })

  it('provider 未回报缓存 → 退回推导（Anthropic 把所有 cache 计进 total 仍能算出来）', () => {
    const t = ledgerTokensOf(
      { promptTokens: 100, completionTokens: 50, totalTokens: 300 },
      'openai',
    )
    expect(t.cachedTokens).toBe(150)
    expect(t.promptTokens).toBe(100)
  })

  it('异常数据：cached > prompt 时按 prompt 截断，prompt 不得为负', () => {
    const t = ledgerTokensOf(
      {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 999,
      },
      'openai',
    )
    expect(t.promptTokens).toBe(0)
    expect(t.cachedTokens).toBe(10)
  })

  it('cacheIncludedInPrompt：只有 anthropic 是 false', () => {
    expect(cacheIncludedInPrompt('anthropic')).toBe(false)
    expect(cacheIncludedInPrompt('openai')).toBe(true)
    expect(cacheIncludedInPrompt('gemini')).toBe(true)
    expect(cacheIncludedInPrompt(undefined)).toBe(true)
  })
})
