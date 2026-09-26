/**
 * 流式补丁的增量协议 — `assistant_message_updated` 的消费侧
 *
 * 回归背景（IPC 载荷优化，见 `docs/AGENTS.md` §5.1 与 agent 引擎）：
 * 流式期间引擎**只回传正文增量**（`patch.contentDelta`），由 chat-service 在这里
 * 拼回全量正文。若这里拼不动，UI 正文会一直是空的 —— 直到流结束帧的全量补丁
 * 才补上，表现为「回复过程看不见字」。
 *
 * 引擎侧契约（两侧对称，铁律 1）：
 * - 流式帧：只带 `contentDelta`（或思考快照 `reasoningContent`）
 * - 结束帧：带全量 `content`，用于兜底自愈
 * 见 `src-tauri/virlen-core/src/agent/llm_round.rs::flush_stream_state`。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getSessionRuntime, sessionStore } from '@/ui/store'
import { createEventHandler } from '@/services/chat/event-handler'
import type { AgentEventCallback, Message, Session } from '@/types'

const SESSION_ID = 's-stream-delta'
const MSG_ID = 'm-assistant-1'

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

function contentOf(messageId: string): string {
  return String(messageOf(messageId)?.content ?? '')
}

/** 新建一个事件处理器（等价于 chat-service 的挂载方式） */
function handler(): AgentEventCallback {
  return createEventHandler(SESSION_ID, getSessionRuntime(SESSION_ID))
}

/** 引擎创建流式 assistant 消息（chat-service 会持久化进 store） */
function emitCreated(handle: AgentEventCallback): void {
  handle({
    type: 'assistant_message_created',
    data: {
      message: {
        id: MSG_ID,
        role: 'assistant',
        content: '',
        timestamp: 1,
        streaming: true,
      },
    },
  })
}

/** 流式帧：只带正文增量 */
function emitDelta(handle: AgentEventCallback, delta: string): void {
  handle({
    type: 'assistant_message_updated',
    data: { messageId: MSG_ID, patch: { contentDelta: delta, streaming: true } },
  })
}

beforeEach(() => {
  seedSession([])
})

describe('assistant_message_updated — 增量补丁', () => {
  it('contentDelta 逐条拼接到现有正文上', () => {
    const handle = handler()
    emitCreated(handle)
    emitDelta(handle, '你')
    emitDelta(handle, '好')
    expect(contentOf(MSG_ID)).toBe('你好')
  })

  it('思考快照补丁不应清空已累积的正文', () => {
    const handle = handler()
    emitCreated(handle)
    emitDelta(handle, '答')
    // 思考快照帧不含 contentDelta，正文必须保持原样
    handle({
      type: 'assistant_message_updated',
      data: {
        messageId: MSG_ID,
        patch: { reasoningContent: '先想一下', streaming: true },
      },
    })
    expect(contentOf(MSG_ID)).toBe('答')
    expect(messageOf(MSG_ID)?.reasoningContent).toBe('先想一下')
  })

  it('结束帧的全量 content 覆盖拼接结果（丢失增量可自愈）', () => {
    const handle = handler()
    emitCreated(handle)
    emitDelta(handle, '半截')
    // 模拟中间丢过一次增量：结束帧直接给全量正文
    handle({
      type: 'assistant_message_updated',
      data: {
        messageId: MSG_ID,
        patch: { content: '完整回答', streaming: false },
      },
    })
    expect(contentOf(MSG_ID)).toBe('完整回答')
    expect(messageOf(MSG_ID)?.streaming).toBe(false)
  })

  it('消息尚未加载时补丁不抛错（内容交给结束帧纠正）', () => {
    const handle = handler()
    // 没有 assistant_message_created，直接来增量：找不到消息即跳过
    expect(() =>
      handle({
        type: 'assistant_message_updated',
        data: { messageId: 'missing', patch: { contentDelta: 'x' } },
      }),
    ).not.toThrow()
    expect(contentOf('missing')).toBe('')
  })
})
