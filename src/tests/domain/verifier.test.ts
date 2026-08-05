/**
 * LLMVerifier 取消处理测试 — 回归 #3
 *
 * 覆盖场景：
 * - 验证时应把 abortSignal 透传给 provider.chat
 * - abortSignal 已触发（或抛 AbortError）时，verify 应抛出异常
 *   （旧实现：吞掉所有错误并返回 passed:false，用户取消后仍继续消耗 token 并注入反馈）
 * - 非取消错误仍应返回未通过结果，让迭代循环继续
 */
import { describe, it, expect, vi } from 'vitest'
import { LLMVerifier } from '@/domain/engine/verifier'
import type { IProvider } from '@/infrastructure/provider/types'
import type { Message, Session } from '@/types'

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

function makeProvider(
  chatImpl: (signal?: AbortSignal) => Partial<Message>,
): IProvider {
  const chat = vi.fn(
    async (_req: any, signal?: AbortSignal): Promise<Message> => {
      return chatImpl(signal) as Message
    },
  )
  return {
    name: 'mock',
    chat,
    chatStream: vi.fn(),
    listModels: vi.fn(async () => []),
    buildRequest: vi.fn(),
    validateApiKey: vi.fn(async () => true),
  } as unknown as IProvider
}

describe('LLMVerifier 取消处理', () => {
  it('验证时应把 abortSignal 透传给 provider.chat', async () => {
    const provider = makeProvider(() => ({
      content: JSON.stringify({ passed: true, summary: 'ok', issues: [] }),
    }))
    const controller = new AbortController()
    const verifier = new LLMVerifier()

    const result = await verifier.verify(
      provider,
      session,
      { description: 'goal' },
      [],
      controller.signal,
    )

    expect(provider.chat).toHaveBeenCalledTimes(1)
    const [, signal] = (provider.chat as any).mock.calls[0]
    expect(signal).toBe(controller.signal)
    expect(result.passed).toBe(true)
  })

  it('abortSignal 已触发时应抛出异常，而不是返回未通过结果', async () => {
    const provider = makeProvider(() => {
      const err: any = new Error('The user aborted a request.')
      err.name = 'AbortError'
      throw err
    })
    const controller = new AbortController()
    controller.abort()
    const verifier = new LLMVerifier()

    await expect(
      verifier.verify(
        provider,
        session,
        { description: 'goal' },
        [],
        controller.signal,
      ),
    ).rejects.toThrow()
  })

  it('非取消错误（未触发 abort）仍返回未通过结果', async () => {
    const provider = makeProvider(() => {
      throw new Error('network down')
    })
    const controller = new AbortController()
    const verifier = new LLMVerifier()

    const result = await verifier.verify(
      provider,
      session,
      { description: 'goal' },
      [],
      controller.signal,
    )
    expect(result.passed).toBe(false)
    expect(result.summary).toContain('验证调用失败')
  })
})
