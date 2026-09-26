/**
 * todoDraftStore + todo-service — 「应用才是修改」回归测试
 *
 * 用户明确要求的语义（回归背景）：
 * - 用户**编辑中**（还没点「应用变更」）的草稿**不算修改** ——
 *   本轮 stream_end / 取消本轮都不会自动把它落地，清单权威保持不变；
 * - AI **回复中**点「应用变更 / 覆盖更新」= 标记「已应用」（committed），
 *   等本轮真正结束（stream_end 非 paused）/ 用户取消时**逐字落地** ——
 *   用户这份为准，AI 这期间的进度不回灌（想跟随 AI 就点「放弃编辑并同步」）；
 * - 任何后续编辑都会把 committed 复位（「编辑中」永远不等于「已修改」）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStore } from '@/ui/store'
import {
  clearTodoDraft,
  dropUnappliedTodoDraft,
  ensureTodoDraft,
  getTodoDraft,
  isTodoDraftCommitted,
  markTodoDraftCommitted,
  updateTodoDraftItems,
} from '@/ui/store/todoDraftStore'
import {
  applyTodoDraft,
  flushTodoDraft,
  flushTodoDraftMessages,
  getEffectiveTodos,
} from '@/services/todo-service'
import {
  computeStats,
  sameTodoList,
} from '@/domain/todo/state'
import type { TodoItem, TodoStatus, TodoUiData } from '@/domain/todo/types'
import type { Message, Session } from '@/types'

const SESSION_ID = 's-todo-draft'
let seq = 0

function todo(id: string, content: string, status: TodoStatus = 'pending'): TodoItem {
  return { id, content, status }
}

/** 模拟引擎写入清单的那条 tool 消息（权威快照） */
function modelToolMessage(todos: TodoItem[]): Message {
  seq += 1
  const uiData: TodoUiData = {
    type: 'todo',
    todos,
    stats: computeStats(todos),
    source: 'model',
  }
  return {
    id: `tool-${seq}`,
    role: 'tool',
    content: '清单已写入',
    uiData,
    timestamp: seq,
  } as unknown as Message
}

function seedSession(messages: Message[]): void {
  const session: Session = {
    id: SESSION_ID,
    title: 't',
    messages,
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: '',
    params: { temperature: 0.7, topP: 1, maxTokens: 1024, stream: true },
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    tags: [],
  } as unknown as Session
  sessionStore.saveSession(session)
}

/** 当前会话里的消息（含落地的 feedback 消息） */
function messages(): Message[] {
  return sessionStore.getSession(SESSION_ID)?.messages || []
}

beforeEach(() => {
  seq = 0
  clearTodoDraft(SESSION_ID)
  seedSession([
    modelToolMessage([
      todo('1', 'A'),
      todo('2', 'B'),
    ]),
  ])
})

describe('todoDraftStore — 草稿的两态', () => {
  it('新建草稿默认处于「编辑中」（未应用）', () => {
    const draft = ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    expect(draft.committed).toBe(false)
    expect(isTodoDraftCommitted(SESSION_ID)).toBe(false)
  })

  it('编辑会把「已应用」复位为「编辑中」', () => {
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A')])
    expect(markTodoDraftCommitted(SESSION_ID)).toBe(true)
    expect(isTodoDraftCommitted(SESSION_ID)).toBe(true)

    // 又改了一笔 → 重新变回「编辑中」，不会被自动落地
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A 改')])
    expect(isTodoDraftCommitted(SESSION_ID)).toBe(false)
  })

  it('无草稿时标记「已应用」返回 false', () => {
    expect(markTodoDraftCommitted(SESSION_ID)).toBe(false)
    expect(getTodoDraft(SESSION_ID)).toBeUndefined()
  })

  it('关闭浮层（dropUnappliedTodoDraft）：未应用 → 丢弃；无草稿 → 无事发生', () => {
    // 没有草稿时什么也不做（不该无中生有地「丢弃」）
    expect(dropUnappliedTodoDraft(SESSION_ID)).toBe(false)

    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A 改')])
    expect(getTodoDraft(SESSION_ID)?.todos[0].content).toBe('A 改')

    expect(dropUnappliedTodoDraft(SESSION_ID)).toBe(true)
    expect(getTodoDraft(SESSION_ID)).toBeUndefined()
    // 权威清单从未被这段草稿影响过
    expect(getEffectiveTodos(SESSION_ID).map((t) => t.id)).toEqual(['1', '2'])
  })

  it('关闭浮层不会丢掉「已应用」的草稿（等本轮生效的不能丢）', () => {
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A', 'completed')])
    markTodoDraftCommitted(SESSION_ID)

    expect(dropUnappliedTodoDraft(SESSION_ID)).toBe(false)
    expect(isTodoDraftCommitted(SESSION_ID)).toBe(true)
    expect(getTodoDraft(SESSION_ID)?.todos.map((t) => t.status)).toEqual([
      'completed',
    ])

    // 依然能在本轮结束时落地
    expect(flushTodoDraft(SESSION_ID, 'stream_end')).toBe(true)
  })
})

describe('flushTodoDraft — 只有「已应用」的草稿才落地', () => {
  it('编辑中（未应用）→ 本轮结束不落地，草稿保留', () => {
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A')])

    const before = messages().length
    expect(flushTodoDraft(SESSION_ID, 'stream_end')).toBe(false)
    expect(flushTodoDraft(SESSION_ID, 'cancel')).toBe(false)

    expect(messages().length).toBe(before)
    // 草稿还在，用户还能继续编辑 / 应用
    expect(getTodoDraft(SESSION_ID)?.todos.map((t) => t.id)).toEqual(['1'])
    // 权威清单仍是模型那份
    expect(getEffectiveTodos(SESSION_ID).map((t) => t.id)).toEqual(['1', '2'])
  })

  it('覆盖更新：用户清单逐字生效，AI 这期间的进度不回灌', () => {
    // 用户删掉 B 并点了「应用 / 覆盖更新」（AI 仍在回复中，所以只标记 committed）
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A')])
    markTodoDraftCommitted(SESSION_ID)

    // 本轮里 AI 又写了一次清单：A 完成了，并新增 C
    sessionStore.getSession(SESSION_ID)!.messages.push(
      modelToolMessage([
        todo('1', 'A', 'completed'),
        todo('2', 'B'),
        todo('3', 'C'),
      ]),
    )

    expect(flushTodoDraft(SESSION_ID, 'stream_end')).toBe(true)

    const last = messages()[messages().length - 1]
    expect(last.role).toBe('feedback')
    const data = last.uiData as TodoUiData
    expect(data.type).toBe('todo')
    expect(data.source).toBe('user')
    // 逐字落地：只有用户草稿里那一条（status 也回到用户那份），
    // AI 把 A 标完成、AI 新增的 C 都不回灌 —— 界面看到什么就落地什么
    expect(data.todos.map((t) => `${t.id}:${t.status}`)).toEqual(['1:pending'])
    // 变化说明是相对「AI 最新清单」算的：撤销了 A 的完成 + 移除 B / C
    expect(
      data.changes?.some((c) => c.type === 'status' && c.content === 'A'),
    ).toBe(true)
    expect(
      data.changes
        ?.filter((c) => c.type === 'remove')
        .map((c) => c.content)
        .sort(),
    ).toEqual(['B', 'C'])
    // 落地后草稿清空 → 显示回到消息派生
    expect(getTodoDraft(SESSION_ID)).toBeUndefined()
  })

  it('编辑期间 AI 又写清单 → sameTodoList 能识别「权威被换过」', () => {
    const base = getEffectiveTodos(SESSION_ID)
    ensureTodoDraft(SESSION_ID, base)
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A')])
    expect(sameTodoList(getEffectiveTodos(SESSION_ID), base)).toBe(true)

    sessionStore.getSession(SESSION_ID)!.messages.push(
      modelToolMessage([todo('1', 'A', 'completed'), todo('2', 'B')]),
    )
    // 编辑器就拿这个条件把按钮换成「放弃编辑并同步 / 覆盖更新」
    expect(sameTodoList(getEffectiveTodos(SESSION_ID), base)).toBe(false)
  })

  it('AI 空闲时点「应用」→ 立即落地（不走 committed 阶段）', () => {
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A', 'completed'), todo('2', 'B')])

    expect(applyTodoDraft(SESSION_ID, 'user')).toBe(true)
    expect(getEffectiveTodos(SESSION_ID).map((t) => t.status)).toEqual([
      'completed',
      'pending',
    ])
    expect(getTodoDraft(SESSION_ID)).toBeUndefined()
  })

  it('轮次边界：已应用 → 返回要注入下一次请求的消息；未应用 → 空', () => {
    // 未应用（还在编辑）：不算修改，不返回任何消息
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A')])
    expect(flushTodoDraftMessages(SESSION_ID, 'round_boundary')).toEqual([])

    // 应用后：返回落地的那条 feedback 消息（引擎据此注入本轮消息列表）
    markTodoDraftCommitted(SESSION_ID)
    const injected = flushTodoDraftMessages(SESSION_ID, 'round_boundary')
    expect(injected).toHaveLength(1)
    expect(injected[0].role).toBe('feedback')
    expect((injected[0].uiData as TodoUiData).source).toBe('user')
    expect(messages().some((m) => m.id === injected[0].id)).toBe(true)
  })

  it('改完又改回原样 → 不产生噪音消息', () => {
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    // 改了一笔又改回来（内容与 base 完全一致）
    updateTodoDraftItems(SESSION_ID, [todo('1', 'A'), todo('2', 'B')])
    markTodoDraftCommitted(SESSION_ID)

    const before = messages().length
    expect(flushTodoDraft(SESSION_ID, 'cancel')).toBe(false)
    expect(messages().length).toBe(before)
    expect(getTodoDraft(SESSION_ID)).toBeUndefined()
  })

  it('只改备注也算一次修改（回归：不再误报「清单没有变化」）', () => {
    ensureTodoDraft(SESSION_ID, getEffectiveTodos(SESSION_ID))
    const next = getEffectiveTodos(SESSION_ID).map((t) => ({ ...t }))
    next[0].note = '补充说明'
    updateTodoDraftItems(SESSION_ID, next)

    expect(applyTodoDraft(SESSION_ID, 'user')).toBe(true)
    const last = messages()[messages().length - 1]
    expect(last.role).toBe('feedback')
    const data = last.uiData as TodoUiData
    expect(data.todos[0].note).toBe('补充说明')
    expect(data.changes?.some((c) => c.type === 'note')).toBe(true)
  })
})
