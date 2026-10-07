/**
 * 工具组**行模型**的纯函数用例（`message-list/rows.ts`）。
 *
 * 为什么守这一层：折叠态按「行」记账，「哪些消息合成一行 / 哪些不占行 / 空正文是否打断工具段」
 * 全在这里决定 —— 组件只负责摆 HTML，而这几个判据错了会导致「有内容的行被丢掉」或
 * 「Air 空行占着位置」，都不是 DOM 阶段才暴露的。
 */
import { describe, expect, it } from 'vitest'
import type { Message, ToolUseContent } from '@/types'
import {
  buildRowIndexMap,
  buildRows,
  isToolCallMessage,
  toolGroupView,
  TOOL_GROUP_PREFIX,
} from '@/ui/pages/chat/components/message/message-list/rows'

const tc = (id: string, name = 'read_file'): ToolUseContent => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})

const assistant = (
  id: string,
  toolCalls: ToolUseContent[] | undefined,
  content: Message['content'] = '',
): Message => ({ id, role: 'assistant', content, toolCalls, timestamp: 0 })

const user = (id: string, text: string): Message => ({
  id,
  role: 'user',
  content: text,
  timestamp: 0,
})

const toolResult = (id: string, toolCallId: string, text: string): Message => ({
  id,
  role: 'tool',
  content: text,
  toolCallId,
  timestamp: 0,
})

describe('isToolCallMessage（是否属于工具调用段）', () => {
  it('带 toolCalls（不论有无正文 / 空白正文）→ true', () => {
    expect(isToolCallMessage(assistant('a', [tc('t1')]))).toBe(true)
    expect(isToolCallMessage(assistant('a', [tc('t1')], '   '))).toBe(true)
    // 宿主 assistant 的过渡正文：不再让它出局（否则卡片会与组断成两截）
    expect(isToolCallMessage(assistant('a', [tc('t1')], '先看这里'))).toBe(true)
  })

  it('无工具调用 / 非 assistant → false', () => {
    expect(isToolCallMessage(assistant('a', []))).toBe(false)
    expect(isToolCallMessage(assistant('a', undefined))).toBe(false)
    // 无工具调用的最终回答：段的边界，不并入
    expect(isToolCallMessage(assistant('a', undefined, '看完了。'))).toBe(false)
    expect(isToolCallMessage(user('u', ''))).toBe(false)
  })

  it('有引用 / 文件 / 图片 / 技能块时不并入（气泡里另有渲染）', () => {
    const withQuote = assistant('a', [tc('t1')], [
      { type: 'quote', messageId: 'm0', role: 'user', text: 'x' },
    ] as any)
    const withFile = assistant('a', [tc('t1')], [
      { type: 'file', path: 'E:/a.ts' },
    ] as any)
    const withImage = assistant('a', [tc('t1')], [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ] as any)
    const withSkill = assistant('a', [tc('t1')], [
      { type: 'skill', name: 's', content: 'c' },
    ] as any)
    expect(isToolCallMessage(withQuote)).toBe(false)
    expect(isToolCallMessage(withFile)).toBe(false)
    expect(isToolCallMessage(withImage)).toBe(false)
    expect(isToolCallMessage(withSkill)).toBe(false)
  })
})

describe('buildRows', () => {
  it('启用折叠：连续工具调用合成一行，空 assistant 与 tool 结果都不打断', () => {
    const messages = [
      user('u1', '帮我看看'),
      assistant('a1', [tc('t1')]), // 仅工具调用
      toolResult('r1', 't1', 'a\nb'),
      assistant('a2', [tc('t2')]), // 仅工具调用（中间隔了 tool 结果）
      toolResult('r2', 't2', 'c'),
      assistant('a3', [tc('t3')]),
      assistant('a4', undefined, '看完了。'), // 有正文 → 边界
    ]
    const rows = buildRows(messages, true)
    expect(rows.map((r) => r.kind)).toEqual(['one', 'tools', 'one'])
    expect(rows[0]).toEqual({ kind: 'one', key: 'u1', messageIndex: 0 })
    const group = rows[1]
    if (group.kind !== 'tools') throw new Error('第二行应是工具组')
    expect(group.key).toBe(TOOL_GROUP_PREFIX + 'a1')
    expect(group.messageIndexes).toEqual([1, 3, 5])
    expect(rows[2]).toEqual({ kind: 'one', key: 'a4', messageIndex: 6 })
  })

  it('段首 assistant 可带正文；中段一遇正文就收口（正文是边界）', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', [tc('t1')], '先读一下。'), // 段首带正文 → 允许
      toolResult('r1', 't1', 'x'),
      assistant('a2', [tc('t2')]), // 无正文 → 续段
      toolResult('r2', 't2', 'y'),
      assistant('a3', [tc('t3')], '再看这里。'), // 中段带正文 → 收口，另起一段
      toolResult('r3', 't3', 'z'),
      assistant('a4', [tc('t4')]), // 新段的无正文成员
      assistant('a5', undefined, '看完了。'), // 无工具调用 → 边界
    ]
    const rows = buildRows(messages, true)
    expect(rows.map((r) => r.kind)).toEqual(['one', 'tools', 'tools', 'one'])
    const g1 = rows[1]
    if (g1.kind !== 'tools') throw new Error('第二行应是工具组')
    expect(g1.messageIndexes).toEqual([1, 3])
    const g2 = rows[2]
    if (g2.kind !== 'tools') throw new Error('第三行应是工具组')
    expect(g2.messageIndexes).toEqual([5, 7])
    expect(rows[3]).toEqual({ kind: 'one', key: 'a5', messageIndex: 8 })
  })

  it('只有一条工具调用就不组（保持单卡）', () => {
    const messages = [user('u1', 'hi'), assistant('a1', [tc('t1')])]
    const rows = buildRows(messages, true)
    expect(rows.map((r) => r.kind)).toEqual(['one', 'one'])
    expect(rows[1]).toEqual({ kind: 'one', key: 'a1', messageIndex: 1 })
  })

  it('单条 assistant 里并行多个工具调用也成组', () => {
    const messages = [user('u1', 'hi'), assistant('a1', [tc('t1'), tc('t2')])]
    const rows = buildRows(messages, true)
    expect(rows.map((r) => r.kind)).toEqual(['one', 'tools'])
    expect(rows[1]).toMatchObject({ kind: 'tools', messageIndexes: [1] })
  })

  it('未启用折叠：一条消息一行（含 tool 消息），与改动前一致', () => {
    const messages = [
      user('u1', 'hi'),
      assistant('a1', [tc('t1')]),
      toolResult('r1', 't1', 'out'),
      assistant('a2', [tc('t2')]),
    ]
    const rows = buildRows(messages, false)
    expect(rows).toEqual([
      { kind: 'one', key: 'u1', messageIndex: 0 },
      { kind: 'one', key: 'a1', messageIndex: 1 },
      { kind: 'one', key: 'r1', messageIndex: 2 },
      { kind: 'one', key: 'a2', messageIndex: 3 },
    ])
  })
})

describe('buildRowIndexMap（消息下标 → 行下标）', () => {
  it('组内成员与 tool 结果都映射到组行；未映射向前填充', () => {
    const messages = [
      user('u1', 'hi'), // 0 → row 0
      assistant('a1', [tc('t1')]), // 1 → row 1（组）
      toolResult('r1', 't1', 'a\nb'), // 2 → row 1（向前填充到宿主）
      assistant('a2', [tc('t2')]), // 3 → row 1
      toolResult('r2', 't2', 'c'), // 4 → row 1
      assistant('a3', undefined, 'done'), // 5 → row 2
    ]
    const rows = buildRows(messages, true)
    expect(buildRowIndexMap(messages, rows)).toEqual([0, 1, 1, 1, 1, 2])
  })
})

describe('toolGroupView（折叠态文案）', () => {
  it('计数 = 组内 toolCalls 总和；工具名去重预览', () => {
    const m1 = assistant('a1', [tc('t1'), tc('t2')])
    const m2 = assistant('a2', [tc('t3')])
    const results = new Map<string, Message | undefined>([
      ['t1', toolResult('r1', 't1', 'a\nb\nc\n')],
      ['t2', toolResult('r2', 't2', '')],
      ['t3', toolResult('r3', 't3', 'x\ny')],
    ])
    const view = toolGroupView([m1, m2], (m) =>
      (m.toolCalls ?? []).map((c) => results.get(c.id)),
    )
    expect(view.label).toBe('3 次工具调用')
    // 三条都是 read_file → 去重成一个预览名，没有多余
    expect(view.tools).toEqual(['read_file'])
    expect(view.moreTools).toBe(0)
    // 结果齐全且都不失败 → done
    expect(view.status).toBe('done')
  })

  it('结果还没回来 → 头部聚合状态 pending（状态点转琥珀）', () => {
    const m = assistant('a1', [tc('t1')])
    const view = toolGroupView([m], () => [undefined])
    expect(view.status).toBe('pending')
  })

  it('工具名去重 + 最多预览 3 个（其余折成 +N）；任一失败 → error', () => {
    const m = assistant('a1', [
      tc('t1', 'a'),
      tc('t2', 'b'),
      tc('t3', 'c'),
      tc('t4', 'd'),
      tc('t5', 'a'), // 重复名不计
    ])
    const results = new Map<string, Message | undefined>([
      ['t1', toolResult('r1', 't1', 'x')],
      ['t2', toolResult('r2', 't2', '')],
      ['t3', { ...toolResult('r3', 't3', ''), isError: true } as Message],
      ['t4', undefined],
      ['t5', undefined],
    ])
    const view = toolGroupView([m], (msg) =>
      (msg.toolCalls ?? []).map((c) => results.get(c.id)),
    )
    expect(view.tools).toEqual(['a', 'b', 'c'])
    expect(view.moreTools).toBe(1) // 'd'
    expect(view.status).toBe('error') // 有失败优先于 pending
  })
})
