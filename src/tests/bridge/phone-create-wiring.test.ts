/**
 * `host.session.create` 的**接线**测试（M4）。
 *
 * 为什么单独一个文件 + 模块 mock：真实 `createSession()` 需要默认 Agent（`getDefaultAgent()`
 * 在未初始化时会抛错）并要装配提示词（读工作目录 / 项目规则文件），在单测环境里跑起来是噪音而非证据。
 * 本文件只回答一个问题：**bridge 是否把手机请求正确地交给了服务层**（trim / 截断 / 返回值 / 审计）。
 * 会话自身的创建语义由 `services/chat/flow.ts` 负责，不在这里重复验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Endpoint, createCaller, createMemoryPair, type HostApi } from 'virlen-remote'
import { startPhoneBridge } from '@/bridge'
import { createSession } from '@/services/chat-service'
import { settingsState } from '@/ui/store'
import type { ProviderConfig } from '@/types'

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

const mockedCreate = vi.mocked(createSession)

function makeProvider(patch: Partial<ProviderConfig> & { id: string; models: string[] }): ProviderConfig {
  return {
    name: patch.id,
    templateName: 'custom',
    type: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://example.invalid',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as ProviderConfig
}

function setup() {
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
  settingsState.setValue('defaultWorkspace', '')
  settingsState.setValue('providers', [])
})

afterEach(() => {
  settingsState.setValue('defaultWorkspace', '')
  settingsState.setValue('providers', [])
})

describe('host.session.create —— 接线', () => {
  it('标题 trim 后交给服务层，返回 sessionId 并留痕', async () => {
    mockedCreate.mockResolvedValue({ id: 'new-1' } as never)
    const h = setup()
    const { sessionId } = await h.caller.call('host.session.create', { title: '  手机建的  ' })
    expect(sessionId).toBe('new-1')
    expect(mockedCreate).toHaveBeenCalledWith('手机建的', undefined, undefined, undefined, undefined)

    const entry = h.bridge.audit.list()[0]
    expect(entry).toMatchObject({ method: 'host.session.create', allowed: true, sessionId: 'new-1' })
    expect(entry.detail).toBe('手机建的')
    h.dispose()
  })

  it('不传标题 → 交给服务层空串（由服务层决定默认命名）', async () => {
    mockedCreate.mockResolvedValue({ id: 'new-2' } as never)
    const h = setup()
    await h.caller.call('host.session.create', {})
    expect(mockedCreate).toHaveBeenCalledWith('', undefined, undefined, undefined, undefined)
    h.dispose()
  })

  it('超长标题截断到上限（手机是第二个输入源，不能指望它的输入框限长）', async () => {
    mockedCreate.mockResolvedValue({ id: 'new-3' } as never)
    const h = setup()
    await h.caller.call('host.session.create', { title: 'x'.repeat(200) })
    const arg = mockedCreate.mock.calls[0][0] as unknown as string
    expect(arg).toHaveLength(80)
    h.dispose()
  })

  it('未授权能力 → E_DENIED，且**不会**触达服务层', async () => {
    const [hostT, mobileT] = createMemoryPair()
    const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
    const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
    const bridge = startPhoneBridge(hostEp, {
      deviceName: '测试电脑',
      deviceId: 'host-test',
      capabilities: ['session.list'],
    })
    const caller = createCaller<HostApi>(mobileEp)
    await expect(caller.call('host.session.create', { title: 'x' })).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    expect(mockedCreate).not.toHaveBeenCalled()
    bridge.dispose()
    hostEp.dispose()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
})

// ─────────── §22：新建会话的工作目录 / 模型（越权防线在电脑侧） ───────────

describe('host.session.create —— 工作目录与模型', () => {
  it('候选集内的目录：归一化后交给服务层（手机端传反斜杠也能匹配）', async () => {
    mockedCreate.mockResolvedValue({ id: 'new-ws' } as never)
    settingsState.setValue('defaultWorkspace', 'E:/code/app')
    const h = setup()
    await h.caller.call('host.session.create', { title: '带目录', workspace: 'E:\\code\\app\\' })
    expect(mockedCreate).toHaveBeenCalledWith('带目录', undefined, undefined, undefined, 'E:/code/app')
    h.dispose()
  })

  it('**越权**：目录不在候选集 → E_BAD_REQUEST + 留痕，且不触达服务层', async () => {
    const h = setup()
    await expect(
      h.caller.call('host.session.create', { title: '越权', workspace: 'C:/windows' }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(mockedCreate).not.toHaveBeenCalled()
    const entry = h.bridge.audit.list()[0]
    expect(entry).toMatchObject({ method: 'host.session.create', allowed: false })
    h.dispose()
  })

  it('模型与目录合法 → 透传给服务层', async () => {
    mockedCreate.mockResolvedValue({ id: 'new-model' } as never)
    settingsState.setValue('providers', [makeProvider({ id: 'p1', models: ['m1'] })])
    const h = setup()
    await h.caller.call('host.session.create', {
      title: '选模型',
      providerConfigId: 'p1',
      modelId: 'm1',
    })
    expect(mockedCreate).toHaveBeenCalledWith('选模型', 'p1', 'm1', undefined, undefined)
    h.dispose()
  })

  it('模型不成对 / 服务下没有该模型 → E_BAD_REQUEST', async () => {
    settingsState.setValue('providers', [makeProvider({ id: 'p1', models: ['m1'] })])
    const h = setup()
    await expect(
      h.caller.call('host.session.create', { providerConfigId: 'p1' }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    await expect(
      h.caller.call('host.session.create', { providerConfigId: 'p1', modelId: 'm9' }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(mockedCreate).not.toHaveBeenCalled()
    h.dispose()
  })
})
