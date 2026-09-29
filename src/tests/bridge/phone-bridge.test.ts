/**
 * 电脑侧 bridge 集成测试（M2-3）。
 *
 * 覆盖「真实 bridge 代码 + memory transport」的端到端：不依赖 WebRTC / Tauri，
 * 直接把手机 RPC 打到本机 `sessionStore`，并验证 store-bridge 的事件推送。
 *
 * 覆盖点：hello 令牌校验（成功 / 拒绝）· 列表投影 · 订阅后消息推送 ·
 * 运行时 / 流式推送 · `send` 的 `E_BUSY` / `E_NOT_FOUND` · ACL 默认拒绝 · 审计留痕。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeError,
  Endpoint,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HostApi,
  type HostEvents,
} from 'virlen-remote'
import { startPhoneBridge, type PhoneBridge } from '@/bridge'
import type { Capability } from '@/bridge'
import { getSessionRuntime, sessionRuntimeState, sessionStore, settingsState, updateSessionRuntime } from '@/ui/store'
import {
  addSessionMessage,
  deleteSessionMessage,
  getSessionMessages,
  replaceSessionMessages,
  updateSessionMessage,
} from '@/services/chat-service'
import toolInteractEvent from '@/events/toolInteractEvent'
import { toolOutputStore } from '@/infrastructure/tools/output-store'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import type { Message, ProviderConfig, Session } from '@/types'
import type { InteractionDTO } from 'virlen-remote'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等条件成立（内存传输的事件投递是异步的）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

interface Harness {
  caller: ReturnType<typeof createCaller<HostApi>>
  sub: ReturnType<typeof createSubscriber<HostEvents>>
  /** 末经类型包装的“手机”端点（用于验证**绕过手机 UI 类型**的调用也被拦，如缺 confirm） */
  raw: Endpoint
  bridge: PhoneBridge
  deviceToken: string
  /** 本台「手机」设备 id（用于 revoke；注意 `hello.deviceId` 是电脑自己的标识）。 */
  deviceId: string
}

const cleanups: Array<() => void> = []

function setup(capabilities?: Capability[], notify?: (text: string) => void): Harness {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-test',
    capabilities,
    ...(notify ? { notify } : {}),
  })
  const device = bridge.pairing.register('测试手机')
  cleanups.push(() => {
    bridge.dispose()
    hostEp.dispose()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
  return {
    caller: createCaller<HostApi>(mobileEp),
    sub: createSubscriber<HostEvents>(mobileEp),
    raw: mobileEp,
    bridge,
    deviceToken: device.token,
    deviceId: device.deviceId,
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
    systemPrompt: 'SECRET-SYSTEM-PROMPT',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    workspace: 'C:/secret/workspace',
  }
}

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

const helloParams = (token?: string) => ({
  protocolVersion: 1,
  client: { platform: 'test', appVersion: '0' },
  capabilities: ['session.list', 'session.send'],
  mobileKey: 'mk-3333333333333333',
  mobileName: '测试手机',
  ...(token ? { token } : {}),
})

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
})

// ───────────────────────────── hello / 配对 ─────────────────────────────

describe('host.hello —— 配对校验', () => {
  it('合法令牌 → 返回设备名 / capabilities', async () => {
    const h = setup()
    const hello = await h.caller.call('host.hello', helloParams(h.deviceToken))
    expect(hello.deviceName).toBe('测试电脑')
    expect(hello.deviceId).toBe('host-test')
    expect(hello.paired).toBe(true)
    expect(hello.capabilities).toContain('session.send')
  })

  it('缺少令牌 → E_DENIED', async () => {
    const h = setup()
    await expect(h.caller.call('host.hello', helloParams())).rejects.toMatchObject({ code: 'E_DENIED' })
  })

  it('无效令牌 → E_DENIED', async () => {
    const h = setup()
    await expect(h.caller.call('host.hello', helloParams('bad-token'))).rejects.toMatchObject({
      code: 'E_DENIED',
    })
  })

  it('扫码票据 → 一次性兑换为**授权凭证**；之后凭凭证直连（M6：票据不可重用）', async () => {
    const h = setup()
    const ticket = h.bridge.pairing.issueTicket()
    const first = await h.caller.call('host.hello', helloParams(ticket))
    expect(first.paired).toBe(true)
    expect(first.grant?.token).toMatch(/^gt-/)
    // 票据是一次性的：拿同一张票再来 → 拒（旧版「票据即令牌」的简化已取消）
    await expect(h.caller.call('host.hello', helloParams(ticket))).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    // 手机端真正存的是凭证 → 可反复直连，且每次都会刷新到期时间
    const second = await h.caller.call('host.hello', helloParams(first.grant!.token))
    expect(second.paired).toBe(true)
    expect(second.grant?.token).toBe(first.grant!.token)
  })

  it('设备被移除 → E_DENIED', async () => {
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    h.bridge.pairing.revoke(h.deviceId)
    await expect(h.caller.call('host.hello', helloParams(h.deviceToken))).rejects.toMatchObject({
      code: 'E_DENIED',
    })
  })
})

// ───────────────────────────── 列表 / 投影 ─────────────────────────────

describe('host.session.list —— 白名单投影', () => {
  beforeEach(() => {
    sessionStore.saveSession(makeSession('s-list-1', '会话一'))
    sessionStore.saveSession(makeSession('s-list-2', '会话二'))
  })

  it('只含白名单字段：systemPrompt / params / apiKey 一律不外发；期望字段集合变动时必须显式改这里', async () => {
    const h = setup()
    const { sessions } = await h.caller.call('host.session.list', {})
    expect(sessions).toHaveLength(2)
    const s = sessions.find((x) => x.id === 's-list-1')!
    expect(s.title).toBe('会话一')
    expect(s).toMatchObject({
      id: 's-list-1',
      pinned: false,
      working: false,
      providerConfigId: 'p1',
      modelId: 'm1',
      // ⚠️ 工作目录是 §22 对 §7-⑥ 的**有意放宽**（抽屉分组 + 新建会话选目录要用）。
      //    越权防线相应地在电脑侧：`host.session.create` 只接受候选集内的目录
      //    （见 phone-create-wiring.test.ts 的越权用例）。
      workspace: 'C:/secret/workspace',
    })
    // 字段集合钉死：新增字段必须显式改这里（防「不小心多带」）
    expect(Object.keys(s).sort()).toEqual([
      'id',
      'modelId',
      'pinned',
      'providerConfigId',
      'title',
      'updatedAt',
      'working',
      'workspace',
    ])
    const json = JSON.stringify(s)
    expect(json).not.toContain('SECRET')
    expect(json).not.toContain('systemPrompt')
    expect(json).not.toContain('apiKey')
    expect(json).not.toContain('allowedTools')
  })

  it('working 反映运行时状态', async () => {
    const h = setup()
    updateSessionRuntime('s-list-1', { working: true })
    const { sessions } = await h.caller.call('host.session.list', {})
    expect(sessions.find((x) => x.id === 's-list-1')!.working).toBe(true)
  })
})

// ───────────────────────────── 事件推送 ─────────────────────────────

describe('store-bridge —— 事件推送', () => {
  it('订阅后新增消息 → message.added', async () => {
    sessionStore.saveSession(makeSession('s-push-1', '推送'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-push-1' })

    const added: Array<HostEvents['host.event.message.added']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))

    addSessionMessage('s-push-1', { id: 'u1', role: 'user', content: '你好', timestamp: Date.now() })
    await flush()
    expect(added.map((e) => e.message.id)).toContain('u1')
    expect(added[0].message.text).toBe('你好')
  })

  it('未订阅的会话不推消息', async () => {
    sessionStore.saveSession(makeSession('s-push-2', '未订阅'))
    const h = setup()
    const added: unknown[] = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))
    addSessionMessage('s-push-2', { id: 'u2', role: 'user', content: 'hi', timestamp: Date.now() })
    await flush()
    expect(added).toHaveLength(0)
  })

  it('运行时变化 → runtime.changed', async () => {
    sessionStore.saveSession(makeSession('s-rt-1', '运行时'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-rt-1' })
    const events: Array<HostEvents['host.event.session.runtime.changed']> = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => events.push(p))
    updateSessionRuntime('s-rt-1', { working: true })
    await flush()
    expect(events.some((e) => e.runtime.working)).toBe(true)
  })

  /**
   * ⚠️ 回归测试（2026-09-28 真机缺陷，§22.4）：
   *
   * 数据源是 store 里 `streaming === true` 的那条消息，而不是 `runtime.streamingMessageId`。
   * 真实 Rust 引擎的 `stream_event` **不带 messageId**（`llm_round.rs::flush_stream_state`），
   * 而 event-handler 过去会据此把 `streamingMessageId` 写成 null → 流式帧一帧都发不出去，
   * 手机端只剩「工作中…」的加载态。故这里按**真实引擎的事件序列**驱动
   * （建消息 → 增量拼正文 → 定稿），而不是直接改运行时字段。
   */
  it('流式：正在生成的消息走 stream 通道（**未声明 streamMode → 每帧整段**，旧行为）', async () => {
    sessionStore.saveSession(makeSession('s-stream-1', '流式'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-stream-1' })
    const events: Array<HostEvents['host.event.message.stream']> = []
    h.sub.subscribe('host.event.message.stream', (p) => events.push(p))

    addSessionMessage('s-stream-1', {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    })
    await flush()
    updateSessionMessage('s-stream-1', 'a1', { content: '你' })
    await flush()
    updateSessionMessage('s-stream-1', 'a1', { content: '你好' })
    await flush()
    // 定稿：streaming 翻 false（等价于引擎的 `finalize_assistant_message`）
    updateSessionMessage('s-stream-1', 'a1', { content: '你好，世界', streaming: false })
    await waitFor(() => events.some((e) => e.final))

    expect(events[0].mode).toBe('full')
    expect(events[0].messageId).toBe('a1')
    // 未声明偏好 → 一帧 delta 都不该发（旧客户端会把增量当全文渲染，正文就错位了）
    expect(events.every((e) => e.mode === 'full')).toBe(true)
    expect(events.every((e) => e.offset === undefined)).toBe(true)
    // 逐帧递增的正文（手机端直接显示，不需要自己拼）
    expect(events.map((e) => e.text)).toEqual(['', '你', '你好', '你好，世界'])
    expect(events[1].seq).toBeGreaterThan(events[0].seq)
    const last = events[events.length - 1]
    expect(last.final).toBe(true)
    expect(last.text).toBe('你好，世界')
  })

  it('流式期间**不发** message.added（定稿后才补完整消息，消息通道天然幂等）', async () => {
    sessionStore.saveSession(makeSession('s-stream-2', '流式幂等'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-stream-2' })
    const added: Array<HostEvents['host.event.message.added']> = []
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))

    addSessionMessage('s-stream-2', {
      id: 'a2',
      role: 'assistant',
      content: '半截',
      timestamp: Date.now(),
      streaming: true,
    })
    await flush()
    expect(added).toHaveLength(0)

    updateSessionMessage('s-stream-2', 'a2', { content: '完整正文', streaming: false })
    await waitFor(() => added.length > 0)
    expect(added[added.length - 1].message.text).toBe('完整正文')
  })

  /**
   * §32：增量流式（声明 `streamMode:'delta'` 之后的形态）。
   *
   * 带宽账：一条 n 字的回复，整帧发是 O(n²) 字节（每帧都把已有全文再传一遍），
   * 增量发是 O(n)。真机上「长回复越到后面越卡」的观感就来自前者。
   */
  it('流式增量：声明 delta → 首帧整段 + 后续 offset 递增的增量，final 回整段', async () => {
    sessionStore.saveSession(makeSession('s-stream-delta', '增量'))
    const h = setup()
    // 偏好只能在握手时声明（与真实手机一致：`connectionStore` 在 hello 里带它）
    await h.caller.call('host.hello', { ...helloParams(h.deviceToken), streamMode: 'delta' })
    await h.caller.call('host.session.subscribe', { sessionId: 's-stream-delta' })
    const events: Array<HostEvents['host.event.message.stream']> = []
    h.sub.subscribe('host.event.message.stream', (p) => events.push(p))

    addSessionMessage('s-stream-delta', {
      id: 'd1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    })
    await flush()
    updateSessionMessage('s-stream-delta', 'd1', { content: '你' })
    await flush()
    updateSessionMessage('s-stream-delta', 'd1', { content: '你好' })
    await flush()
    updateSessionMessage('s-stream-delta', 'd1', { content: '你好，世界' })
    await flush()
    // 定稿：正文不变，只把 streaming 翻 false（引擎的 `finalize_assistant_message`）
    updateSessionMessage('s-stream-delta', 'd1', { content: '你好，世界', streaming: false })
    await waitFor(() => events.some((e) => e.final))

    // 首帧必须整段（客户端没有任何基准），中间只发后缀，收尾帧回整段
    expect(events.map((e) => [e.mode, e.text])).toEqual([
      ['full', ''],
      ['delta', '你'],
      ['delta', '好'],
      ['delta', '，世界'],
      ['full', '你好，世界'],
    ])
    // offset = 本段之前的长度（客户端靠它剪重复 / 补尾巴 / 发现缺口）
    expect(events.map((e) => e.offset)).toEqual([undefined, 0, 1, 2, undefined])
    // seq 单调递增（同一消息内从 1 起）
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    // 增量拼起来 = 定稿正文（这条恒等式就是协议要求的全部）
    expect(events.slice(0, 4).reduce((acc, e) => acc + e.text, '')).toBe(events[4].text)
    /*
     * ⚠️ 但**不能反过来假设定稿正文一定由增量拼得出来**：
     * 若最后一波增长与定稿是同一次 store 变更（上面若把 '你好，世界' 与 `streaming:false` 一步写完），
     * 那就没有对应的增量帧，收尾帧的 `text` 会比拼出来的长。
     * 这正是收尾帧必须是**整段**而不是「最后一个增量」的原因 ——
     * 客户端以它（及随后的 `message.added`）为准。
     */
  })

  it('流式增量：正文被改写（非前缀增长）→ 回落整段，之后的增量重新接上', async () => {
    sessionStore.saveSession(makeSession('s-stream-rewrite', '改写'))
    const h = setup()
    await h.caller.call('host.hello', { ...helloParams(h.deviceToken), streamMode: 'delta' })
    await h.caller.call('host.session.subscribe', { sessionId: 's-stream-rewrite' })
    const events: Array<HostEvents['host.event.message.stream']> = []
    h.sub.subscribe('host.event.message.stream', (p) => events.push(p))

    addSessionMessage('s-stream-rewrite', {
      id: 'r1',
      role: 'assistant',
      content: '你',
      timestamp: Date.now(),
      streaming: true,
    })
    await flush()
    // 修复 / 回填路径会**改写**正文（新正文不是旧正文的前缀）——
    // 此时按增量算出来的「后缀」是错的，必须整段重发
    updateSessionMessage('s-stream-rewrite', 'r1', { content: 'X好' })
    await flush()
    // 改写之后又能正常增量
    updateSessionMessage('s-stream-rewrite', 'r1', { content: 'X好的' })
    await flush()

    expect(events.map((e) => [e.mode, e.text])).toEqual([
      ['full', '你'],
      ['full', 'X好'],
      ['delta', '的'],
    ])
    expect(events[2].offset).toBe(2)
  })

  it('流式增量：重新订阅 → 下一帧回到整段（基准是「某个客户端」的，换人就归零）', async () => {
    sessionStore.saveSession(makeSession('s-stream-resub', '重订阅'))
    const h = setup()
    await h.caller.call('host.hello', { ...helloParams(h.deviceToken), streamMode: 'delta' })
    await h.caller.call('host.session.subscribe', { sessionId: 's-stream-resub' })
    const events: Array<HostEvents['host.event.message.stream']> = []
    h.sub.subscribe('host.event.message.stream', (p) => events.push(p))

    addSessionMessage('s-stream-resub', {
      id: 'p1',
      role: 'assistant',
      content: '你好',
      timestamp: Date.now(),
      streaming: true,
    })
    await flush()
    expect(events.map((e) => e.mode)).toEqual(['full'])

    // 切走再切回 / 重连后重新订阅：手机手上没有正文了 → 必须以整段重启
    await h.caller.call('host.session.subscribe', { sessionId: 's-stream-resub' })
    updateSessionMessage('s-stream-resub', 'p1', { content: '你好呀' })
    await flush()

    expect(events[events.length - 1].mode).toBe('full')
    expect(events[events.length - 1].text).toBe('你好呀')
  })
})

// ───────────────────────────── 写操作保护 ─────────────────────────────

describe('host.session.send —— 保护与拒绝', () => {
  it('会话工作中 → E_BUSY', async () => {
    sessionStore.saveSession(makeSession('s-busy', '忙'))
    const h = setup()
    updateSessionRuntime('s-busy', { working: true })
    await expect(
      h.caller.call('host.session.send', { sessionId: 's-busy', text: 'x' }),
    ).rejects.toMatchObject({ code: 'E_BUSY' })
  })

  it('桌面端正在本地识别图片（preparing）→ E_BUSY（不让手机插进来起第二个 run）', async () => {
    // 桌面点下发送后、引擎开跑前有一段本地准备（图片视觉分析）。
    // 那一次发送**已经在途**，手机不能在这时插进来。
    sessionStore.saveSession(makeSession('s-prep-busy', '准备中'))
    const h = setup()
    updateSessionRuntime('s-prep-busy', { preparing: true })
    await expect(
      h.caller.call('host.session.send', { sessionId: 's-prep-busy', text: 'x' }),
    ).rejects.toMatchObject({ code: 'E_BUSY' })
    updateSessionRuntime('s-prep-busy', { preparing: false })
  })

  it('会话不存在 → E_NOT_FOUND', async () => {
    const h = setup()
    await expect(
      h.caller.call('host.session.send', { sessionId: 'nope', text: 'x' }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })

  it('订阅不存在的会话 → E_NOT_FOUND', async () => {
    const h = setup()
    await expect(
      h.caller.call('host.session.subscribe', { sessionId: 'nope' }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })
})

// ───────────────────────────── ACL / 审计 ─────────────────────────────

describe('ACL 与审计', () => {
  it('未授权能力 → E_DENIED（默认拒绝）', async () => {
    sessionStore.saveSession(makeSession('s-acl', 'ACL'))
    const h = setup(['session.list']) // 不含 session.send
    await expect(
      h.caller.call('host.session.send', { sessionId: 's-acl', text: 'x' }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
  })

  it('hello capabilities 来自 ACL', async () => {
    const h = setup(['session.list'])
    const hello = await h.caller.call('host.hello', helloParams(h.deviceToken))
    expect(hello.capabilities).toEqual(['session.list'])
  })

  it('被拒绝的 hello 会留痕（allowed=false）', async () => {
    const h = setup()
    await expect(h.caller.call('host.hello', helloParams('bad'))).rejects.toBeInstanceOf(BridgeError)
    const entries = h.bridge.audit.list()
    expect(entries.some((e) => e.method === 'host.hello' && e.allowed === false)).toBe(true)
  })

  it('放行的写操作留痕（allowed=true）', async () => {
    sessionStore.saveSession(makeSession('s-audit', '审计'))
    const h = setup()
    await h.caller.call('host.session.cancel', { sessionId: 's-audit' })
    expect(h.bridge.audit.list().some((e) => e.method === 'host.session.cancel' && e.allowed)).toBe(
      true,
    )
  })
})

// ───────────────────────────── M4：会话写操作 ─────────────────────────────

describe('M4 会话写操作', () => {
  it('重命名（trim）+ 置顶：投影带 pinned；空标题 → E_BAD_REQUEST', async () => {
    sessionStore.saveSession(makeSession('s-w-1', '旧名'))
    const h = setup()
    const pushed: number[] = []
    h.sub.subscribe('host.event.session.list.changed', (e) => pushed.push(e.sessions.length))

    await h.caller.call('host.session.rename', { sessionId: 's-w-1', title: '  新名  ' })
    expect(sessionStore.getSession('s-w-1')!.title).toBe('新名')

    await h.caller.call('host.session.pin', { sessionId: 's-w-1', pinned: true })
    expect(sessionStore.getSession('s-w-1')!.pinned).toBe(true)
    const { sessions } = await h.caller.call('host.session.list', {})
    expect(sessions.find((s) => s.id === 's-w-1')!.pinned).toBe(true)

    await expect(
      h.caller.call('host.session.rename', { sessionId: 's-w-1', title: '   ' }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(sessionStore.getSession('s-w-1')!.title).toBe('新名')

    // 写操作必须触发列表推送（手机不做乐观更新）
    await waitFor(() => pushed.length >= 2)
  })

  it('删除：缺 confirm → E_CONFIRM_REQUIRED（服务端独立校验）；带 confirm → 删除 + 审计', async () => {
    sessionStore.saveSession(makeSession('s-w-2', '要删的'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-w-2' })

    // 绕开手机 UI 类型断言直接调（如“手机端漏改而没带 confirm”）
    await expect(
      h.raw.call('host.session.delete', { sessionId: 's-w-2' }),
    ).rejects.toMatchObject({ code: 'E_CONFIRM_REQUIRED' })
    expect(sessionStore.getSession('s-w-2')).toBeTruthy()

    await h.caller.call('host.session.delete', { sessionId: 's-w-2', confirm: true })
    expect(sessionStore.getSession('s-w-2')).toBeUndefined()

    const entries = h.bridge.audit.list()
    expect(entries.some((e) => e.method === 'host.session.delete' && !e.allowed)).toBe(true)
    expect(entries.some((e) => e.method === 'host.session.delete' && e.allowed)).toBe(true)
  })

  it('未知会话 → E_NOT_FOUND（重命名 / 置顶）', async () => {
    const h = setup()
    await expect(
      h.caller.call('host.session.rename', { sessionId: 'nope', title: 'x' }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await expect(
      h.caller.call('host.session.pin', { sessionId: 'nope', pinned: true }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })
})

// ───────────────────────────── M4：交互应答（分级 / 独立校验） ─────────────────────────────

describe('M4 交互应答', () => {
  const authDefaults = {
    sessionId: 's-i-1',
    toolCallId: 'tc-1',
    permName: 'terminal.normal.execute',
    title: '执行命令',
    subTitle: '查看状态',
    desc: 'git status',
    risk: 'safe',
  }

  it('低风险：手机「允许」→ 走电脑侧原有事件（commandResolve）+ 终态广播 + 审批审计', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const h = setup()
    const resolvedLocal: string[] = []
    const off = toolInteractEvent.on('commandResolve', (id) => resolvedLocal.push(id))
    const requested: InteractionDTO[] = []
    const resolvedWire: Array<HostEvents['host.event.interaction.resolved']> = []
    h.sub.subscribe('host.event.interaction.requested', (e) => requested.push(e.interaction))
    h.sub.subscribe('host.event.interaction.resolved', (e) => resolvedWire.push(e))

    toolInteractEvent.emit('showAuthorization', { interactionId: 'it-low', ...authDefaults })
    await waitFor(() => requested.length === 1)
    expect(requested[0]).toMatchObject({ interactionId: 'it-low', kind: 'authorization', tier: 'low' })

    const result = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-low',
      action: 'allow',
    })
    expect(result.accepted).toBe(true)
    expect(resolvedLocal).toEqual(['it-low'])

    await waitFor(() => resolvedWire.length === 1)
    expect(resolvedWire[0]).toMatchObject({ interactionId: 'it-low', by: 'mobile', outcome: 'allow' })
    const audit = h.bridge.audit.list()[0]
    expect(audit).toMatchObject({
      kind: 'approval',
      by: 'mobile',
      decision: 'allow',
      tier: 'low',
      allowed: true,
      commandPreview: 'git status',
    })
    off()
  })

  it('高风险：缺 confirmed → confirm-required（卡片不失效）；补 marked → 放行 + 桌面通知', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const notified: string[] = []
    const h = setup(undefined, (text) => notified.push(text))
    const off = toolInteractEvent.on('commandResolve', () => {})

    // 沙盒脱壳 → 恒为高风险（§16.2）
    toolInteractEvent.emit('showAuthorization', {
      interactionId: 'it-high',
      ...authDefaults,
      permName: 'sandbox.command.execute',
      sandboxBypass: true,
      desc: 'pnpm vitest run',
    })
    await flush()

    const denied = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-high',
      action: 'allow',
    })
    expect(denied).toMatchObject({ accepted: false, reason: 'confirm-required' })
    // 仍是待应答（用户还可以走二次确认）
    expect(h.bridge.interactions.has('it-high')).toBe(true)
    expect(notified).toHaveLength(0)

    const ok = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-high',
      action: 'allow',
      confirmed: true,
    })
    expect(ok.accepted).toBe(true)
    expect(h.bridge.interactions.has('it-high')).toBe(false)
    expect(notified[0]).toContain('高风险')

    const audit = h.bridge.audit.list()[0]
    expect(audit).toMatchObject({ tier: 'high', decision: 'allow', by: 'mobile' })
    off()
  })

  it('电脑侧先应答 → 手机再答返回 already-settled，并向手机广播 expired', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const h = setup()
    const resolvedWire: Array<HostEvents['host.event.interaction.resolved']> = []
    h.sub.subscribe('host.event.interaction.resolved', (e) => resolvedWire.push(e))

    toolInteractEvent.emit('showAuthorization', { interactionId: 'it-race', ...authDefaults })
    await flush()
    // 模拟电脑上用户自己点「允许」：工具层广播终态
    toolInteractEvent.emit('interactionSettled', 'it-race', 'allow')
    await waitFor(() => resolvedWire.length === 1)
    expect(resolvedWire[0]).toMatchObject({ by: 'host', outcome: 'allow' })

    const late = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-race',
      action: 'deny',
    })
    expect(late).toMatchObject({ accepted: false, reason: 'not-found' })
  })

  it('AI 提问：手机选择 → 与桌面同形的 resolve 载荷（含 uiData）', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const h = setup()
    const got: Array<{ id: string; value: unknown }> = []
    const off = toolInteractEvent.on('resolve', (id, value) => got.push({ id, value }))

    toolInteractEvent.emit('showChoice', {
      interactionId: 'it-choice',
      sessionId: 's-i-1',
      toolCallId: 'tc-c',
      question: '选哪个？',
      options: ['A', 'B'],
      multi: false,
    })
    await flush()

    const result = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-choice',
      action: 'choose',
      value: { selected: ['B'], customReply: '顺便看下日志' },
    })
    expect(result.accepted).toBe(true)
    expect(got).toHaveLength(1)
    expect(got[0].value).toEqual({
      content: 'B；顺便看下日志',
      uiData: { selected: ['B'], customReply: '顺便看下日志' },
    })
    off()
  })

  it('AI 提问 + 「取消」(deny) → 电脑侧收到与桌面同形的 reject（真机反馈修复）', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const h = setup()
    const rejected: Array<{ id: string; reason: string }> = []
    const off = toolInteractEvent.on('reject', (id, reason) => rejected.push({ id, reason }))

    toolInteractEvent.emit('showChoice', {
      interactionId: 'it-cancel',
      sessionId: 's-i-1',
      toolCallId: 'tc-x',
      question: '选哪个？',
      options: ['A'],
      multi: false,
    })
    await flush()

    // 修复前：这里返回 unsupported-by-host（手机端提示“电脑端不支持该操作”）
    const result = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-cancel',
      action: 'deny',
    })
    expect(result.accepted).toBe(true)
    // 文案要与桌面 `handleChoiceCancel` 完全同形（AI 收到的东西不因应答端而变）
    expect(rejected).toEqual([{ id: 'it-cancel', reason: '用户关闭了选择弹窗' }])
    expect(h.bridge.interactions.has('it-cancel')).toBe(false)
    off()
  })

  it('AI 提问 + 「暂存」(shelve) → `shelve:` 前缀（协议与桌面同形；手机 UI 暂不暴露该按钮）', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const h = setup()
    const rejected: Array<{ id: string; reason: string }> = []
    const off = toolInteractEvent.on('reject', (id, reason) => rejected.push({ id, reason }))

    toolInteractEvent.emit('showChoice', {
      interactionId: 'it-shelve',
      sessionId: 's-i-1',
      toolCallId: 'tc-y',
      question: '选哪个？',
      options: ['A'],
      multi: false,
    })
    await flush()

    const result = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-shelve',
      action: 'shelve',
    })
    expect(result.accepted).toBe(true)
    expect(rejected).toEqual([{ id: 'it-shelve', reason: 'shelve:用户暂存了这个问题' }])
    off()
  })

  it('授权「拒绝」→ 文案与桌面同形（不再是裸 `cancelled`）', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const h = setup()
    const rejected: Array<{ id: string; reason: string }> = []
    const off = toolInteractEvent.on('commandReject', (id, reason) => rejected.push({ id, reason }))

    toolInteractEvent.emit('showAuthorization', { interactionId: 'it-auth-deny', ...authDefaults })
    await flush()

    const result = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-auth-deny',
      action: 'deny',
    })
    expect(result.accepted).toBe(true)
    expect(rejected).toEqual([{ id: 'it-auth-deny', reason: '用户拒绝了该命令' }])
    off()
  })

  it('host.interaction.list → 快照拉取（手机在交互发起后才连上时的补看通道）', async () => {
    sessionStore.saveSession(makeSession('s-i-1', '交互'))
    const h = setup()
    expect((await h.caller.call('host.interaction.list', {})).interactions).toHaveLength(0)

    toolInteractEvent.emit('showAuthorization', { interactionId: 'it-list', ...authDefaults })
    const { interactions } = await h.caller.call('host.interaction.list', {})
    expect(interactions).toHaveLength(1)
    expect(interactions[0]).toMatchObject({ interactionId: 'it-list', kind: 'authorization' })

    // 电脑侧处理完（广播终态）→ 快照里不再有它（手机据此丢弃僵尸卡片）
    toolInteractEvent.emit('interactionSettled', 'it-list', 'reject')
    expect((await h.caller.call('host.interaction.list', {})).interactions).toHaveLength(0)
  })

  it('终端内确认：pendingConfirm → 登记为高风险卡片；手机只能原样放行', async () => {
    const h = setup()
    const submitted: Array<{ toolCallId: string; command: string }> = []
    const off = toolInteractEvent.on('terminalConfirmSubmit', (toolCallId, command) =>
      submitted.push({ toolCallId, command }),
    )
    const requested: InteractionDTO[] = []
    h.sub.subscribe('host.event.interaction.requested', (e) => requested.push(e.interaction))

    toolOutputStore.setPendingConfirm('tc-term', {
      interactionId: 'it-term',
      permName: 'terminal.install.execute',
      title: '执行命令',
      desc: 'npm i -g pnpm',
      risk: 'install',
    })
    await waitFor(() => requested.length === 1)
    expect(requested[0]).toMatchObject({
      interactionId: 'it-term',
      presentation: 'terminal',
      tier: 'high',
      sessionId: '',
      toolCallId: 'tc-term',
    })

    const denied = await h.caller.call('host.interaction.answer', {
      interactionId: 'it-term',
      action: 'allow',
    })
    expect(denied).toMatchObject({ accepted: false, reason: 'confirm-required' })

    await h.caller.call('host.interaction.answer', {
      interactionId: 'it-term',
      action: 'allow',
      confirmed: true,
    })
    expect(submitted).toEqual([{ toolCallId: 'tc-term', command: 'npm i -g pnpm' }])

    // 电脑侧提交后 pendingConfirm 消失 → 卡片收口（若手机还挂着，不能留僵尸卡片）
    toolOutputStore.clearPendingConfirm('tc-term')
    await flush()
    expect(h.bridge.interactions.has('it-term')).toBe(false)
    off()
    toolOutputStore.remove('tc-term')
  })
})

// ───────────────────── 真机反馈修复（消息镜像同步 / 错误回显）─────────────────────

/**
 *这两条防的是同一类错：**“只有桌面组件自己发起的路径会被同步到 UI”**。
 *
 * 手机 bridge 没有组件回调闭包，过去会：
 *  1. 改了 store 但 chat-view 的本地镜像不刷新（要切会话才看到消息）；
 *  2. 发送失败时 `onError` 缺省 → 电脑端与手机端都不知道（会话像「卡住」）。
 * 修法：① `sessionStore.onMessagesChanged` 作为消息变更的唯一收口广播；
 *      ② `host-source.send` 带最小 events（onError 回写会话运行时）。
 */
describe('真机反馈修复：消息镜像同步与错误回显', () => {
  it('手机 send → 「消息变更」订阅者收到通知（电脑端镜像据此更新，不再要求切会话）', async () => {
    sessionStore.saveSession(makeSession('s-sync-1', '同步'))
    const h = setup()
    const notified: string[] = []
    const off = sessionStore.onMessagesChanged((sid) => notified.push(sid))
    try {
      await h.caller.call('host.session.send', { sessionId: 's-sync-1', text: '手机发的话' })
      expect(notified).toContain('s-sync-1')
      expect(
        getSessionMessages('s-sync-1').some(
          (m) => m.role === 'user' && m.content === '手机发的话',
        ),
      ).toBe(true)
    } finally {
      off()
    }
  })

  it('发送失败（未选模型）→ 会话运行时收到 error（电脑端不再静默）', async () => {
    sessionStore.saveSession({
      ...makeSession('s-err-1', '错误'),
      modelId: '',
      providerConfigId: '',
    })
    const h = setup()
    await h.caller.call('host.session.send', { sessionId: 's-err-1', text: 'x' })
    expect(getSessionRuntime('s-err-1').error).toBeTruthy()
  })

  it('取消订阅后不再收到通知（避免卸载后泄漏调用）', () => {
    sessionStore.saveSession(makeSession('s-sync-2', '同步2'))
    const notified: string[] = []
    const off = sessionStore.onMessagesChanged((sid) => notified.push(sid))
    off()
    addSessionMessage('s-sync-2', {
      id: 'm-x',
      role: 'user',
      content: 'x',
      timestamp: Date.now(),
    })
    expect(notified).toHaveLength(0)
  })
})

// ─────────────────── M5：消息分页（host.session.messages） ───────────────────

describe('M5 消息分页', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * 直接放进 store（**不**走 `saveSession`）—— `saveSession` 会把会话标为「已加载」，
   * 从而跳过从 repo 的懒加载，而分页本身正依赖那条路径。
   */
  function seedSession(id: string, title: string): void {
    const session = makeSession(id, title)
    sessionStore.value.sessions = [
      ...sessionStore.value.sessions.filter((s) => s.id !== id),
      session,
    ]
  }

  function msg(id: string): Message {
    return { id, role: 'user', content: id, timestamp: 1 } as unknown as Message
  }

  it('首页：返回已加载窗口 + 不透明游标；续页：返回更早一页（带 beforeRowid）', async () => {
    seedSession('s-page', '分页')
    const all: Message[] = []
    for (let i = 0; i < 70; i++) all.push(msg(`m${i}`))

    const spy = vi.spyOn(sessionRepo, 'getMessagePage')
    spy.mockResolvedValueOnce({ messages: all.slice(10), hasMore: true, oldestRowid: 11 })

    const h = setup()
    const first = await h.caller.call('host.session.messages', { sessionId: 's-page' })
    // 首页 = 已加载窗口**全部**（60），而不是再 slice —— 否则游标会指向窗口外（§20.2-A）
    expect(first.messages).toHaveLength(60)
    expect(first.messages[0].id).toBe('m10')
    expect(first.hasMore).toBe(true)
    expect(first.cursor).toBe(11)

    spy.mockResolvedValueOnce({ messages: all.slice(0, 10), hasMore: false, oldestRowid: 1 })
    const older = await h.caller.call('host.session.messages', {
      sessionId: 's-page',
      fromRowid: first.cursor as number,
    })
    expect(older.messages.map((m) => m.id)).toEqual(all.slice(0, 10).map((m) => m.id))
    expect(older.hasMore).toBe(false)
    expect(older.cursor).toBe(1)
    // 关键：游标必须真的被用作 repo 的 `beforeRowid`（不然会反复取回同一页）
    expect(spy.mock.calls[1][1]).toMatchObject({ beforeRowid: 11 })
  })

  it('到底：已全量加载的会话 hasMore=false 且无游标', async () => {
    // 新会话由 `saveSession` 建（内存即真相）→ 分页状态为「无更早」
    sessionStore.saveSession(makeSession('s-page2', '短会话'))
    const h = setup()
    const page = await h.caller.call('host.session.messages', { sessionId: 's-page2' })
    expect(page.hasMore).toBe(false)
    expect(page.cursor).toBeNull()
    expect(page.messages).toHaveLength(0)
  })
})

// ───────────────────── §22：工具名 / 上下文 / 模型 / 工作目录 ─────────────────────

describe('§22 —— 手机端可见的会话配置面', () => {
  const originProviders = settingsState.value.providers
  const originWindow = settingsState.value.contextWindowTokens
  const originDefaultWorkspace = settingsState.value.defaultWorkspace

  afterEach(() => {
    settingsState.setValue('providers', originProviders)
    settingsState.setValue('contextWindowTokens', originWindow)
    settingsState.setValue('defaultWorkspace', originDefaultWorkspace)
  })

  it('工具结果带 toolName（由 toolCallId 反查发起调用的 assistant 消息）', async () => {
    sessionStore.saveSession(makeSession('s-tool-1', '工具'))
    const h = setup()
    addSessionMessage('s-tool-1', {
      id: 'asst-1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [{ type: 'tool_use', id: 'tc-1', name: 'read_file', input: { path: 'a.ts' } }],
    })
    addSessionMessage('s-tool-1', {
      id: 'tool-1',
      role: 'tool',
      content: '文件内容',
      toolCallId: 'tc-1',
      timestamp: Date.now(),
    })
    // 无宿主调用的工具消息（索引里没有）→ 不给 toolName，不编造
    addSessionMessage('s-tool-1', {
      id: 'tool-2',
      role: 'tool',
      content: '孤儿结果',
      toolCallId: 'tc-missing',
      timestamp: Date.now(),
    })

    const page = await h.caller.call('host.session.messages', { sessionId: 's-tool-1' })
    expect(page.messages.find((m) => m.id === 'tool-1')!.toolName).toBe('read_file')
    expect(page.messages.find((m) => m.id === 'tool-2')!.toolName).toBeUndefined()
    // 纯工具调用的 assistant 消息正文为空串（手机端据此不渲染空气泡）
    expect(page.messages.find((m) => m.id === 'asst-1')!.text).toBe('')
  })

  it('上下文快照：口径与桌面 token 环一致（usage.totalTokens / uiData.contextTokens）', async () => {
    settingsState.setValue('contextWindowTokens', 100_000)
    sessionStore.saveSession(makeSession('s-ctx-0', '上下文'))
    const h = setup()
    addSessionMessage('s-ctx-0', {
      id: 'a-usage',
      role: 'assistant',
      content: 'hi',
      timestamp: Date.now(),
      usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1_000 },
    })
    const ctx = await h.caller.call('host.session.context', { sessionId: 's-ctx-0' })
    expect(ctx).toEqual({ tokens: 1_000, windowTokens: 100_000 })

    // 压缩产物（uiData.contextTokens）优先于 usage：否则「压缩后反而更大」
    addSessionMessage('s-ctx-0', {
      id: 'sum-1',
      role: 'summary',
      content: '摘要',
      timestamp: Date.now(),
      uiData: { contextTokens: 300 },
      usage: { promptTokens: 99_000, completionTokens: 1_000, totalTokens: 100_000 },
    })
    const after = await h.caller.call('host.session.context', { sessionId: 's-ctx-0' })
    expect(after.tokens).toBe(300)
  })

  it('上下文占用变化 → context.changed（仅订阅的会话）', async () => {
    sessionStore.saveSession(makeSession('s-ctx-1', '上下文推送'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-ctx-1' })
    const events: Array<HostEvents['host.event.session.context.changed']> = []
    h.sub.subscribe('host.event.session.context.changed', (p) => events.push(p))

    addSessionMessage('s-ctx-1', {
      id: 'a-ctx',
      role: 'assistant',
      content: 'hi',
      timestamp: Date.now(),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    })
    await waitFor(() => events.length > 0)
    expect(events[events.length - 1].sessionId).toBe('s-ctx-1')
    expect(events[events.length - 1].context.tokens).toBe(120)
  })

  it('消息被整体替换（压缩 / 删除）→ messages.reset，手机据此重拉窗口', async () => {
    sessionStore.saveSession(makeSession('s-reset-1', '压缩'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-reset-1' })
    addSessionMessage('s-reset-1', { id: 'u-old', role: 'user', content: '旧消息', timestamp: Date.now() })
    await waitFor(() => getSessionMessages('s-reset-1').some((m) => m.id === 'u-old'))

    const resets: Array<HostEvents['host.event.session.messages.reset']> = []
    const added: Array<HostEvents['host.event.message.added']> = []
    h.sub.subscribe('host.event.session.messages.reset', (p) => resets.push(p))
    h.sub.subscribe('host.event.message.added', (p) => added.push(p))

    // 压缩的落点：整段历史 → 一条 summary（`compressContext` 走的就是它）
    replaceSessionMessages('s-reset-1', [
      { id: 'sum-new', role: 'summary', content: '摘要', timestamp: Date.now() },
    ])
    await waitFor(() => resets.length > 0)
    expect(resets[resets.length - 1].sessionId).toBe('s-reset-1')
    // 新消息同时按常规通道推（手机端按 id 去重，重拉与增量不会双份）
    await waitFor(() => added.some((e) => e.message.id === 'sum-new'))

    // 单条删除同样触发（手机端统一按「重拉窗口」处理，不发明 message.removed 增量）
    const before = resets.length
    deleteSessionMessage('s-reset-1', 'sum-new')
    await waitFor(() => resets.length > before)
  })

  it('压缩中 → runtime.compacting 推给手机', async () => {
    sessionStore.saveSession(makeSession('s-compact-1', '压缩中'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-compact-1' })
    const events: Array<HostEvents['host.event.session.runtime.changed']> = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => events.push(p))

    getSessionRuntime('s-compact-1') // 先建条目（`setCompacting` 需要已有会话条目）
    sessionRuntimeState.setCompacting('s-compact-1', true)
    await waitFor(() => events.some((e) => e.runtime.compacting === true))
    expect(events.some((e) => e.runtime.compacting === true)).toBe(true)
  })

  it('工具参数生成进度 → runtime.toolProgress 随 runtime.changed 推给手机（§27）', async () => {
    sessionStore.saveSession(makeSession('s-prog-1', '进度'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 's-prog-1' })
    const events: Array<HostEvents['host.event.session.runtime.changed']> = []
    h.sub.subscribe('host.event.session.runtime.changed', (p) => events.push(p))

    // 引擎在参数累积期推来的进度（`event-handler` 的 tool_progress 落在 runtime 上）
    getSessionRuntime('s-prog-1')
    // ⚠️ 先单独把 `working` 推上去：下面的断言要求「**只有** toolProgress 变化也照样推」，
    // 否则会被 `working: false → true` 顺带触发的那次推送蒙混过关（指纹漏字段也测不出来）
    updateSessionRuntime('s-prog-1', { working: true })
    await waitFor(() => events.some((e) => e.runtime.working === true))
    const baseline = events.length

    updateSessionRuntime('s-prog-1', { toolProgress: { name: 'write_file', chars: 1200 } })
    await waitFor(() => events.slice(baseline).some((e) => e.runtime.toolProgress?.chars === 1200))
    expect(events.filter((e) => e.runtime.toolProgress).pop()!.runtime.toolProgress).toEqual({
      name: 'write_file',
      chars: 1200,
    })

    // 参数生成完（工具开始执行）/ 本轮结束 → **清空也必须推**
    // 否则手机端会一直挂着「正在生成工具调用…」（那是上一轮的残留）
    const beforeClear = events.length
    updateSessionRuntime('s-prog-1', { toolProgress: null })
    await waitFor(() => events.slice(beforeClear).some((e) => e.runtime.toolProgress === undefined))
  })

  it('模型列表只含「已启用且有模型」的服务；切换模型落到会话并推列表变更', async () => {
    settingsState.setValue('providers', [
      makeProvider({ id: 'p1', name: '服务一', models: ['m1', 'm2'] }),
      makeProvider({ id: 'p2', name: '停用的', models: ['x'], enabled: false }),
      makeProvider({ id: 'p3', name: '无模型', models: [] }),
    ])
    sessionStore.saveSession(makeSession('s-model-1', '模型'))
    const h = setup()

    const { providers } = await h.caller.call('host.model.list', {})
    // 白名单：只有 id / name / models（不含 apiKey / baseUrl）
    expect(providers).toEqual([{ id: 'p1', name: '服务一', models: ['m1', 'm2'] }])

    const lists: Array<HostEvents['host.event.session.list.changed']> = []
    h.sub.subscribe('host.event.session.list.changed', (p) => lists.push(p))
    await h.caller.call('host.session.setModel', {
      sessionId: 's-model-1',
      providerConfigId: 'p1',
      modelId: 'm2',
    })
    expect(sessionStore.getSession('s-model-1')!.modelId).toBe('m2')
    // DTO 指纹：切模型必须推列表（否则手机端显示的还是旧模型）
    await waitFor(() => lists.length > 0)
    const pushed = lists[lists.length - 1].sessions.find((s) => s.id === 's-model-1')!
    expect(pushed.modelId).toBe('m2')
    expect(pushed.providerName).toBe('服务一')

    // 该服务下没有的模型 / 未启用的服务 → 拒（白名单投影的另一面）
    await expect(
      h.caller.call('host.session.setModel', {
        sessionId: 's-model-1',
        providerConfigId: 'p1',
        modelId: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    await expect(
      h.caller.call('host.session.setModel', {
        sessionId: 's-model-1',
        providerConfigId: 'p2',
        modelId: 'x',
      }),
    ).rejects.toMatchObject({ code: 'E_BAD_REQUEST' })
    expect(sessionStore.getSession('s-model-1')!.modelId).toBe('m2')
  })

  it('工作目录候选集 = 电脑侧既有目录（会话 + 全局默认），同目录不同写法归一化后合并', async () => {
    settingsState.setValue('defaultWorkspace', 'E:/global/ws')
    sessionStore.saveSession({ ...makeSession('s-ws-1', '目录一'), workspace: 'E:/code/a' })
    sessionStore.saveSession({ ...makeSession('s-ws-2', '目录二'), workspace: 'E:\\code\\a\\' })
    sessionStore.saveSession({ ...makeSession('s-ws-3', '无目录'), workspace: undefined })
    const h = setup()

    const { workspaces } = await h.caller.call('host.workspace.list', {})
    expect(workspaces).toEqual([
      { path: 'E:/code/a', name: 'a', sessionCount: 2 },
      { path: 'E:/global/ws', name: 'ws', sessionCount: 0 },
    ])
  })
})
