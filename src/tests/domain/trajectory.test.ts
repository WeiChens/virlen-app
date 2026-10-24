/**
 * 轨迹投影层单测：只测「消息 → 轮次/组/行」的规则，不碰 React。
 */
import { describe, expect, it } from 'vitest'
import type { Message, MessageRole } from '@/types'
import {
  buildTimeline,
  buildTrajectory,
  flattenTrajectory,
  hasTimelineTime,
  requestStatsFromTotals,
  searchRecords,
  summarizeTrajectory,
  timelineFocusIndexes,
  turnSummary,
} from '@/domain/trajectory'

/** 构造一条最小消息（只填测试关心的字段） */
function msg(
  id: string,
  role: MessageRole,
  patch: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    content: '',
    timestamp: 1_000,
    ...patch,
  }
}

const T0 = 1_700_000_000_000

describe('buildTrajectory 结构', () => {
  it('system + 用户 + 助手 + 工具 → 轮/步/行', () => {
    const turns = buildTrajectory({
      systemPrompt: '你是助手',
      messages: [
        msg('u1', 'user', { content: '你好', timestamp: T0 }),
        msg('a1', 'assistant', {
          content: '我来看看',
          timestamp: T0 + 100,
          toolCalls: [
            { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
          ],
        }),
        msg('t1', 'tool', {
          content: 'file body',
          toolCallId: 'c1',
          timestamp: T0 + 600,
          elapsedMs: 200,
        }),
      ],
    })

    // 会话开始（系统提示词）+ 第 1 轮
    expect(turns).toHaveLength(2)
    expect(turns[0].title).toEqual({ kind: 'start' })
    expect(turns[0].groups[0].records).toHaveLength(1)
    expect(turns[0].groups[0].records[0]).toMatchObject({
      kind: 'system',
      index: 1,
      systemPrompt: '你是助手',
    })

    const turn = turns[1]
    expect(turn.title).toEqual({ kind: 'turn', turn: 1 })
    expect(turn.groups.map((g) => g.title)).toEqual([
      { kind: 'message' },
      { kind: 'step', step: 1 },
    ])
    const records = turn.groups.flatMap((g) => g.records)
    expect(records.map((r) => r.kind)).toEqual(['user', 'message', 'tool'])
    expect(records.map((r) => r.index)).toEqual([2, 3, 4])
  })

  it('每条用户消息开一轮，轮内每个助手消息是一步', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '第一问' }),
        msg('a1', 'assistant', { content: '答一' }),
        msg('a2', 'assistant', { content: '再补一句' }),
        msg('u2', 'user', { content: '第二问' }),
        msg('a3', 'assistant', { content: '答二' }),
      ],
    })
    expect(turns.map((t) => t.title)).toEqual([
      { kind: 'turn', turn: 1 },
      { kind: 'turn', turn: 2 },
    ])
    expect(turns[0].groups.map((g) => g.title)).toEqual([
      { kind: 'message' },
      { kind: 'step', step: 1 },
      { kind: 'step', step: 2 },
    ])
    expect(turns[1].groups.map((g) => g.title)).toEqual([
      { kind: 'message' },
      { kind: 'step', step: 1 },
    ])
  })

  it('窗口从助手消息开始（历史被分页截断）→ 落到「会话开始」section', () => {
    const turns = buildTrajectory({
      messages: [
        msg('a1', 'assistant', { content: '半截回答' }),
        msg('u1', 'user', { content: '下一问' }),
      ],
    })
    expect(turns[0].title).toEqual({ kind: 'start' })
    expect(turns[0].groups[0].title).toEqual({ kind: 'step', step: 1 })
    expect(turns[1].title).toEqual({ kind: 'turn', turn: 1 })
  })

  it('空会话不产生「系统提示词」孤行', () => {
    expect(buildTrajectory({ systemPrompt: '你是助手', messages: [] })).toEqual([])
  })

  it('压缩摘要单独立段，不打断当前轮', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '第一问' }),
        msg('s1', 'summary', {
          content: '这是摘要',
          uiData: { contextTokens: 1234 },
        }),
        msg('a1', 'assistant', { content: '答一' }),
      ],
    })
    expect(turns.map((t) => t.title)).toEqual([
      { kind: 'turn', turn: 1 },
      { kind: 'compaction', index: 1 },
    ])
    const compaction = turns[1].groups[0].records[0]
    expect(compaction.kind).toBe('compacted')
    expect(compaction.contextTokens).toBe(1234)
    // 压缩段之后仍然回到第 1 轮的步组
    expect(turns[0].groups.map((g) => g.title)).toEqual([
      { kind: 'message' },
      { kind: 'step', step: 1 },
    ])
  })

  it('feedback 消息落成 context 行，并带出注入类型', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '第一问' }),
        msg('f1', 'feedback', {
          content: '清单内容',
          uiData: { type: 'todo', todos: [], changes: [] },
        }),
        msg('f2', 'feedback', {
          content: 'service exited',
          uiData: { type: 'service', name: 'vite' },
        }),
      ],
    })
    const records = turns[0].groups[0].records
    expect(records.map((r) => r.kind)).toEqual(['user', 'context', 'context'])
    expect(records[1].noteKind).toBe('todo')
    expect(records[2]).toMatchObject({ noteKind: 'service', noteName: 'vite' })
  })

  it('窗口里没有宿主的工具结果单独成行（不丢数据）', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '第一问' }),
        msg('t9', 'tool', {
          content: '孤立结果',
          toolCallId: 'missing',
          timestamp: T0 + 500,
          elapsedMs: 100,
        }),
      ],
    })
    const record = turns[0].groups[0].records[1]
    expect(record).toMatchObject({
      kind: 'tool',
      messageId: 't9',
      resultText: '孤立结果',
      durationMs: 100,
      startedAt: T0 + 400,
    })
  })
})

describe('buildTrajectory 耗时与状态', () => {
  it('助手行耗时 = 请求 → 最早工具开跑', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '跑一下' }),
        msg('a1', 'assistant', {
          content: '',
          timestamp: T0,
          toolCalls: [
            { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
            { type: 'tool_use', id: 'c2', name: 'read_file', input: {} },
          ],
        }),
        // c1: 结果结束于 T0+1200，耗时 200 → 开始 T0+1000
        msg('t1', 'tool', { toolCallId: 'c1', timestamp: T0 + 1200, elapsedMs: 200 }),
        // c2: 结果结束于 T0+1500，耗时 500 → 开始 T0+1000（与 c1 同时开跑，取最早不影响）
        msg('t2', 'tool', { toolCallId: 'c2', timestamp: T0 + 1500, elapsedMs: 500 }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    expect(assistant.kind).toBe('message')
    expect(assistant.durationMs).toBe(1000)
    expect(assistant.startedAt).toBe(T0)

    const [tool1, tool2] = turns[0].groups[1].records.slice(1)
    expect(tool1).toMatchObject({ durationMs: 200, startedAt: T0 + 1000 })
    expect(tool2).toMatchObject({ durationMs: 500, startedAt: T0 + 1000 })
  })

  it('没有工具调用的助手行不编造耗时', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '你好' }),
        msg('a1', 'assistant', { content: '你好呀', timestamp: T0 + 10 }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    expect(assistant.durationMs).toBeNull()
    expect(assistant.startedAt).toBe(T0 + 10)
  })

  it('进行中的助手 / 工具不给耗时', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', {
          content: '写一半',
          streaming: true,
          uiData: { pending: true },
          timestamp: T0,
          toolCalls: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: {} }],
        }),
      ],
    })
    const [assistant, tool] = turns[0].groups[1].records
    expect(assistant).toMatchObject({ running: true, durationMs: null })
    expect(tool).toMatchObject({ running: true, durationMs: null })
    expect(tool.result).toBeUndefined()
  })

  it('崩溃中断标成失败；工具失败沿用 isError', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', {
          content: '半句话',
          uiData: { interrupted: true },
          timestamp: T0,
          toolCalls: [{ type: 'tool_use', id: 'c1', name: 'run', input: {} }],
        }),
        msg('t1', 'tool', {
          toolCallId: 'c1',
          content: 'boom',
          isError: true,
          timestamp: T0 + 100,
          elapsedMs: 50,
        }),
      ],
    })
    const [assistant, tool] = turns[0].groups[1].records
    expect(assistant.isError).toBe(true)
    expect(tool.isError).toBe(true)
    expect(tool.resultText).toBe('boom')
  })

  it('token 与思考耗时透传，并在轮内合计', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', {
          content: '答',
          timestamp: T0,
          reasoningElapsedMs: 800,
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            cachedTokens: 30,
          },
          toolCalls: [{ type: 'tool_use', id: 'c1', name: 'run', input: {} }],
        }),
        msg('t1', 'tool', {
          toolCallId: 'c1',
          content: 'ok',
          timestamp: T0 + 1000,
          elapsedMs: 500,
        }),
        msg('a2', 'assistant', {
          content: '完',
          timestamp: T0 + 1100,
          usage: { promptTokens: 130, completionTokens: 5, totalTokens: 135 },
        }),
      ],
    })
    const [assistant1, tool, assistant2] = [
      ...turns[0].groups[1].records,
      ...turns[0].groups[2].records,
    ]
    expect(assistant1).toMatchObject({
      thinkingMs: 800,
      input: 100,
      output: 20,
      cached: 30,
    })
    expect(assistant2).toMatchObject({ input: 130, output: 5 })
    expect(tool.durationMs).toBe(500)
    // 轮内合计：100+130 输入、20+5 输出；已知耗时 = 助手 500 + 工具 500
    expect(turns[0].input).toBe(230)
    expect(turns[0].output).toBe(25)
    expect(turns[0].knownMs).toBe(1000)
  })
})

describe('附件与占位', () => {
  it('用户消息带附件计数，正文空时给空原因', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', {
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
            { type: 'file', path: 'C:/a.ts', name: 'a.ts' },
            { type: 'quote', messageId: 'm0', role: 'assistant', text: '引用' },
          ],
        }),
      ],
    })
    const user = turns[0].groups[0].records[0]
    expect(user.text).toBe('看图')
    expect(user.attachments).toEqual({ images: 1, files: 1, quotes: 1, skills: 0 })

    const onlyAttachment = buildTrajectory({
      messages: [
        msg('u2', 'user', {
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
        }),
      ],
    })
    expect(onlyAttachment[0].groups[0].records[0]).toMatchObject({
      text: '',
      emptyReason: 'noContent',
      attachments: { images: 1, files: 0, quotes: 0, skills: 0 },
    })
  })

  it('只有工具调用的助手行给 toolCallOnly 占位', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', {
          content: '',
          timestamp: T0,
          toolCalls: [{ type: 'tool_use', id: 'c1', name: 'run', input: {} }],
        }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    expect(assistant.emptyReason).toBe('toolCallOnly')
  })

  it('工具行文本 = 工具名 + 参数 JSON 摘要', () => {
    const turns = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', {
          content: '',
          timestamp: T0,
          toolCalls: [
            { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/a.ts' } },
          ],
        }),
      ],
    })
    const tool = turns[0].groups[1].records[1]
    expect(tool.text).toBe('read_file {"path":"src/a.ts"}')
    expect(tool.toolName).toBe('read_file')
    expect(tool.callId).toBe('c1')
  })
})

describe('flattenTrajectory 扁平行', () => {
  const turns = buildTrajectory({
    messages: [
      msg('u1', 'user', { content: '第一问' }),
      msg('a1', 'assistant', {
        content: '答一',
        timestamp: T0,
        toolCalls: [{ type: 'tool_use', id: 'c1', name: 'run', input: {} }],
      }),
      msg('t1', 'tool', { toolCallId: 'c1', content: 'ok', timestamp: T0 + 10, elapsedMs: 10 }),
      msg('u2', 'user', { content: '第二问' }),
    ],
  })

  it('轮头 + 组头 + 记录行按顺序摊开，行号可回查', () => {
    const { rows, recordRowIndex } = flattenTrajectory(turns, {
      collapsedTurns: new Set(),
    })
    expect(rows.map((r) => r.kind)).toEqual([
      'turn',
      'group',
      'record',
      'group',
      'record',
      'record',
      'turn',
      'group',
      'record',
    ])
    const records = rows.filter((r) => r.kind === 'record')
    const lastRecord = records[records.length - 1]
    expect(lastRecord).toBeDefined()
    // 最后一条记录（第 2 轮用户消息）在 rows 里的下标
    const index = recordRowIndex.get(
      turns[1].groups[0].records[0].index,
    )
    expect(rows[index!]).toBe(lastRecord)
  })

  it('收起的轮只留轮头', () => {
    const { rows } = flattenTrajectory(turns, {
      collapsedTurns: new Set([turns[0].key]),
    })
    expect(rows.filter((r) => r.kind === 'turn')).toHaveLength(2)
    // 第 1 轮只剩轮头，第 2 轮保留组与记录
    expect(rows.filter((r) => r.kind === 'record')).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'turn', collapsed: true })
    expect(turnSummary(turns[0])).toEqual({ groups: 2, records: 3 })
  })

  it('折叠工具行时行号仍然保留在原记录上（只是不显示）', () => {
    const { rows, recordRowIndex } = flattenTrajectory(turns, {
      collapsedTurns: new Set(),
      hideToolRecords: true,
    })
    expect(rows.filter((r) => r.kind === 'record')).toHaveLength(3)
    const toolRecord = turns[0].groups[1].records[1]
    expect(toolRecord.kind).toBe('tool')
    expect(recordRowIndex.has(toolRecord.index)).toBe(false)
  })
})

describe('概览时间轴', () => {
  const turns = buildTrajectory({
    messages: [
      msg('u1', 'user', { content: '第一问', timestamp: T0 }),
      msg('a1', 'assistant', {
        content: '答',
        timestamp: T0 + 100,
        toolCalls: [{ type: 'tool_use', id: 'c1', name: 'run', input: {} }],
      }),
      msg('t1', 'tool', {
        toolCallId: 'c1',
        content: 'ok',
        timestamp: T0 + 400,
        elapsedMs: 300,
      }),
      msg('u2', 'user', { content: '第二问', timestamp: T0 + 1000 }),
    ],
  })

  it('sequence 模式：每个记录一格，泳道按类型分', () => {
    const model = buildTimeline(turns, 'sequence')
    expect(model).not.toBeNull()
    const total = turns.reduce(
      (n, t) => n + t.groups.reduce((m, g) => m + g.records.length, 0),
      0,
    )
    expect(model!.spans).toHaveLength(total)
    expect(model!.start).toBe(0)
    expect(model!.end).toBe(total)
    // 工具在 lane 2，助手在 lane 1，用户在 lane 0
    expect(model!.spans[0].lane).toBe(0)
    expect(model!.spans[1].lane).toBe(1)
    expect(model!.spans[2].lane).toBe(2)
    // 两轮 → 一条轮次分隔线
    expect(model!.boundaries.map((b) => b.turn)).toEqual([1, 2])
  })

  it('time 模式：按真实开始时刻与耗时投影，未知起点的记录不画', () => {
    const model = buildTimeline(turns, 'time')
    expect(model).not.toBeNull()
    expect(model!.start).toBe(T0)
    const tool = model!.spans.find((s) => s.kind === 'tool')
    expect(tool).toMatchObject({ start: T0 + 100, end: T0 + 400 })
    expect(hasTimelineTime(turns)).toBe(true)
  })

  it('time 模式：零耗时的记录投影成零宽（可见宽度交给视图的像素下限，不按域比例撑宽）', () => {
    const model = buildTimeline(turns, 'time')!
    const user = model.spans.find((s) => s.kind === 'user')
    expect(user).toBeDefined()
    expect(user!.end).toBe(user!.start)
  })

  it('没有任何起点时刻时会话没有 time 模型', () => {
    const unknown = buildTrajectory({
      messages: [{ id: 'u0', role: 'user', content: '没有时间戳', timestamp: 0 }],
    })
    expect(hasTimelineTime(unknown)).toBe(false)
    expect(buildTimeline(unknown, 'time')).toBeNull()
  })

  it('选区命中：闭区间相交即算命中', () => {
    const model = buildTimeline(turns, 'sequence')!
    // 区间取在两个格子的中间，避开「端点正好压在边界上」的歧义
    const focus = timelineFocusIndexes(model, { start: 1.5, end: 2.5 })
    expect(focus).not.toBeNull()
    expect([...focus!].sort((a, b) => a - b)).toEqual(
      model.spans.slice(1, 3).map((s) => s.index),
    )
    expect(timelineFocusIndexes(model, null)).toBeNull()
  })
})

describe('searchRecords', () => {
  const turns = buildTrajectory({
    messages: [
      msg('u1', 'user', { content: '帮我看看 Trajectory 视图' }),
      msg('a1', 'assistant', {
        content: '好的',
        timestamp: T0,
        reasoningContent: '这里提到轨迹这个词',
        toolCalls: [
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'trajectory.ts' } },
        ],
      }),
      msg('t1', 'tool', {
        toolCallId: 'c1',
        content: 'export function buildTrajectory',
        timestamp: T0 + 10,
        elapsedMs: 10,
      }),
    ],
  })

  it('空关键词 = 不过滤', () => {
    expect(searchRecords(turns, '   ')).toBeNull()
  })

  it('命中摘要 / 参数 / 结果正文，大小写不敏感', () => {
    // 用户行（Trajectory）+ 工具行（参数与结果里的 trajectory）
    expect(searchRecords(turns, 'trajectory')?.size).toBe(2)
    expect(searchRecords(turns, 'read_file')?.size).toBe(2) // 助手行的工具名预览 + 工具行
    // 思考内容只在助手行上
    expect(searchRecords(turns, '轨迹')?.size).toBe(1)
    expect(searchRecords(turns, '不存在的词')?.size).toBe(0)
  })
})

describe('请求事实（用量账本）', () => {
  it('账本实测耗时优先，纯文本回复也有真实耗时', () => {
    const turns = buildTrajectory({
      usage: [
        {
          id: 7,
          messageId: 'a1',
          kind: 'chat_round',
          model: 'gpt-4o',
          provider: 'openai',
          round: 1,
          durationMs: 4200,
          traceId: 'tr-1',
        },
      ],
      messages: [
        msg('u1', 'user', { content: '你好', timestamp: T0 }),
        msg('a1', 'assistant', {
          content: '你好呀',
          timestamp: T0 + 10,
          usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    // 没有工具调用也能给出耗时 —— 这是账本最大的价值
    expect(assistant.durationMs).toBe(4200)
    expect(assistant.durationSource).toBe('usage')
    expect(assistant.request).toMatchObject({
      id: 7,
      model: 'gpt-4o',
      provider: 'openai',
      kind: 'chat_round',
      round: 1,
      durationMs: 4200,
      traceId: 'tr-1',
      modelShift: true,
    })
    // 200 tok / 4.2s → 48 tok/s
    expect(assistant.request?.tokensPerSecond).toBe(48)
  })

  it('账本耗时 0 = 未测量，退回「请求 → 首个工具开跑」的反推', () => {
    const turns = buildTrajectory({
      usage: [{ messageId: 'a1', kind: 'chat_round', durationMs: 0 }],
      messages: [
        msg('u1', 'user', { content: '跑一下', timestamp: T0 }),
        msg('a1', 'assistant', {
          content: '',
          timestamp: T0,
          toolCalls: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: {} }],
        }),
        msg('t1', 'tool', { toolCallId: 'c1', timestamp: T0 + 1000, elapsedMs: 200 }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    // 工具结果结束于 T0+1000、自带 200ms → 开始于 T0+800 → 反推 800ms
    expect(assistant.durationMs).toBe(800)
    expect(assistant.durationSource).toBe('derived')
    // 流水存在（可以看模型），但耗时字段不伪造
    expect(assistant.request?.durationMs).toBeUndefined()
    expect(assistant.request?.tokensPerSecond).toBeUndefined()
  })

  it('账本里没有这条请求 → 不加 request，耗时仍是 null', () => {
    const turns = buildTrajectory({
      usage: [{ messageId: 'other', kind: 'title', durationMs: 900 }],
      messages: [
        msg('u1', 'user', { content: '你好' }),
        msg('a1', 'assistant', { content: '你好呀', timestamp: T0 + 10 }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    expect(assistant.durationMs).toBeNull()
    expect(assistant.durationSource).toBeUndefined()
    expect(assistant.request).toBeUndefined()
  })

  it('耗时不足 1 秒不算吞吐（首字延迟会把它放大成天文数字）', () => {
    const turns = buildTrajectory({
      usage: [{ messageId: 'a1', kind: 'chat_round', durationMs: 800 }],
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', {
          content: '答',
          timestamp: T0,
          usage: { promptTokens: 10, completionTokens: 300, totalTokens: 310 },
        }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    expect(assistant.durationMs).toBe(800)
    expect(assistant.request?.tokensPerSecond).toBeUndefined()
  })

  it('模型变化处打 modelShift（第一条请求也算）', () => {
    const same = buildTrajectory({
      usage: [
        { messageId: 'a1', kind: 'chat_round', model: 'm1' },
        { messageId: 'a2', kind: 'chat_round', model: 'm1' },
      ],
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', { content: '答一' }),
        msg('a2', 'assistant', { content: '答二' }),
      ],
    })
    const [first, second] = [
      ...same[0].groups[1].records,
      ...same[0].groups[2].records,
    ]
    expect(first.request?.modelShift).toBe(true)
    expect(second.request?.modelShift).toBeUndefined()

    const switched = buildTrajectory({
      usage: [
        { messageId: 'a1', kind: 'chat_round', model: 'm1' },
        { messageId: 'a2', kind: 'chat_round', model: 'm2' },
      ],
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', { content: '答一' }),
        msg('a2', 'assistant', { content: '答二' }),
      ],
    })
    const [, secondSwitched] = [
      ...switched[0].groups[1].records,
      ...switched[0].groups[2].records,
    ]
    expect(secondSwitched.request?.modelShift).toBe(true)
  })

  it('进行中的回复不给耗时（账本流水只在结束后才有）', () => {
    const turns = buildTrajectory({
      usage: [{ messageId: 'a1', kind: 'chat_round', durationMs: 3000 }],
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', {
          content: '写一半',
          streaming: true,
          timestamp: T0,
        }),
      ],
    })
    const assistant = turns[0].groups[1].records[0]
    expect(assistant.durationMs).toBeNull()
    expect(assistant.durationSource).toBeUndefined()
  })

  it('压缩行的实测耗时也取账本（历史回填的 compress 流水带 messageId）', () => {
    const turns = buildTrajectory({
      usage: [
        { messageId: 's1', kind: 'compress', durationMs: 9000, estimated: true },
      ],
      messages: [
        msg('u1', 'user', { content: '第一问' }),
        msg('s1', 'summary', { content: '摘要', timestamp: T0 }),
      ],
    })
    const compaction = turns[1].groups[0].records[0]
    expect(compaction).toMatchObject({
      kind: 'compacted',
      durationMs: 9000,
      durationSource: 'usage',
      request: { kind: 'compress', durationMs: 9000, estimated: true },
    })
  })
})

describe('summarizeTrajectory', () => {
  const turns = buildTrajectory({
    usage: [
      { messageId: 'a1', kind: 'chat_round', durationMs: 1200 },
      { messageId: 'a2', kind: 'chat_round', durationMs: 800 },
    ],
    messages: [
      msg('u1', 'user', { content: '第一问', timestamp: T0 }),
      msg('a1', 'assistant', {
        content: '答一',
        timestamp: T0,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 },
        toolCalls: [
          { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
          { type: 'tool_use', id: 'c2', name: 'run', input: {} },
        ],
      }),
      msg('t1', 'tool', { toolCallId: 'c1', content: 'ok', timestamp: T0 + 100, elapsedMs: 100 }),
      msg('t2', 'tool', {
        toolCallId: 'c2',
        content: 'boom',
        isError: true,
        timestamp: T0 + 200,
        elapsedMs: 50,
      }),
      msg('u2', 'user', { content: '第二问', timestamp: T0 + 1000 }),
      msg('a2', 'assistant', {
        content: '答二',
        timestamp: T0 + 1100,
        usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      }),
    ],
  })

  it('轮次 / 步骤 / 工具 / 失败 / token 都按窗口口径聚合', () => {
    const stats = summarizeTrajectory(turns)
    expect(stats).toMatchObject({
      turns: 2,
      steps: 2,
      tools: 2,
      failures: 1,
      input: 150,
      output: 30,
      cached: 40,
    })
  })

  it('实测耗时只累加账本里真有耗时的请求', () => {
    const stats = summarizeTrajectory(turns)
    expect(stats.measuredMs).toBe(2000)
    expect(stats.measuredCalls).toBe(2)
    // 命中率分母 = 输入 + 缓存读取 + 缓存写入
    expect(stats.cacheHitRatio).toBeCloseTo(40 / 190, 6)
  })

  it('一条耗时都没测到 / 没有 token 时给 null 而不是 0', () => {
    const bare = buildTrajectory({
      messages: [
        msg('u1', 'user', { content: '问' }),
        msg('a1', 'assistant', { content: '答' }),
      ],
    })
    const stats = summarizeTrajectory(bare)
    expect(stats.measuredMs).toBeNull()
    expect(stats.measuredCalls).toBe(0)
    expect(stats.cacheHitRatio).toBeNull()
    // 「会话开始」/ 压缩段不参与轮次编号，不能被数成一轮
    expect(stats.turns).toBe(1)
  })
})

describe('requestStatsFromTotals', () => {
  it('命中率分母 = 输入 + 缓存读取 + 缓存写入', () => {
    const stats = requestStatsFromTotals({
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 60,
      cacheWriteTokens: 20,
      calls: 4,
      estimatedCalls: 1,
      chatCalls: 3,
    })
    expect(stats).toMatchObject({
      calls: 4,
      chatCalls: 3,
      estimatedCalls: 1,
      input: 100,
      output: 50,
      cached: 60,
      cacheWrite: 20,
    })
    expect(stats.cacheHitRatio).toBeCloseTo(60 / 180, 6)
  })

  it('分母为 0 时命中率是 null（不是 0%）', () => {
    const stats = requestStatsFromTotals({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
      estimatedCalls: 0,
      chatCalls: 0,
    })
    expect(stats.cacheHitRatio).toBeNull()
  })
})
