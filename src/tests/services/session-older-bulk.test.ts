/**
 * sessionStore 批量回补（`loadOlderMessagesUntil`）用例。
 *
 * 关键不变量：一次批量回补**只提交一次** observable —— 逐页提交会让每个读消息列表的 observer
 *（侧栏 / 锚点列表 / token 环 / 待办入口…）每页重渲染一轮；点最上面的锚点要回补上百页时，
 * 主线程被这些重渲染占满，表现就是「界面卡死、loading 转圈停住」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reaction, runInAction } from 'mobx'
import { sessionStore } from '@/ui/store'
import { MESSAGE_PAGE_SIZE } from '@/ui/store/sessionStore'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import type { MessagePage } from '@/infrastructure/sessionRepo'
import type { Message, Session } from '@/types'

const msg = (id: string): Message =>
  ({ id, role: 'user', content: id, timestamp: 1 }) as unknown as Message

function seed(
  id: string,
  messages: Message[],
  hasMoreOlder: boolean,
  oldestRowid: number | null,
): void {
  const session = {
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
  } as Session
  runInAction(() => {
    sessionStore.value.sessions = [
      ...sessionStore.value.sessions.filter((s) => s.id !== id),
      session,
    ]
    sessionStore.value.messagePaging = {
      ...sessionStore.value.messagePaging,
      [id]: { hasMoreOlder, oldestRowid },
    }
  })
}

/** 第 n 段：id 从 `from` 起的 10 条（升序） */
function chunk(from: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < 10; i++) out.push(msg(`m${from + i}`))
  return out
}

function page(messages: Message[], hasMore: boolean, oldestRowid: number | null): MessagePage {
  return { messages, hasMore, oldestRowid }
}

/** 模拟「回补期间引擎 / 流式往尾部追加了一条消息」 */
function appendMessage(sessionId: string, message: Message): void {
  runInAction(() => {
    const sessions = [...sessionStore.value.sessions]
    const i = sessions.findIndex((s) => s.id === sessionId)
    sessions[i] = { ...sessions[i], messages: [...sessions[i].messages, message] }
    sessionStore.value.sessions = sessions
  })
}

beforeEach(() => {
  runInAction(() => {
    sessionStore.value.sessions = []
    sessionStore.value.messagePaging = {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionStore.loadOlderMessagesUntil', () => {
  it('按 until 攒够才停，且只提交一次（不是每页一次）', async () => {
    seed('s1', chunk(60), true, 60)
    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    spy.mockResolvedValueOnce(page(chunk(50), true, 50))
    spy.mockResolvedValueOnce(page(chunk(40), true, 40))
    spy.mockResolvedValueOnce(page(chunk(30), true, 30))

    // 提交次数 = 观察「消息列表内容」的 reaction 触发次数
    const commits: number[] = []
    const dispose = reaction(
      () => sessionStore.value.sessions.map((s) => s.messages.length),
      (lengths) => commits.push(lengths[0] ?? 0),
    )

    const all = await sessionStore.loadOlderMessagesUntil(
      's1',
      (window) => window.some((m) => m.id === 'm35'),
      10,
    )
    dispose()

    expect(all).toHaveLength(40)
    expect(all![0].id).toBe('m30')
    expect(all![39].id).toBe('m69')
    expect(spy).toHaveBeenCalledTimes(3)
    // 游标逐页前移（不是每页都用同一个 beforeRowid —— 那会把同一段重复前插）
    expect(spy.mock.calls.map((c) => c[1]?.beforeRowid)).toEqual([60, 50, 40])
    expect(spy.mock.calls[0][1]).toMatchObject({
      limit: MESSAGE_PAGE_SIZE,
      beforeRowid: 60,
    })
    // 中途不给 UI 中间态
    expect(commits).toEqual([40])
    expect(sessionStore.hasMoreMessages('s1')).toBe(true)
  })

  it('已无更早的消息：一个请求都不发', async () => {
    seed('s2', chunk(60), false, null)
    const spy = vi.spyOn(sessionRepo, 'getMessagePage')

    const all = await sessionStore.loadOlderMessagesUntil('s2', () => false, 10)

    expect(spy).not.toHaveBeenCalled()
    expect(all!.map((m) => m.id)).toEqual(chunk(60).map((m) => m.id))
  })

  it('until 永不命中时受 maxPages 兜底', async () => {
    seed('s3', chunk(60), true, 60)
    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    spy.mockResolvedValue(page(chunk(50), true, 50))

    const all = await sessionStore.loadOlderMessagesUntil('s3', () => false, 2)

    expect(spy).toHaveBeenCalledTimes(2)
    expect(all).toHaveLength(30)
    // 还有更早的：游标停在本轮最旧一页
    expect(sessionStore.hasMoreMessages('s3')).toBe(true)
    expect(sessionStore.value.messagePaging.s3.oldestRowid).toBe(50)
  })

  it('空页（游标失效 / 数据被删）→ 标记无更多，避免反复请求', async () => {
    seed('s4', chunk(60), true, 60)
    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    spy.mockResolvedValueOnce(page([], false, null))

    const all = await sessionStore.loadOlderMessagesUntil('s4', () => false, 5)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(all).toHaveLength(10)
    expect(sessionStore.hasMoreMessages('s4')).toBe(false)
  })

  it('回补期间追加的新消息不会被丢掉（拼接的是提交时刻的列表，而非开始时的快照）', async () => {
    seed('s7', chunk(60), true, 60)
    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    spy.mockImplementationOnce(async () => {
      appendMessage('s7', msg('live'))
      return page(chunk(50), true, 50)
    })

    const all = await sessionStore.loadOlderMessagesUntil('s7', undefined, 1)

    expect(all!.map((m) => m.id)).toEqual([
      ...chunk(50).map((m) => m.id),
      ...chunk(60).map((m) => m.id),
      'live',
    ])
  })

  it('shouldStop 为真即停（已取到的部分照常提交）', async () => {
    seed('s6', chunk(60), true, 60)
    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    spy.mockResolvedValueOnce(page(chunk(50), true, 50))
    spy.mockResolvedValueOnce(page(chunk(40), true, 40))

    let pages = 0
    const all = await sessionStore.loadOlderMessagesUntil(
      's6',
      undefined,
      10,
      () => ++pages > 1,
    )

    expect(spy).toHaveBeenCalledTimes(2)
    expect(all!.map((m) => m.id)).toEqual(
      [...chunk(40), ...chunk(50), ...chunk(60)].map((m) => m.id),
    )
  })

  it('并发：同会话的第二次调用复用同一请求，不重复取同一页', async () => {
    seed('s5', chunk(60), true, 60)
    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    let resolvePage: (p: MessagePage) => void = () => {}
    spy.mockReturnValueOnce(
      new Promise<MessagePage>((resolve) => {
        resolvePage = resolve
      }),
    )

    const bulk = sessionStore.loadOlderMessagesUntil(
      's5',
      (window) => window.some((m) => m.id === 'm55'),
      10,
    )
    // 批量回补还在飞：单页入口必须搭车（返回 true = 窗口确实变长了）
    const single = sessionStore.loadOlderMessages('s5')
    resolvePage(page(chunk(50), true, 50))

    expect(await single).toBe(true)
    expect(await bulk).toHaveLength(20)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
