/**
 * 「本轮 agent 循环总耗时」写回 —— `stream_end` 的消费侧。
 *
 * 为什么守这一层：耗时是**事后**挂到消息上的（引擎不知道界面要显示多久），只有**非暂停**的
 * `stream_end` 才代表「循环真的跑完并给了最后一条回复」；pause 是挂起，error / 用户取消根本走不到
 * 这个事件，都不该带这个值。挂错消息（挂到上一个回合的助手消息）比不显示更糟 ——
 * 用户会把上一轮的耗时当成这一轮的。
 *
 * 载体是 `message.uiData.agentElapsedMs`（见 `utils/messageMeta.ts`）：随消息一起落库，不新增 DB 列。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSessionRuntime, sessionStore } from '@/ui/store'
import { createEventHandler } from '@/services/chat/event-handler'
import { activeTraces } from '@/services/chat/trace'
import { agentElapsedMsOf } from '@/utils/messageMeta'
import type { AgentEventCallback, Message, Session } from '@/types'

const SESSION_ID = 's-agent-elapsed'
const ASSISTANT_ID = 'a-final'
/** 假想的本轮开始时刻：比现在早 4.2s（足够区分「有值」与「没值」，又不依赖假定时器） */
const TRACE_START = Date.now() - 4200

function seedSession(messages: Message[]): void {
  const session = {
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

function messageOf(messageId: string): Message | undefined {
  return sessionStore
    .getSession(SESSION_ID)
    ?.messages.find((m) => m.id === messageId)
}

/** 新建一个事件处理器（等价于 chat-service 的挂载方式） */
function handler(): AgentEventCallback {
  return createEventHandler(SESSION_ID, getSessionRuntime(SESSION_ID))
}

function emitEnd(
  handle: AgentEventCallback,
  data: Record<string, any> = { paused: false },
): void {
  handle({ type: 'stream_end', data })
}

/** 本次运行累计的轮次（`assistant_message_created` 次数） */
function setRounds(rounds: number): void {
  const trace = activeTraces.get(SESSION_ID)
  if (trace) trace.rounds = rounds
}

beforeEach(() => {
  seedSession([
    { id: 'u1', role: 'user', content: '跑一下', timestamp: 0 },
    { id: ASSISTANT_ID, role: 'assistant', content: '跑完了。', timestamp: 0 },
  ])
  activeTraces.set(SESSION_ID, {
    traceId: 'trace-elapsed',
    startTime: TRACE_START,
    firstTokenSeen: true,
    errored: false,
    rounds: 1,
    toolCallIds: new Set(),
  })
})

afterEach(() => {
  activeTraces.delete(SESSION_ID)
})

describe('stream_end —— 本轮 agent 循环总耗时', () => {
  it('正常跑完：总耗时挂到最后一条助手消息的 uiData 上', () => {
    emitEnd(handler())

    const message = messageOf(ASSISTANT_ID)
    const elapsed = agentElapsedMsOf(message!)
    expect(elapsed).toBeGreaterThanOrEqual(4200)
    expect(elapsed).toBeLessThan(10_000)
    // 载体是 uiData（随消息落库的既有通道），不是新增的顶层字段
    expect(message?.uiData?.agentElapsedMs).toBe(elapsed)
  })

  it('合并而不是覆盖已有 uiData', () => {
    // 助手消息上可能已经有别的界面元数据（如压缩后的上下文占用），不能被整块冲掉
    seedSession([
      { id: 'u1', role: 'user', content: '跑一下', timestamp: 0 },
      {
        id: ASSISTANT_ID,
        role: 'assistant',
        content: '跑完了。',
        timestamp: 0,
        uiData: { contextTokens: 1234 },
      },
    ])

    emitEnd(handler())

    expect(messageOf(ASSISTANT_ID)?.uiData?.contextTokens).toBe(1234)
    expect(agentElapsedMsOf(messageOf(ASSISTANT_ID)!)).toBeGreaterThan(0)
  })

  it('paused（挂起）：循环没跑完，不写', () => {
    emitEnd(handler(), { paused: true, snapshot: { round: 1, steps: [] } })
    expect(agentElapsedMsOf(messageOf(ASSISTANT_ID)!)).toBeUndefined()
  })

  it('本轮没产出助手消息（rounds = 0）：不拿本轮耗时去标上一个回合', () => {
    setRounds(0)
    emitEnd(handler())
    expect(agentElapsedMsOf(messageOf(ASSISTANT_ID)!)).toBeUndefined()
  })

  it('最后一条助手消息没有可见内容：不写（那种气泡连操作栏都不渲染）', () => {
    seedSession([
      { id: 'u1', role: 'user', content: '跑一下', timestamp: 0 },
      { id: ASSISTANT_ID, role: 'assistant', content: '   ', timestamp: 0 },
    ])
    emitEnd(handler())
    expect(agentElapsedMsOf(messageOf(ASSISTANT_ID)!)).toBeUndefined()
  })

  it('耗时非法（0 / 负数 / 非数字）一律当没有', () => {
    const withValue = (value: unknown): Message => ({
      id: 'x',
      role: 'assistant',
      content: '',
      timestamp: 0,
      uiData: { agentElapsedMs: value },
    })
    expect(agentElapsedMsOf(withValue(0))).toBeUndefined()
    expect(agentElapsedMsOf(withValue(-5))).toBeUndefined()
    expect(agentElapsedMsOf(withValue('3'))).toBeUndefined()
    expect(agentElapsedMsOf({ id: 'x', role: 'assistant', content: '', timestamp: 0 })).toBeUndefined()
  })
})
