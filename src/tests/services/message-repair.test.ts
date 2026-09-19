/**
 * message-repair 测试 — 悬空 tool_calls 的检测与修复
 *
 * 覆盖场景：
 * - 正常历史（有完整 tool 返回）不被改动，且保持同一引用
 * - 崩溃中断残留（assistant 有 tool_calls 但没有 tool 返回）→ 补「程序中断」占位
 * - 一次多个悬空 tool_call → 按 tool_calls 顺序补入
 * - 部分缺失 → 只补缺失的那条
 * - 返回消息被放错位置（旧数据落库顺序错乱）→ 归位而不是重复补入
 * - 只扫首/尾窗口：窗口外的异常不动（不扫全量历史）
 * - 幂等：修复结果再跑一次无变化
 */
import { describe, it, expect } from 'vitest'
import {
  INTERRUPTED_TOOL_RESULT,
  repairToolCallMessages,
} from '@/services/message-repair'
import type { Message, ToolUseContent } from '@/types'

let seq = 0

function toolUse(id: string, name = 'read_file'): ToolUseContent {
  return { type: 'tool_use', id, name, input: {} }
}

function msg(partial: Partial<Message> & { role: Message['role'] }): Message {
  seq += 1
  return {
    id: `m-${seq}`,
    content: '',
    timestamp: seq,
    ...partial,
  } as Message
}

/** 构造一段「崩溃中断残留」历史：assistant(tool_calls) 之后没有任何 tool 返回 */
function brokenHistory(): Message[] {
  return [
    msg({ role: 'user', content: '帮我读文件' }),
    msg({ role: 'assistant', content: '', toolCalls: [toolUse('call_a')] }),
    msg({ role: 'user', content: '在吗' }),
  ]
}

describe('repairToolCallMessages', () => {
  it('正常历史（tool 返回齐全）不修改，且返回同一引用', () => {
    const messages = [
      msg({ role: 'user', content: 'hi' }),
      msg({ role: 'assistant', content: '', toolCalls: [toolUse('call_a')] }),
      msg({ role: 'tool', content: 'file content', toolCallId: 'call_a' }),
      msg({ role: 'assistant', content: 'done' }),
    ]
    const result = repairToolCallMessages(messages)
    expect(result.messages).toBe(messages)
    expect(result.inserted).toBe(0)
    expect(result.moved).toBe(0)
  })

  it('为空历史时不报错', () => {
    const result = repairToolCallMessages([])
    expect(result.messages).toEqual([])
    expect(result.inserted).toBe(0)
  })

  it('崩溃残留：在 assistant 之后补入「程序中断」占位 tool 消息', () => {
    const messages = brokenHistory()
    const result = repairToolCallMessages(messages)

    expect(result.inserted).toBe(1)
    expect(result.moved).toBe(0)
    expect(result.messages).not.toBe(messages)

    const assistantIdx = 1
    const placeholder = result.messages[assistantIdx + 1]
    expect(placeholder.role).toBe('tool')
    expect(placeholder.toolCallId).toBe('call_a')
    expect(placeholder.content).toBe(INTERRUPTED_TOOL_RESULT)
    expect(placeholder.isError).toBe(true)
    // 占位消息必须紧跟在 assistant 之后、用户新消息之前
    expect(result.messages[assistantIdx + 2].role).toBe('user')
    // 原有消息顺序与内容不变
    expect(result.messages).toHaveLength(messages.length + 1)
  })

  it('一次多个悬空 tool_call：按 tool_calls 顺序补入', () => {
    const messages = [
      msg({ role: 'user', content: 'hi' }),
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [toolUse('call_a'), toolUse('call_b'), toolUse('call_c')],
      }),
    ]
    const result = repairToolCallMessages(messages)

    expect(result.inserted).toBe(3)
    expect(
      result.messages.slice(2).map((m) => m.toolCallId),
    ).toEqual(['call_a', 'call_b', 'call_c'])
  })

  it('部分缺失时只补缺失的那条', () => {
    const messages = [
      msg({ role: 'assistant', content: '', toolCalls: [toolUse('call_a'), toolUse('call_b')] }),
      msg({ role: 'tool', content: 'ok', toolCallId: 'call_a' }),
      msg({ role: 'user', content: 'next' }),
    ]
    const result = repairToolCallMessages(messages)

    expect(result.inserted).toBe(1)
    expect(result.messages[1].toolCallId).toBe('call_a')
    expect(result.messages[2].toolCallId).toBe('call_b')
    expect(result.messages[2].content).toBe(INTERRUPTED_TOOL_RESULT)
    expect(result.messages[3].role).toBe('user')
  })

  it('返回消息位置错乱时归位，不重复补入', () => {
    const messages = [
      msg({ role: 'assistant', content: '', toolCalls: [toolUse('call_a')] }),
      msg({ role: 'user', content: '插在中间的用户消息' }),
      msg({ role: 'tool', content: 'real result', toolCallId: 'call_a' }),
    ]
    const result = repairToolCallMessages(messages)

    expect(result.inserted).toBe(0)
    expect(result.moved).toBe(1)
    expect(result.messages[1].toolCallId).toBe('call_a')
    expect(result.messages[1].content).toBe('real result')
    // 没有产生重复的 toolCallId
    const ids = result.messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.toolCallId)
    expect(ids).toEqual(['call_a'])
  })

  it('只扫首/尾窗口：窗口之外的异常不动', () => {
    const head: Message[] = Array.from({ length: 25 }, (_, i) =>
      msg({ role: 'user', content: `head ${i}` }),
    )
    // 异常位于下标 25：既不在首窗（0..19）也不在尾窗（32..51）
    const broken: Message[] = [
      msg({ role: 'assistant', content: '', toolCalls: [toolUse('call_mid')] }),
      msg({ role: 'user', content: '中间的用户消息' }),
    ]
    const tail: Message[] = Array.from({ length: 25 }, (_, i) =>
      msg({ role: 'user', content: `tail ${i}` }),
    )
    const messages = [...head, ...broken, ...tail]
    const result = repairToolCallMessages(messages)

    expect(result.inserted).toBe(0)
    expect(result.moved).toBe(0)
    // 未改动时返回同一引用，调用方可零成本判断
    expect(result.messages).toBe(messages)
    expect(
      result.messages.some((m) => m.content === INTERRUPTED_TOOL_RESULT),
    ).toBe(false)
  })

  it('首窗兜底：会话第一轮就被中断时也能修复', () => {
    const messages = [
      msg({ role: 'user', content: '第一条消息' }),
      msg({ role: 'assistant', content: '', toolCalls: [toolUse('call_first')] }),
      ...Array.from({ length: 40 }, (_, i) =>
        msg({ role: 'user', content: `later ${i}` }),
      ),
    ]
    const result = repairToolCallMessages(messages)

    expect(result.inserted).toBe(1)
    expect(result.messages[2].toolCallId).toBe('call_first')
  })

  it('窗口大小可配置：window 之外不检测', () => {
    const messages: Message[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        msg({ role: 'user', content: `head ${i}` }),
      ),
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [toolUse('call_x')],
      }),
      ...Array.from({ length: 10 }, (_, i) =>
        msg({ role: 'user', content: `tail ${i}` }),
      ),
    ]
    // 异常在下标 10：window=5 时首/尾窗口都盖不到
    expect(repairToolCallMessages(messages, { window: 5 }).inserted).toBe(0)
    // 默认窗口（20 条）能盖到
    expect(repairToolCallMessages(messages).inserted).toBe(1)
  })

  it('幂等：对修复结果再跑一次无变化', () => {
    const first = repairToolCallMessages(brokenHistory())
    const second = repairToolCallMessages(first.messages)
    expect(second.inserted).toBe(0)
    expect(second.moved).toBe(0)
    expect(second.messages).toBe(first.messages)
  })
})
