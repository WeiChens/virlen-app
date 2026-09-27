/**
 * `host.session.compress` —— **接线与三道闸**（§22）。
 *
 * 为什么单独一个文件 + 模块 mock：真实 `compressContext()` 会拉起 Rust 引擎（`cmd_compress_context`）
 * 并落库，在单测环境里跑起来是噪音而不是证据。本文件只回答三个问题：
 *
 * 1. **不可逆操作必须二次确认**：`confirm !== true` 时拒且**不触达服务层**（手机 UI 的确认不算数）；
 * 2. **与桌面 token 环同判据**：占用未达 `COMPRESS_MIN_RATIO` 时拒（不是另立一套标准）；
 * 3. **并发保护**：正在回复 → `E_BUSY`。
 *
 * 压缩本身的语义（摘要怎么写、消息怎么替换）由 `services/chat/flow.ts` 与引擎负责，不在这里重复验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Endpoint, createCaller, createMemoryPair, type HostApi } from 'virlen-remote'
import { startPhoneBridge, type PhoneBridge } from '@/bridge'
import { compressContext, getSessionMessages } from '@/services/chat-service'
import { sessionStore, settingsState, updateSessionRuntime } from '@/ui/store'
import type { Message, Session } from '@/types'

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
  compressContext: vi.fn(async () => undefined),
  MAX_SESSION_TITLE_LEN: 80,
}))

const mockedCompress = vi.mocked(compressContext)
const mockedMessages = vi.mocked(getSessionMessages)

const DEFAULT_WINDOW = 200_000

function makeSession(id: string, title: string): Session {
  const now = Date.now()
  return {
    id,
    title,
    messages: [],
    providerConfigId: 'p1',
    modelId: 'm1',
    systemPrompt: 'SP',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
  }
}

function usageMessage(tokens: number): Message {
  return {
    id: 'a-usage',
    role: 'assistant',
    content: 'hi',
    timestamp: Date.now(),
    usage: { promptTokens: tokens - 100, completionTokens: 100, totalTokens: tokens },
  }
}

function setup(): { caller: ReturnType<typeof createCaller<HostApi>>; bridge: PhoneBridge; dispose(): void } {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, { deviceName: '测试电脑', deviceId: 'host-test' })
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
  sessionStore.saveSession(makeSession('s-c', '压缩'))
  settingsState.setValue('contextWindowTokens', DEFAULT_WINDOW)
})

afterEach(() => {
  sessionStore.clear()
  settingsState.setValue('contextWindowTokens', DEFAULT_WINDOW)
})

describe('host.session.compress —— 三道闸', () => {
  it('缺 confirm → E_CONFIRM_REQUIRED + 留痕，且**不触达**服务层', async () => {
    mockedMessages.mockReturnValue([usageMessage(DEFAULT_WINDOW * 0.9)])
    const h = setup()
    // 绕过手机端类型（raw 调用）：服务端必须独立校验，不能依赖客户端传了 confirm
    await expect(
      (h.caller.call as unknown as (m: string, p: unknown) => Promise<unknown>)(
        'host.session.compress',
        { sessionId: 's-c' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIRM_REQUIRED' })
    expect(mockedCompress).not.toHaveBeenCalled()
    expect(h.bridge.audit.list()[0]).toMatchObject({
      method: 'host.session.compress',
      allowed: false,
      sessionId: 's-c',
    })
    h.dispose()
  })

  it('占用充裕（未达 40%）→ E_BAD_REQUEST，不折腾历史（与桌面 token 环同判据）', async () => {
    mockedMessages.mockReturnValue([usageMessage(1_000)])
    const h = setup()
    await expect(
      h.caller.call('host.session.compress', { sessionId: 's-c', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(mockedCompress).not.toHaveBeenCalled()
    h.dispose()
  })

  it('正在回复 → E_BUSY（压缩会整体替换历史，不能在生成中动手）', async () => {
    mockedMessages.mockReturnValue([usageMessage(DEFAULT_WINDOW * 0.9)])
    updateSessionRuntime('s-c', { working: true })
    const h = setup()
    await expect(
      h.caller.call('host.session.compress', { sessionId: 's-c', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_BUSY' })
    expect(mockedCompress).not.toHaveBeenCalled()
    updateSessionRuntime('s-c', { working: false })
    h.dispose()
  })

  it('占用达标 + 已确认 → 交给压缩服务层（fire-and-forget，立即回投递确认）', async () => {
    mockedMessages.mockReturnValue([usageMessage(DEFAULT_WINDOW * 0.9)])
    const h = setup()
    await expect(
      h.caller.call('host.session.compress', { sessionId: 's-c', confirm: true }),
    ).resolves.toEqual({ ok: true })
    expect(mockedCompress).toHaveBeenCalledTimes(1)
    expect(mockedCompress).toHaveBeenCalledWith('s-c')
    expect(h.bridge.audit.list()[0]).toMatchObject({
      method: 'host.session.compress',
      allowed: true,
      sessionId: 's-c',
    })
    h.dispose()
  })

  it('未授权能力 → E_DENIED，且不触达服务层', async () => {
    mockedMessages.mockReturnValue([usageMessage(DEFAULT_WINDOW * 0.9)])
    const [hostT, mobileT] = createMemoryPair()
    const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
    const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
    const bridge = startPhoneBridge(hostEp, {
      deviceName: '测试电脑',
      deviceId: 'host-test',
      capabilities: ['session.list'],
    })
    const caller = createCaller<HostApi>(mobileEp)
    await expect(
      caller.call('host.session.compress', { sessionId: 's-c', confirm: true }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
    expect(mockedCompress).not.toHaveBeenCalled()
    bridge.dispose()
    hostEp.dispose()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
})
