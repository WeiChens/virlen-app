/**
 * 回归（2026-10 真机反馈）：**电脑侧会话出的错，手机上必须看得到**。
 *
 * 现象：会话报错（API 401 / 上下文超限 / 工具炸了）时，手机只看到「工作中」变回空闲，
 * 错误原因一个字都没有 —— 用户只能回到电脑前才知道发生了什么。
 *
 * 根因是两个缺口，各占半边：
 * 1. **手机端**：`host.event.session.runtime.changed` 的处理器只取 `working / paused /
 *    compacting / toolProgress`，`runtime.error` 被静默丢掉（修在 `virlen-mobile`）；
 * 2. **电脑端（本文件）**：四条推送通道都只推「**变化**」，而订阅登记表
 *    （`SubscriptionRegistry`）是普通 Set（非 observable）——**订阅本身不触发 reaction**。
 *    于是「订阅那一刻的现值」永远到不了手机：出错时手机若没订阅（没打开这个会话 / 断线），
 *    事后打开也不会有任何提示（协议里没有 runtime 快照 RPC，`host.session.context` 是另一回事）。
 *
 * 修法：`host.session.subscribe` / `host.session.create` 之后补推一次运行时快照
 * （`storeBridge.pushRuntime`，报文形状与变化推送完全一致）。本文件钉住电脑侧这一半。
 *
 * ⚠️ 只 mock `chat-service`：引擎 / 持久化在单测里是噪音，而 store / store-bridge /
 * host-source / 分发胶水全部是真的 —— 所以这里「推得出去 / 推不出去」就是线上行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HostApi,
  type HostEvents,
} from 'virlen-remote'
import { startPhoneBridge } from '@/bridge'
import { getSessionRuntime, sessionRuntimeState, sessionStore, updateSessionRuntime } from '@/ui/store'
import type { Session } from '@/types'

vi.mock('@/services/chat-service', () => ({
  createSession: vi.fn(),
  deleteSessions: vi.fn(async () => 0),
  renameSession: vi.fn(() => true),
  setSessionPinned: vi.fn(() => true),
  activateSession: vi.fn(async () => null),
  cancelMessage: vi.fn(async () => undefined),
  getSessionMessages: vi.fn(() => []),
  sendMessage: vi.fn(async () => undefined),
  resumePausedRun: vi.fn(async () => undefined),
  MAX_SESSION_TITLE_LEN: 80,
}))

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等条件成立（内存传输的事件投递是异步的）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

function makeSession(id: string, title: string): Session {
  const now = Date.now()
  return {
    id,
    title,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: '',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
  }
}

type RuntimeEvent = HostEvents['host.event.session.runtime.changed']

function setup() {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, { deviceName: '测试电脑', deviceId: 'host-test' })
  return {
    caller: createCaller<HostApi>(mobileEp),
    sub: createSubscriber<HostEvents>(mobileEp),
    dispose: () => {
      bridge.dispose()
      hostEp.dispose()
      mobileEp.dispose()
      hostT.close()
      mobileT.close()
    },
  }
}

beforeEach(() => {
  sessionStore.clear()
  sessionRuntimeState.setValue('sessions', {})
})

afterEach(() => {
  sessionStore.clear()
  sessionRuntimeState.setValue('sessions', {})
})

describe('订阅时的运行时快照补发 —— 手机打开会话就要能看到错误', () => {
  it('订阅**之前**就出现的错误，订阅后立刻补到手机（修复前：一帧都没有）', async () => {
    sessionStore.saveSession(makeSession('s-snap-1', '出错会话'))
    const h = setup()
    // 电脑侧先出错。此刻手机还没订阅 → 这类推送被订阅门拦掉，属预期行为（不是缺陷）
    updateSessionRuntime('s-snap-1', { error: 'API Error (401)：凭证无效' })
    await flush()

    const events: RuntimeEvent[] = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => events.push(p))
    await h.caller.call('host.session.subscribe', { sessionId: 's-snap-1' })
    await waitFor(() => events.some((e) => e.sessionId === 's-snap-1' && e.runtime.error != null))

    const snapshot = events.find((e) => e.sessionId === 's-snap-1')!
    expect(snapshot.runtime.error).toBe('API Error (401)：凭证无效')
    expect(snapshot.runtime.working).toBe(false)
    h.dispose()
  })

  it('暂停态同样补得回来（打开会话应看到「继续」，而不是一个看不出问题的空闲会话）', async () => {
    sessionStore.saveSession(makeSession('s-snap-2', '暂停会话'))
    const h = setup()
    updateSessionRuntime('s-snap-2', { paused: true, working: true })
    await flush()

    const events: RuntimeEvent[] = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => events.push(p))
    await h.caller.call('host.session.subscribe', { sessionId: 's-snap-2' })
    await waitFor(() => events.some((e) => e.runtime.paused === true))

    expect(events[events.length - 1].sessionId).toBe('s-snap-2')
    h.dispose()
  })

  it('只补推被订阅的那条会话（未订阅的会话一个字节都不发）', async () => {
    sessionStore.saveSession(makeSession('s-snap-a', 'A'))
    sessionStore.saveSession(makeSession('s-snap-b', 'B'))
    const h = setup()
    // B 出错，但手机始终没订阅 B
    updateSessionRuntime('s-snap-b', { error: 'B 的错误' })
    const events: RuntimeEvent[] = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => events.push(p))
    await h.caller.call('host.session.subscribe', { sessionId: 's-snap-a' })
    await flush(30)

    expect(events.filter((e) => e.sessionId === 's-snap-b')).toHaveLength(0)
    h.dispose()
  })

  it('手机重新发消息 = 一次重试 → 电脑侧清掉上一条错误并推给手机（红条不会永远挂着）', async () => {
    sessionStore.saveSession(makeSession('s-snap-3', '重试会话'))
    const h = setup()
    updateSessionRuntime('s-snap-3', { error: 'API Error (500)：服务端错误' })
    const events: RuntimeEvent[] = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => events.push(p))
    await h.caller.call('host.session.subscribe', { sessionId: 's-snap-3' })
    await waitFor(() => events.some((e) => e.runtime.error != null))

    updateSessionRuntime('s-snap-3', { working: false })
    await h.caller.call('host.session.send', { sessionId: 's-snap-3', text: '再试一次' })
    await waitFor(() => events.some((e) => e.sessionId === 's-snap-3' && e.runtime.error == null))

    // 电脑侧权威状态：这条错误已经落下（手机侧据此清掉自己的缓存）
    expect(getSessionRuntime('s-snap-3').error).toBeNull()
    h.dispose()
  })
})
