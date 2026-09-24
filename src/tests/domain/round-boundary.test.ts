/**
 * 轮次边界注入 — TS 引擎路径回归测试
 *
 * 语义（用户明确要求）：用户在 AI 回复期间「应用」的任务清单变更，
 * **不能**等整个 agent 循环（工具调用 → 思考 → …）跑完才落地，而要在
 * 「上一批工具已回复、下一次 LLM 请求尚未发出」这个窗口注入消息列表，
 * 这样紧接着的那次请求就能看到用户的最新清单。
 *
 * 本文件 mock executeLLMRound（引擎主循环的轮次实现），验证：
 * - 每轮 LLM 请求前都会调用 onRoundBoundary；
 * - 返回的消息被追加进消息列表 → 出现在**下一次**请求的入参里；
 * - 抛错不影响本轮执行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/domain/engine/llm-loop', () => ({
  executeLLMRound: vi.fn(),
}))

vi.mock('@/domain/provider', () => ({
  providerPort: {
    ensureProvider: vi.fn(async () => ({}) as any),
  },
}))

import { AgentEngine } from '@/domain/engine/engine'
import { executeLLMRound } from '@/domain/engine/llm-loop'
import type { Message, Session } from '@/types'

function makeSession(): Session {
  return {
    id: 's-round',
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
  } as unknown as Session
}

function assistantWithToolCall(): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-1', name: 'noop', input: {} },
    ],
    timestamp: 1,
  } as unknown as Message
}

describe('TS 引擎 · 轮次边界注入', () => {
  beforeEach(() => {
    vi.mocked(executeLLMRound).mockReset()
  })

  it('返回的消息会在下一次 LLM 请求前进入消息列表', async () => {
    const injected: Message = {
      id: 'todo-feedback',
      role: 'feedback',
      content: '【用户更新了任务清单】',
      timestamp: 2,
    } as unknown as Message

    // 第 1 轮：有 tool calls（循环继续）；第 2 轮：纯文本（循环结束）
    vi.mocked(executeLLMRound)
      .mockResolvedValueOnce({
        ctx: { assistantMessage: assistantWithToolCall() },
        assistantMessage: assistantWithToolCall(),
        toolResultMessages: [
          { id: 'tr1', role: 'tool', content: 'ok', timestamp: 2 } as Message,
        ],
        paused: false,
      } as any)
      .mockResolvedValueOnce({
        ctx: null,
        assistantMessage: {
          id: 'a2',
          role: 'assistant',
          content: 'done',
          timestamp: 3,
        } as Message,
        toolResultMessages: [],
        paused: false,
      } as any)

    const onRoundBoundary = vi
      .fn()
      // 第 1 次（本轮第一次请求前）通常没有可注入的消息；
      // 第 2 次（工具已回复、下一次请求前）才是「用户已应用的清单变更」
      .mockReturnValueOnce([])
      .mockReturnValue([injected])
    const engine = new AgentEngine()

    await engine.sendMessage({
      session: makeSession(),
      messages: [],
      enableTools: false,
      onEvent: vi.fn(),
      onRoundBoundary,
    })

    // 每轮请求前都会问一次（第一轮通常是空，恢复场景下能提前注入）
    expect(onRoundBoundary).toHaveBeenCalledTimes(2)

    // 关键：第 2 次请求的入参里已经带上了注入的消息（工具结果之后）
    const secondCallMessages = vi.mocked(executeLLMRound).mock.calls[1][0].messages
    expect(secondCallMessages.map((m) => m.id)).toContain('todo-feedback')
    expect(secondCallMessages.map((m) => m.id)).toEqual([
      'a1',
      'tr1',
      'todo-feedback',
    ])
  })

  it('注入钩子抛错不影响本轮执行', async () => {
    vi.mocked(executeLLMRound).mockResolvedValueOnce({
      ctx: null,
      assistantMessage: {
        id: 'a1',
        role: 'assistant',
        content: 'done',
        timestamp: 1,
      } as Message,
      toolResultMessages: [],
      paused: false,
    } as any)

    const onRoundBoundary = vi.fn(async () => {
      throw new Error('boom')
    })
    const onEvent = vi.fn()
    const engine = new AgentEngine()

    await expect(
      engine.sendMessage({
        session: makeSession(),
        messages: [],
        enableTools: false,
        onEvent,
        onRoundBoundary,
      }),
    ).resolves.toBeUndefined()

    // 正常收尾（未被异常打断）
    expect(onEvent).toHaveBeenCalledWith({ type: 'stream_end', data: {} })
  })
})
