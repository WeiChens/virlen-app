/**
 * compress-context 测试 — 上下文压缩
 *
 * 覆盖场景：
 * - 没有可压缩的消息时抛异常
 * - 未配置 Provider 时抛异常
 * - Provider 未注册时抛异常
 * - API 返回 usage 时优先使用真实 Token 用量
 * - API 未返回 usage 时使用兜底估算
 * - 多次 summary 消息时从最后一条开始压缩
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { compressContext } from '@/domain/engine/compress-context'
import type { Session, Message } from '@/types'

// Mock — 使用 vi.hoisted 避免变量提升问题
const { mockGet, mockChat } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockChat: vi.fn(),
}))

vi.mock('@/domain/provider', () => ({
  providerPort: {
    get: mockGet,
    ensureProvider: vi.fn(),
  },
}))

vi.mock('@/domain/tools', () => ({
  toolRegistry: {
    listDefinitions: vi.fn(() => Promise.resolve([
      { name: 'read_file', description: 'Read a file', parameters: {} },
      { name: 'write_file', description: 'Write a file', parameters: {} },
    ])),
  },
}))

vi.mock('@/domain/agent', () => ({
  AI_AGEMT_COMPRESS_CONTEXT_PROMPT: '请对以上对话进行摘要总结',
}))

vi.mock('@/utils/uuid', () => ({
  v4: () => `mock-uuid-${Date.now()}`,
}))

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random()}`,
    role: 'user',
    content: '测试消息',
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: '测试',
    messages: [],
    providerConfigId: 'provider-1',
    modelId: 'gpt-4',
    systemPrompt: '你是一个助手',
    params: { temperature: 0.7, topP: 1, maxTokens: 2048, stream: true },
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    tags: [],
    ...overrides,
  }
}

describe('compressContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('没有可压缩的消息时应抛异常', async () => {
    const session = makeSession()
    await expect(compressContext(session, [])).rejects.toThrow('没有可压缩的消息')
  })

  it('只有一条消息时应抛异常', async () => {
    const session = makeSession()
    await expect(compressContext(session, [makeMessage()])).rejects.toThrow(
      '没有可压缩的消息',
    )
  })

  it('未配置模型和 Provider 时应抛异常', async () => {
    const session = makeSession({ modelId: '', providerConfigId: '' })
    await expect(
      compressContext(session, [makeMessage(), makeMessage()]),
    ).rejects.toThrow('未配置模型或 Provider')
  })

  it('Provider 未注册时应抛异常', async () => {
    mockGet.mockResolvedValue(null)
    const session = makeSession()
    await expect(
      compressContext(session, [makeMessage(), makeMessage()]),
    ).rejects.toThrow('未注册')
  })

  it('API 返回 usage 时应使用真实 Token 用量', async () => {
    mockChat.mockResolvedValue({
      content: '这是摘要内容',
      usage: {
        promptTokens: 150,
        completionTokens: 30,
        totalTokens: 180,
      },
    })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    const result = await compressContext(session, [
      makeMessage({ role: 'user', content: '你好' }),
      makeMessage({ role: 'assistant', content: '你好！' }),
    ])

    expect(result.summary).toBe('这是摘要内容')
    expect(result.messages).toHaveLength(3) // 原2条 + 1条 summary

    const summaryMsg = result.messages[2]
    expect(summaryMsg.role).toBe('summary')
    expect(summaryMsg.usage).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      totalTokens: 180,
    })
  })

  it('API 未返回 usage 时应使用兜底估算', async () => {
    mockChat.mockResolvedValue({
      content: '这是摘要内容 summary',
      // 没有 usage
    })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    const result = await compressContext(session, [
      makeMessage({ role: 'user', content: '用户的第一条消息' }),
      makeMessage({ role: 'assistant', content: '助手的回复' }),
    ])

    expect(result.summary).toBe('这是摘要内容 summary')
    const summaryMsg = result.messages[2]
    expect(summaryMsg.usage).toBeDefined()
    // 兜底估算：字符数/4
    expect(summaryMsg.usage!.promptTokens).toBeGreaterThan(0)
    expect(summaryMsg.usage!.completionTokens).toBeGreaterThan(0)
    expect(summaryMsg.usage!.totalTokens).toBe(
      summaryMsg.usage!.promptTokens + summaryMsg.usage!.completionTokens,
    )
  })

  it('有 summary 消息时应从最后一条 summary 开始压缩', async () => {
    mockChat.mockResolvedValue({
      content: '新的摘要',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    const result = await compressContext(session, [
      makeMessage({ role: 'user', content: '旧消息1' }),
      makeMessage({ role: 'assistant', content: '旧回复1' }),
      makeMessage({ role: 'summary', content: '旧摘要', id: 'summary-1' }),
      makeMessage({ role: 'user', content: '新消息' }),
      makeMessage({ role: 'assistant', content: '新回复' }),
    ])

    // 应压缩从 summary-1 之后的消息（不包括 summary-1 本身）
    expect(mockChat).toHaveBeenCalledTimes(1)
    const callArgs = mockChat.mock.calls[0][0]
    // request.messages 应包含 summary 消息在内
    const msgs = callArgs.messages
    expect(msgs.some((m: any) => m.id === 'summary-1')).toBe(true)
    expect(msgs.some((m: any) => m.content.includes('新消息'))).toBe(true)
  })

  it('Provider.chat 抛异常时应透传', async () => {
    mockChat.mockRejectedValue(new Error('API 调用失败'))
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    await expect(
      compressContext(session, [makeMessage(), makeMessage()]),
    ).rejects.toThrow('API 调用失败')
  })
})
