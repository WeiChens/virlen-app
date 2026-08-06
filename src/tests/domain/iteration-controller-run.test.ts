/**
 * IterationController.run 返回语义测试
 *
 * 回归：失败路径（超出最大迭代次数）此前返回 completed: true，
 * 与文档契约「true = 目标达成，false = 超出最大迭代次数」矛盾。
 * 本文件通过 mock executeLLMRound / llmVerifier 验证 run() 的返回语义。
 *
 * 独立文件的原因：需要 mock @/domain/engine/verifier，
 * 而 iteration-controller.test.ts 直接使用真实的 LLMVerifier 类，不能在同一文件内 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/domain/engine/llm-loop', () => ({
  executeLLMRound: vi.fn(),
}))

vi.mock('@/domain/engine/verifier', () => ({
  llmVerifier: { verify: vi.fn() },
}))

import { IterationController } from '@/domain/engine/iteration-controller'
import { executeLLMRound } from '@/domain/engine/llm-loop'
import { llmVerifier } from '@/domain/engine/verifier'
import type { Message, Session } from '@/types'
import type { ToolDefinition } from '@/domain/tools/types'

function buildParams(overrides: Record<string, any> = {}) {
  const session: Session = {
    id: 's1',
    title: 't',
    messages: [],
    providerConfigId: 'p1',
    modelId: 'model-x',
    systemPrompt: '',
    params: { temperature: 0.7, topP: 1, maxTokens: 100, stream: true },
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    tags: [],
  }
  return {
    goal: { description: '测试目标' },
    session,
    provider: {} as any,
    toolDefs: [] as ToolDefinition[],
    currentMessages: [] as Message[],
    sessionId: 's1',
    abortController: new AbortController(),
    onEvent: vi.fn(),
    onUserInteraction: vi.fn(),
    skills: [] as string[],
    effectiveMaxTokens: 1000,
    reasoningEffort: undefined as string | undefined,
    persistSnapshot: vi.fn(),
    clearSnapshot: vi.fn(),
    ...overrides,
  }
}

/** 无 tool calls 的一轮 LLM 结果 */
function roundResult(): {
  ctx: null
  assistantMessage: Message
  toolResultMessages: Message[]
  paused: boolean
} {
  return {
    ctx: null,
    assistantMessage: {
      id: 'a1',
      role: 'assistant',
      content: 'ok',
      timestamp: Date.now(),
    } as Message,
    toolResultMessages: [],
    paused: false,
  }
}

describe('IterationController.run 返回语义', () => {
  beforeEach(() => {
    vi.mocked(executeLLMRound).mockReset()
    vi.mocked(llmVerifier.verify).mockReset()
  })

  it('验证通过 → completed: true', async () => {
    vi.mocked(executeLLMRound).mockResolvedValue(roundResult())
    vi.mocked(llmVerifier.verify).mockResolvedValue({
      passed: true,
      summary: '目标达成',
      issues: [],
    })

    const controller = new IterationController({ maxIterations: 2 })
    const result = await controller.run(buildParams() as any)

    expect(result.completed).toBe(true)
  })

  it('验证一直失败并超出最大迭代次数 → completed: false，且生成失败报告', async () => {
    vi.mocked(executeLLMRound).mockResolvedValue(roundResult())
    vi.mocked(llmVerifier.verify).mockResolvedValue({
      passed: false,
      summary: '未达成',
      issues: [],
    })

    const controller = new IterationController({ maxIterations: 1 })
    const result = await controller.run(buildParams() as any)

    expect(result.completed).toBe(false)
    // 应生成失败报告消息
    const hasReport = result.messages.some(
      (m) =>
        m.role === 'assistant' &&
        typeof m.content === 'string' &&
        m.content.includes('【迭代结束报告】'),
    )
    expect(hasReport).toBe(true)
  })

  it('被暂停 → completed: false', async () => {
    vi.mocked(executeLLMRound).mockResolvedValue({
      ...roundResult(),
      paused: true,
    })

    const controller = new IterationController({ maxIterations: 2 })
    const result = await controller.run(buildParams() as any)

    expect(result.completed).toBe(false)
  })
})
