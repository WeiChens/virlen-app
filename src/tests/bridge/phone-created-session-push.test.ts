/**
 * 回归（2026-09-29 真机缺陷，§24）：**手机新建的会话，首条消息必须能被推回手机**。
 *
 * 缺陷现象（用户真机反馈）：新建会话 → 发第一条消息 → 会话**标题**变了（说明链路是通的），
 * 但消息列表永远是空的，也没有流式 / 「工作中」。
 *
 * 根因：电脑侧两条通道的过滤规则不同 ——
 * - `host.event.session.list.changed` **恒推**（所以标题能到手机）；
 * - `message.*` / `session.runtime.changed` / `session.context.changed` **只推「已订阅」的会话**
 *   （`store-bridge` 里的 `subscriptions.has(s.id)`），而手机端在「创建会话 → 发送」这条路径上
 *   **从未 subscribe**（只有 `openSession` 里订阅）→ 首条消息的推送全被订阅门拦掉。
 *
 * 本文件验证电脑侧的**兜底**：手机自建的会话直接纳入订阅集合 —— 这样即使手机端某条路径漏了
 * subscribe（或手机上还是缓存里的旧 PWA），首条消息也不会静默丢失。
 *
 * ⚠️ 只 mock `createSession`（真实实现需要默认 Agent + 提示词装配，在单测里是噪音）：
 * store / store-bridge / host-source / 分发胶水全部是真的，所以这里「推得出去 / 推不出去」
 * 就是线上行为。
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
import { sessionRuntimeState, sessionStore, updateSessionRuntime } from '@/ui/store'
import { addSessionMessage } from '@/services/chat-service'
import type { Session } from '@/types'

/** `createSession` 桩返回的会话 id（测试里先把这条会话塞进 store，模拟它已落库）。 */
const CREATED_ID = 'phone-new-1'

vi.mock('@/services/chat-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/chat-service')>()
  return {
    ...actual,
    // 本文件只关心「创建之后推得到推不到」；创建语义本身由 flow 层负责
    createSession: vi.fn(async () => ({ id: 'phone-new-1' }) as never),
  }
})

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeSession(id: string, title: string): Session {
  const now = Date.now()
  return {
    id,
    title,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'SECRET',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
  }
}

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

describe('§24 —— 手机新建的会话：推送必须可达', () => {
  it('创建后**无需再 subscribe**：该会话的消息 / 运行时变化都能推到手机', async () => {
    // 模拟「创建会话」在电脑侧真的落库了那条会话（真实装配由 flow 层完成）
    sessionStore.saveSession(makeSession(CREATED_ID, '手机新建的会话'))

    const h = setup()
    const { sessionId } = await h.caller.call('host.session.create', { title: '手机新建的会话' })
    expect(sessionId).toBe(CREATED_ID)

    // 只订阅事件主题，**不**调 `host.session.subscribe` —— 这正是手机端出缺陷时的行为
    const added: Array<HostEvents['host.event.message.added']> = []
    const runtimes: Array<HostEvents['host.event.session.runtime.changed']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))
    h.sub.subscribe('host.event.session.runtime.changed', (p) => runtimes.push(p))

    addSessionMessage(CREATED_ID, { id: 'u1', role: 'user', content: '第一条消息', timestamp: Date.now() })
    updateSessionRuntime(CREATED_ID, { working: true })
    await flush()

    // 修复前：这里是 0 —— 首条消息被订阅门拦掉，手机端表现为「这个会话没有任何记录」
    expect(added.map((e) => e.message.id)).toContain('u1')
    expect(runtimes.some((e) => e.runtime.working)).toBe(true)

    h.dispose()
  })
})
