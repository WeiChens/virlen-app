/**
 * sessionStore.ensureContextLoaded — 发送路径「只加载到最后一条 summary」的回归测试
 *
 * 背景（AGENTS.md §11.35 的 B 方案）：
 * 前端发送路径过去一律 `ensureAllMessagesLoaded`（把整份历史拉进内存 + 经 IPC 传给引擎），
 * 而请求组装（TS `buildRequest` / Rust `slice_messages`）本就丢掉最后一个 summary 之前的消息。
 * `ensureContextLoaded` 改为「从尾部连续加载，直到加载窗口里出现 summary 即停」——
 * 因为消息是从尾部向前连续加载的，最后一个 summary 已在内存 ⇒ 它之后的全部消息必然也在。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionStore } from '@/ui/store'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import type { Message, MessageRole, Session } from '@/types'

function msg(id: string, role: MessageRole): Message {
  return { id, role, content: '', timestamp: 1 } as unknown as Message
}

/** 直接把会话放进 store（不走 saveSession —— 那会把它标记为「已加载」，跳过懒加载） */
function seedSession(id: string, messages: Message[]): void {
  const session: Session = {
    id,
    title: `t-${id}`,
    messages,
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: '',
    params: { temperature: 0.7, topP: 1, maxTokens: 1024, stream: true },
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    tags: [],
  }
  sessionStore.value.sessions = [
    ...sessionStore.value.sessions.filter((s) => s.id !== id),
    session,
  ]
  sessionStore.value.messagePaging = { ...sessionStore.value.messagePaging }
}

beforeEach(() => {
  sessionStore.value.sessions = []
  sessionStore.value.messagePaging = {}
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionStore.ensureContextLoaded', () => {
  it('summary 不在尾部窗口时：继续向上回补，直到加载到 summary 即停', async () => {
    // 70 条消息：summary 在下标 5（远早于尾部 60 条窗口之外）
    const all: Message[] = []
    for (let i = 0; i < 70; i++) {
      all.push(
        msg(`m${i}`, i === 5 ? 'summary' : i % 2 === 0 ? 'user' : 'assistant'),
      )
    }
    seedSession('s1', [])

    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    // 第一页：尾部 60 条（下标 10..69，不含 summary），还有更早的
    spy.mockResolvedValueOnce({
      messages: all.slice(10),
      hasMore: true,
      oldestRowid: 11,
    })
    // 第二页（beforeRowid=11）：更早的 10 条（下标 0..9，含 summary）→ 加载完即无更多
    spy.mockResolvedValueOnce({
      messages: all.slice(0, 10),
      hasMore: false,
      oldestRowid: 1,
    })

    await sessionStore.ensureContextLoaded('s1')

    expect(spy).toHaveBeenCalledTimes(2)
    const loaded = sessionStore.getSession('s1')!.messages
    expect(loaded).toHaveLength(70)
    expect(loaded[5].role).toBe('summary')
  })

  it('summary 已在尾部窗口时：只加载一次，不再向上回补', async () => {
    const all: Message[] = []
    for (let i = 0; i < 70; i++) {
      all.push(
        msg(`m${i}`, i === 65 ? 'summary' : i % 2 === 0 ? 'user' : 'assistant'),
      )
    }
    seedSession('s2', [])

    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    // 尾部 60 条（下标 10..69）里已含 summary（下标 65）→ 一次到位
    spy.mockResolvedValueOnce({
      messages: all.slice(10),
      hasMore: true,
      oldestRowid: 11,
    })

    await sessionStore.ensureContextLoaded('s2')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(sessionStore.getSession('s2')!.messages).toHaveLength(60)
  })

  it('无 summary 时退化为全量加载', async () => {
    const all: Message[] = []
    for (let i = 0; i < 70; i++) all.push(msg(`m${i}`, 'user'))
    seedSession('s3', [])

    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    spy.mockResolvedValueOnce({
      messages: all.slice(10),
      hasMore: true,
      oldestRowid: 11,
    })
    spy.mockResolvedValueOnce({
      messages: all.slice(0, 10),
      hasMore: false,
      oldestRowid: 1,
    })

    await sessionStore.ensureContextLoaded('s3')

    expect(spy).toHaveBeenCalledTimes(2)
    expect(sessionStore.getSession('s3')!.messages).toHaveLength(70)
  })
})
