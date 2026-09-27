/**
 * `host.session.resume` 的**接线**测试（M5）。
 *
 * 为什么单独一个文件 + 模块 mock：`resumePausedRun` 会拉起引擎循环（读 run 快照 / 组装请求），
 * 单测环境里跑它是噪音而非证据。本文件只回答一个问题：**bridge 是否把手机请求正确地交给了
 * 唯一的恢复入口**，以及失败是否如实回到了会话运行时（电脑端不再静默）。
 * 会话自身的恢复语义由 `services/chat/flow.ts` 负责，不在这里重复验证。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Endpoint, createCaller, createMemoryPair, type HostApi } from 'virlen-remote'
import { startPhoneBridge, type Capability } from '@/bridge'
import { resumePausedRun } from '@/services/chat-service'
import { getSessionRuntime, sessionStore } from '@/ui/store'
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

const mockedResume = vi.mocked(resumePausedRun)

function makeSession(id: string): Session {
  const now = Date.now()
  return {
    id,
    title: id,
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

function setup(capabilities?: Capability[]) {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-test',
    ...(capabilities ? { capabilities } : {}),
  })
  return {
    caller: createCaller<HostApi>(mobileEp),
    bridge,
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
  vi.clearAllMocks()
  sessionStore.clear()
})

describe('host.session.resume —— 接线', () => {
  it('转发给唯一恢复入口 resumePausedRun，返回 ok 并留痕', async () => {
    sessionStore.saveSession(makeSession('s-r-1'))
    const h = setup()
    const res = await h.caller.call('host.session.resume', { sessionId: 's-r-1' })
    expect(res).toEqual({ ok: true })
    expect(mockedResume).toHaveBeenCalledTimes(1)
    expect(mockedResume.mock.calls[0][0]).toBe('s-r-1')

    const entry = h.bridge.audit.list()[0]
    expect(entry).toMatchObject({ method: 'host.session.resume', allowed: true, sessionId: 's-r-1' })
    h.dispose()
  })

  it('会话不存在 → E_NOT_FOUND，且**不会**触达服务层', async () => {
    const h = setup()
    await expect(h.caller.call('host.session.resume', { sessionId: 'nope' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    expect(mockedResume).not.toHaveBeenCalled()
    h.dispose()
  })

  it('未授权能力 → E_DENIED，且不会触达服务层（能力集不是唯一防线，handler 各自 assert）', async () => {
    sessionStore.saveSession(makeSession('s-r-2'))
    const h = setup(['session.list'])
    await expect(h.caller.call('host.session.resume', { sessionId: 's-r-2' })).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    expect(mockedResume).not.toHaveBeenCalled()
    h.dispose()
  })

  it('恢复失败（无快照）→ 错误写回会话运行时（电脑端不再静默）', async () => {
    sessionStore.saveSession(makeSession('s-r-3'))
    mockedResume.mockImplementation((async (
      sid: string,
      events?: { onError?: (sid: string, message: string) => void },
    ) => {
      // 模拟真实 resumePausedRun 的失败上报路径
      events?.onError?.(sid, '没有可恢复的暂停任务')
    }) as never)
    const h = setup()
    await h.caller.call('host.session.resume', { sessionId: 's-r-3' })
    expect(getSessionRuntime('s-r-3').error).toBe('没有可恢复的暂停任务')
    h.dispose()
  })
})
