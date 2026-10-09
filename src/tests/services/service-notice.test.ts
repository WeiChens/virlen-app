/**
 * service-notice — 「后台服务结束通知」的前端落点回归测试。
 *
 * 口径（Rust 侧 `native_tools/service/notice.rs` 决定，前端只执行）：
 * - 通知由 Rust 组装（模型侧英文正文 + `uiData`），前端**不碰文案**，只把它当普通消息落进会话；
 * - 会话尾部窗口已在内存 → 同步写进 store（消息流立刻出现）+ 显式落库；
 * - 还没加载过该会话 → **只落库**，绝不往空列表里塞（否则界面只剩孤零零一条通知）；
 * - 非 Tauri 环境不挂任何监听（浏览器 dev / vitest 零副作用）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Message, Session } from '@/types'

/** Rust 事件载荷的监听器（mock 的 listen 会写进来，测试用它模拟 Rust 发事件） */
const listeners = new Map<string, (event: { payload: unknown }) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb)
    return Promise.resolve(() => {})
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}))

import { invoke } from '@tauri-apps/api/core'
import { sessionStore } from '@/ui/store'
import { EVENT_SERVICE_EXIT, handleServiceExit, initServiceNotice } from '@/services/service-notice'

const SESSION_ID = 's-service-notice'
/** 另一个会话（上一条用例会故意把 `SESSION_ID` 标成「消息未加载」） */
const SESSION_ONCE = 's-service-notice-once'

/** 模拟/取消 Tauri 运行环境（`isTauriAvailable()` 读的就是这个字段） */
function setTauriEnv(on: boolean): void {
  if (on) {
    ;(globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  } else {
    delete (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

function makeSession(id: string): Session {
  return {
    id,
    title: '服务会话',
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: '',
    params: { temperature: 0, topP: 1, maxTokens: 0, stream: true },
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    tags: [],
  }
}

/** Rust 发来的那条消息（形状与 `notice.rs::common::exit_notice` 一致） */
function noticeMessage(id = 'notice-1'): Message {
  return {
    id,
    role: 'feedback',
    content:
      '[Background service ended] "dev" (id: svc_1) exited on its own after 12s.',
    uiData: {
      type: 'service',
      event: 'exit',
      id: 'svc_1',
      name: 'dev',
      cmd: 'npm run dev',
      status: 'exited',
      returnCode: 1,
      killed: false,
    },
    timestamp: 1_700_000_000_000,
  }
}

/** 模拟「会话元数据已加载、消息还没拉取」（= `loadFromDB()` 之后的状态）。 */
function markMessagesNotLoaded(sessionId: string): void {
  const internals = sessionStore as unknown as { loadedMessageIds: Set<string> }
  internals.loadedMessageIds.delete(sessionId)
}

/** 只取本模块关心的落库调用（sessionStore 的防抖落库会自己冒出来，不能断言总数） */
function appendCalls(): unknown[][] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === 'cmd_append_messages')
}

beforeEach(() => {
  listeners.clear()
  vi.mocked(invoke).mockClear()
})

afterEach(() => {
  setTauriEnv(false)
})

describe('service-notice — 前端落点', () => {
  it('非 Tauri 环境：不挂监听、不发命令', () => {
    setTauriEnv(false)
    initServiceNotice()
    expect(listeners.size).toBe(0)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('空闲时服务结束：消息落进会话（store + 落库），用户与 AI 下一次请求都看得到', () => {
    setTauriEnv(true)
    sessionStore.saveSession(makeSession(SESSION_ID))
    vi.mocked(invoke).mockClear()

    // 走真实链路：Rust 发事件 → 监听器 → 落消息
    initServiceNotice()
    const onExit = listeners.get(EVENT_SERVICE_EXIT)
    expect(onExit).toBeTypeOf('function')
    onExit!({ payload: { sessionId: SESSION_ID, message: noticeMessage() } })

    const messages = sessionStore.getSession(SESSION_ID)?.messages ?? []
    expect(messages.map((m) => m.id)).toContain('notice-1')
    // 会话时间不刷新（服务结束不是用户发言）
    expect(sessionStore.getSession(SESSION_ID)?.updatedAt).toBe(0)
    // 落库：引擎不负责这条（不是引擎写的），必须显式落一次（id 是主键，幂等）
    expect(appendCalls()).toHaveLength(1)
    expect(appendCalls()[0][1]).toMatchObject({ sessionId: SESSION_ID })
    expect((appendCalls()[0][1] as { messages: Message[] }).messages[0].id).toBe(
      'notice-1',
    )
  })

  it('尾部消息还没加载：只落库，不往空列表里塞（否则界面只剩孤零零一条）', () => {
    setTauriEnv(true)
    sessionStore.saveSession(makeSession(SESSION_ID))
    markMessagesNotLoaded(SESSION_ID)
    vi.mocked(invoke).mockClear()

    expect(handleServiceExit({ sessionId: SESSION_ID, message: noticeMessage('notice-2') })).toBe(true)

    expect(sessionStore.getSession(SESSION_ID)?.messages ?? []).toHaveLength(0)
    expect(appendCalls()).toHaveLength(1)
    expect((appendCalls()[0][1] as { messages: Message[] }).messages[0].id).toBe(
      'notice-2',
    )
  })

  it('载荷缺会话 id / 消息 → 直接忽略（不落库、不上屏）', () => {
    setTauriEnv(true)
    sessionStore.saveSession(makeSession(SESSION_ID))
    vi.mocked(invoke).mockClear()

    expect(handleServiceExit({ message: noticeMessage() })).toBe(false)
    expect(handleServiceExit({ sessionId: SESSION_ID })).toBe(false)
    expect(appendCalls()).toHaveLength(0)
  })

  it('监听只挂一次（重复初始化不会重复上屏）', async () => {
    setTauriEnv(true)
    const { listen } = await import('@tauri-apps/api/event')
    const listenMock = vi.mocked(listen)
    // 先确保已挂上（模块级一次性标志；前面的用例可能已经挂过）
    initServiceNotice()
    const installed = listenMock.mock.calls.length
    initServiceNotice()
    initServiceNotice()
    expect(listenMock.mock.calls.length).toBe(installed)

    // 且同一条通知只会落一遍（不会因重复初始化重复上屏）
    // ⚠️ 用独立会话 id：上一个用例故意把 SESSION_ID 标成了「消息未加载」
    sessionStore.saveSession(makeSession(SESSION_ONCE))
    vi.mocked(invoke).mockClear()
    const calls = listenMock.mock.calls
    const onExit = calls[calls.length - 1][1] as (e: {
      payload: unknown
    }) => void
    onExit({
      payload: { sessionId: SESSION_ONCE, message: noticeMessage('notice-3') },
    })
    expect(
      (sessionStore.getSession(SESSION_ONCE)?.messages ?? []).filter(
        (m) => m.id === 'notice-3',
      ),
    ).toHaveLength(1)
  })
})
