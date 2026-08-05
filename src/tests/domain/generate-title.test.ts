/**
 * generate-title 测试 — 会话标题生成
 *
 * 覆盖场景：
 * - 没有用户消息时抛异常
 * - 未配置 Provider 时抛异常
 * - Provider 未注册时抛异常
 * - AI 返回标题时正常返回
 * - AI 返回带引号/装饰符号的标题时清洗
 * - AI 返回超长标题时截断
 * - Provider.chat 抛异常时透传
 * - sanitizeTitle 纯函数边界
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  generateTitle,
  sanitizeTitle,
  MAX_TITLE_LENGTH,
} from '@/domain/engine/generate-title'
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

vi.mock('@/domain/agent', () => ({
  AI_AGENT_GENERATE_TITLE_PROMPT: '请为以上对话生成一个简短标题',
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
    title: '新对话',
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

describe('sanitizeTitle', () => {
  it('去除首尾引号', () => {
    expect(sanitizeTitle('"如何优化 Rust 性能"')).toBe('如何优化 Rust 性能')
    expect(sanitizeTitle('《Rust 性能优化指南》')).toBe('Rust 性能优化指南')
    expect(sanitizeTitle('「会话标题」')).toBe('会话标题')
  })

  it('去除 markdown 标题符号', () => {
    expect(sanitizeTitle('## Rust 性能优化')).toBe('Rust 性能优化')
  })

  it('压缩换行与多余空白', () => {
    expect(sanitizeTitle('Rust\n性能\n优化')).toBe('Rust 性能 优化')
    expect(sanitizeTitle('  Rust   性能优化  ')).toBe('Rust 性能优化')
  })

  it('超长标题截断并追加省略号', () => {
    const long = '字'.repeat(MAX_TITLE_LENGTH + 10)
    const result = sanitizeTitle(long)
    expect(result).toBe('字'.repeat(MAX_TITLE_LENGTH) + '...')
    expect(result.length).toBe(MAX_TITLE_LENGTH + 3)
  })

  it('空字符串返回空', () => {
    expect(sanitizeTitle('')).toBe('')
    expect(sanitizeTitle('   ')).toBe('')
  })
})

describe('generateTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('没有用户消息时应抛异常', async () => {
    const session = makeSession()
    await expect(generateTitle(session, [])).rejects.toThrow('没有用户消息')
    await expect(
      generateTitle(session, [makeMessage({ role: 'assistant' })]),
    ).rejects.toThrow('没有用户消息')
  })

  it('未配置模型和 Provider 时应抛异常', async () => {
    const session = makeSession({ modelId: '', providerConfigId: '' })
    await expect(
      generateTitle(session, [makeMessage()]),
    ).rejects.toThrow('未配置模型或 Provider')
  })

  it('Provider 未注册时应抛异常', async () => {
    mockGet.mockResolvedValue(null)
    const session = makeSession()
    await expect(
      generateTitle(session, [makeMessage()]),
    ).rejects.toThrow('未注册')
  })

  it('AI 返回标题时正常返回', async () => {
    mockChat.mockResolvedValue({ content: 'Rust 性能优化' })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    const title = await generateTitle(session, [
      makeMessage({ role: 'user', content: '帮我优化 Rust 代码性能' }),
    ])
    expect(title).toBe('Rust 性能优化')
  })

  it('AI 返回带引号标题时清洗后返回', async () => {
    mockChat.mockResolvedValue({ content: '"如何优化 Rust 性能"' })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    const title = await generateTitle(session, [
      makeMessage({ role: 'user', content: '帮我优化 Rust 代码性能' }),
    ])
    expect(title).toBe('如何优化 Rust 性能')
  })

  it('AI 返回超长标题时截断', async () => {
    const longTitle = '这是一段非常非常非常非常非常非常非常非常非常非常非常长的标题内容'
    mockChat.mockResolvedValue({ content: longTitle })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    const title = await generateTitle(session, [
      makeMessage({ role: 'user', content: '测试' }),
    ])
    expect(title.length).toBe(MAX_TITLE_LENGTH + 3)
    expect(title.endsWith('...')).toBe(true)
  })

  it('AI 返回空白标题时应抛异常', async () => {
    mockChat.mockResolvedValue({ content: '  \n  ' })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    await expect(
      generateTitle(session, [makeMessage()]),
    ).rejects.toThrow('AI 未生成有效标题')
  })

  it('附带首条 assistant 回复作为上下文', async () => {
    mockChat.mockResolvedValue({ content: '标题' })
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    await generateTitle(session, [
      makeMessage({ role: 'user', content: '第一条用户消息' }),
      makeMessage({ role: 'assistant', content: '第一条回复' }),
      makeMessage({ role: 'user', content: '第二条用户消息' }),
    ])

    expect(mockChat).toHaveBeenCalledTimes(1)
    const req = mockChat.mock.calls[0][0]
    // 上下文应包含首条用户消息与首条 assistant 回复，但不包含第二条用户消息
    expect(req.messages.some((m: any) => m.content === '第一条用户消息')).toBe(true)
    expect(req.messages.some((m: any) => m.content === '第一条回复')).toBe(true)
    expect(req.messages.some((m: any) => m.content === '第二条用户消息')).toBe(false)
    // 最后一条是标题生成指令
    expect(req.messages[req.messages.length - 1].content).toContain('简短标题')
    // 非流式、不启用工具
    expect(req.stream).toBe(false)
    expect(req.tool_choice).toBe('none')
    // 标题生成必须禁用思考模式，避免 maxTokens 被 reasoning 消耗
    expect(req.thinking).toBe(false)
  })

  it('Provider.chat 抛异常时应透传', async () => {
    mockChat.mockRejectedValue(new Error('API 调用失败'))
    mockGet.mockResolvedValue({ chat: mockChat })

    const session = makeSession()
    await expect(
      generateTitle(session, [makeMessage()]),
    ).rejects.toThrow('API 调用失败')
  })
})
