/**
 * export-service 测试 — 会话导出为 Markdown
 *
 * 覆盖场景：
 * - 空会话导出
 * - 普通文本消息导出
 * - 带 tool_calls 的 assistant 消息
 * - tool_result 消息
 * - reasoning_content 思考过程
 * - 图片消息
 * - summary 消息
 * - omitToolCalls / omitThinking 选项
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { sessionToMarkdown } from '@/services/export-service'
import type { Session, Message } from '@/types'

// Mock i18n
vi.mock('@/ui/i18n', () => ({
  t: (key: string) => key,
  tpl: (template: string, data: Record<string, any>) => {
    let result = template
    for (const [key, value] of Object.entries(data)) {
      result = result.replace(`$__${key}__`, String(value))
    }
    return result
  },
  getCurrentLanguage: () => 'zh-CN',
}))

// Mock agentRepo
vi.mock('@/infrastructure/agentRepo', () => ({
  agentRepo: {
    load: () => ({ agents: [] as any[] }),
  },
}))

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: '测试会话',
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

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    role: 'user',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('sessionToMarkdown', () => {
  it('空会话应生成包含头部和分隔线的文档', () => {
    const session = makeSession({ messages: [] })
    const md = sessionToMarkdown(session)

    expect(md).toContain('# 测试会话')
    expect(md).toContain('gpt-4')
    expect(md).toContain('消息数：0')
  })

  it('用户和 assistant 的普通文本应正确导出', () => {
    const session = makeSession({
      messages: [
        makeMessage({ role: 'user', content: '你好' }),
        makeMessage({ role: 'assistant', content: '你好！有什么可以帮你的？' }),
      ],
    })
    const md = sessionToMarkdown(session)

    expect(md).toContain('👤 User')
    expect(md).toContain('你好')
    expect(md).toContain('🤖 Assistant')
    expect(md).toContain('你好！有什么可以帮你的？')
  })

  it('带 tool_calls 的 assistant 消息应包含工具调用信息', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'assistant',
          content: '让我查一下',
          toolCalls: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'web_search',
              input: { query: '天气' },
            },
          ],
        }),
      ],
    })
    const md = sessionToMarkdown(session)

    expect(md).toContain('工具调用：`web_search`')
    expect(md).toContain('"query"')
    expect(md).toContain('天气')
  })

  it('omitToolCalls=true 应省略工具调用信息', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'assistant',
          content: '让我查一下',
          toolCalls: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'web_search',
              input: { query: '天气' },
            },
          ],
        }),
      ],
    })
    const md = sessionToMarkdown(session, {
      omitToolCalls: true,
      omitThinking: false,
    })

    expect(md).not.toContain('工具调用')
    expect(md).not.toContain('web_search')
  })

  it('tool_result 消息应正确导出', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'tool',
          content: '搜索结果为：晴天，25°C',
          toolCallId: 'call-1',
        }),
      ],
    })
    const md = sessionToMarkdown(session)

    expect(md).toContain('🔧 Tool Call')
    expect(md).toContain('搜索结果为：晴天，25°C')
  })

  it('tool_result 的 isError 应显示错误标记', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'tool',
          content: '执行超时',
          toolCallId: 'call-1',
          isError: true,
        }),
      ],
    })
    const md = sessionToMarkdown(session)

    expect(md).toContain('⚠️ 执行失败')
    expect(md).toContain('执行超时')
  })

  it('reasoningContent 应包含思考过程', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'assistant',
          content: '答案是 42',
          reasoningContent: '让我想想…首先需要计算…',
        }),
      ],
    })
    const md = sessionToMarkdown(session)

    expect(md).toContain('💭 思考过程')
    expect(md).toContain('让我想想')
  })

  it('omitThinking=true 应省略思考过程', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'assistant',
          content: '答案是 42',
          reasoningContent: '让我想想…',
        }),
      ],
    })
    const md = sessionToMarkdown(session, {
      omitToolCalls: false,
      omitThinking: true,
    })

    expect(md).not.toContain('💭 思考过程')
    expect(md).not.toContain('让我想想')
  })

  it('图片消息应包含图片引用', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/img.png' },
            },
          ],
        }),
      ],
    })
    const md = sessionToMarkdown(session)

    expect(md).toContain('![图片](https://example.com/img.png)')
    expect(md).toContain('看这张图')
  })

  it('summary 消息应正确导出', () => {
    const session = makeSession({
      messages: [
        makeMessage({
          role: 'summary',
          content: '用户询问了关于天气的问题，助手查询了天气预报',
        }),
      ],
    })
    const md = sessionToMarkdown(session)

    expect(md).toContain('📋')
    expect(md).toContain('上下文摘要')
    expect(md).toContain('天气')
  })
})
