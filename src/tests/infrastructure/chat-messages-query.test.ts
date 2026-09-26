/**
 * 「消息查询」工具（chat 分类）单元测试
 *
 * 覆盖：
 * - common.ts 的纯函数（输出上限、单会话字符预算、格式化形状）
 * - list_messages / read_messages 执行器的各类状态分支
 *   （未压缩 / 无可查询 / 未找到 / 已在上下文 / 成功 / 预算超限）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock 会被提升到文件顶部，故 mock 的 fn 必须用 vi.hoisted 声明
const { getMessageTimeline, getMessageWindow } = vi.hoisted(() => ({
  getMessageTimeline: vi.fn(),
  getMessageWindow: vi.fn(),
}))

vi.mock('@/infrastructure/sessionRepo', () => ({
  sessionRepo: { getMessageTimeline, getMessageWindow },
}))

import { toolRegistry } from '@/domain/tools'
import type { ToolContext } from '@/domain/tools/types'
import type {
  MessageTimelinePage,
  MessageWindow,
} from '@/infrastructure/sessionRepo'
import {
  BUDGET_MAX_CHARS,
  CALL_OUTPUT_MAX_CHARS,
  capOutput,
  consumeBudget,
  formatTimeline,
  formatWindow,
  resetBudget,
} from '@/infrastructure/tools/chat/common'
// 触发两个工具的注册副作用
import '@/infrastructure/tools/chat'

function ctx(sessionId = 's1'): ToolContext {
  return {
    sessionId,
    toolCallId: 'tc1',
    abortSignal: new AbortController().signal,
    write: () => {},
  }
}

async function run(name: string, args: any, sessionId = 's1') {
  const tool = await toolRegistry.get(name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return (await tool.executor(args, ctx(sessionId))) as {
    content: string
    uiData?: Record<string, any>
  }
}

function timelinePage(over: Partial<MessageTimelinePage> = {}): MessageTimelinePage {
  return {
    items: [
      {
        seq: 7,
        id: 'id-7',
        role: 'user',
        timestamp: 1_700_000_000_000,
        preview: '旧消息 7',
        toolNames: [],
      },
      {
        seq: 8,
        id: 'id-8',
        role: 'assistant',
        timestamp: 1_700_000_001_000,
        preview: '旧回复 8',
        toolNames: ['read_file'],
      },
    ],
    hasMore: true,
    nextCursor: 7,
    total: 12,
    boundarySeq: 11,
    ...over,
  }
}

function messageWindow(over: Partial<MessageWindow> = {}): MessageWindow {
  return {
    anchorFound: true,
    anchorSeq: 5,
    startSeq: 4,
    endSeq: 6,
    total: 12,
    boundarySeq: 11,
    clampedByBoundary: false,
    messages: [
      {
        seq: 4,
        id: 'id-4',
        role: 'user',
        timestamp: 1_700_000_000_000,
        text: '用户提问',
        textTruncated: false,
        hasAttachments: false,
        toolCalls: [],
        toolCallId: null,
        isError: null,
        hasReasoning: false,
      },
      {
        seq: 5,
        id: 'id-5',
        role: 'assistant',
        timestamp: 1_700_000_001_000,
        text: '助手回复',
        textTruncated: false,
        hasAttachments: false,
        toolCalls: [
          { name: 'read_file', inputBrief: '{"path":"a.txt"}', inputTruncated: false },
        ],
        toolCallId: null,
        isError: null,
        hasReasoning: true,
      },
    ],
    ...over,
  }
}

beforeEach(() => {
  getMessageTimeline.mockReset()
  getMessageWindow.mockReset()
  resetBudget()
})

describe('chat/common 纯函数', () => {
  it('capOutput：未超限时原样返回', () => {
    const r = capOutput('hello')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('hello')
  })

  it('capOutput：超限时截断并附提示', () => {
    const long = 'a'.repeat(CALL_OUTPUT_MAX_CHARS + 10)
    const r = capOutput(long)
    expect(r.truncated).toBe(true)
    // 保留前 CALL_OUTPUT_MAX_CHARS 个字符，再附截断提示
    expect(r.text.startsWith('a'.repeat(CALL_OUTPUT_MAX_CHARS))).toBe(true)
    expect(r.text).toContain('output truncated')
  })

  it('consumeBudget：窗口内累计超限后拒绝，重置后恢复', () => {
    resetBudget()
    expect(consumeBudget('s1', BUDGET_MAX_CHARS)).toBe(true)
    expect(consumeBudget('s1', 1)).toBe(false)
    // 预算按会话隔离
    expect(consumeBudget('s2', 1)).toBe(true)
    resetBudget()
    expect(consumeBudget('s1', 1)).toBe(true)
  })

  it('formatTimeline：含可查询区间、id、翻页提示', () => {
    const text = formatTimeline(timelinePage())
    expect(text).toContain('#1..#10')
    expect(text).toContain('id: id-7')
    expect(text).toContain('tools(read_file)')
    expect(text).toContain('cursor=7')
  })

  it('formatWindow：含时序、id、工具摘要与「思考已省略」', () => {
    const text = formatWindow(messageWindow())
    expect(text).toContain('#4..#6')
    expect(text).toContain('(id: id-5)')
    expect(text).toContain('tool: read_file')
    expect(text).toContain('deep-thinking present, omitted')
  })
})

describe('list_messages', () => {
  it('未压缩：不返回任何历史', async () => {
    getMessageTimeline.mockResolvedValue(
      timelinePage({ boundarySeq: null, items: [] }),
    )
    const r = await run('list_messages', {})
    expect(r.content).toContain('has not been compressed')
    expect(r.uiData?.status).toBe('not_compressed')
  })

  it('成功：返回时序 + id，并带上条数', async () => {
    getMessageTimeline.mockResolvedValue(timelinePage())
    const r = await run('list_messages', { limit: 2 })
    expect(r.content).toContain('id: id-8')
    expect(r.uiData?.status).toBe('success')
    expect(r.uiData?.items).toHaveLength(2)
    expect(getMessageTimeline).toHaveBeenCalledWith('s1', {
      keyword: undefined,
      beforeSeq: undefined,
      limit: 2,
    })
  })

  it('limit 收敛到上限 50', async () => {
    getMessageTimeline.mockResolvedValue(timelinePage())
    await run('list_messages', { limit: 9999 })
    expect(getMessageTimeline.mock.calls[0][1].limit).toBe(50)
  })

  it('环境不可用（repo 返回 null）时给出明确提示', async () => {
    getMessageTimeline.mockResolvedValue(null)
    const r = await run('list_messages', {})
    expect(r.content).toContain('unavailable')
  })

  it('预算耗尽：拒绝并提示停止查询', async () => {
    getMessageTimeline.mockResolvedValue(timelinePage())
    consumeBudget('s1', BUDGET_MAX_CHARS)
    const r = await run('list_messages', {})
    expect(r.content).toContain('budget exceeded')
  })
})

describe('read_messages', () => {
  it('未压缩：不返回任何历史', async () => {
    getMessageWindow.mockResolvedValue(
      messageWindow({ boundarySeq: null, messages: [] }),
    )
    const r = await run('read_messages', { message_id: 'x' })
    expect(r.content).toContain('has not been compressed')
  })

  it('锚点不存在：提示改用 list_messages', async () => {
    getMessageWindow.mockResolvedValue(
      messageWindow({ anchorFound: false, messages: [] }),
    )
    const r = await run('read_messages', { message_id: 'nope' })
    expect(r.content).toContain('was not found')
    expect(r.content).toContain('list_messages')
  })

  it('锚点已在上下文：提示无需读取', async () => {
    getMessageWindow.mockResolvedValue(
      messageWindow({ messages: [], anchorSeq: 11 }),
    )
    const r = await run('read_messages', { message_id: 'sum' })
    expect(r.content).toContain('already in your current context')
    expect(r.uiData?.status).toBe('in_context')
  })

  it('窗口越界：window 透传给 repo 的 before/after 被收敛', async () => {
    getMessageWindow.mockResolvedValue(messageWindow())
    await run('read_messages', { message_id: 'id-5', window: [-100, 100] })
    const opts = getMessageWindow.mock.calls[0][1]
    expect(opts.before).toBe(20)
    expect(opts.after).toBe(20)
  })

  it('非法 window：回退默认 [-5,5]', async () => {
    getMessageWindow.mockResolvedValue(messageWindow())
    await run('read_messages', { message_id: 'id-5', window: [5, -5] })
    const opts = getMessageWindow.mock.calls[0][1]
    expect(opts.before).toBe(5)
    expect(opts.after).toBe(5)
  })

  it('成功：返回正文与工具摘要，且不含深度思考内容', async () => {
    getMessageWindow.mockResolvedValue(messageWindow())
    const r = await run('read_messages', { message_id: 'id-5', window: [-5, 5] })
    expect(r.content).toContain('用户提问')
    expect(r.content).toContain('助手回复')
    expect(r.content).toContain('tool: read_file')
    expect(r.uiData?.status).toBe('success')
  })
})
