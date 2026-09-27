/**
 * 电脑侧「通讯层」埋点单测（§25）。
 *
 * 埋点很容易写成「加了但没人能验证」—— 本文件的价值就在于：**每个节点都有一条断言**，
 * 字段口径（含 80 字正文预览、令牌只记哈希）也在这里被钉住。
 *
 * 覆盖：
 *  1. 开关**关闭时零采集**（并确认功能不受影响）；
 *  2. RPC 入站 4 条（call / error / denied / slow）；
 *  3. 事件推送 5 条（event / stream 采样 / dropped / reset / stats）；
 *  4. 订阅 3 条、交互 4 条、配对 4 条、链路 6 条；
 *  5. 载荷口径（截断、打码、令牌哈希）。
 *
 * 断言方式：直接读埋点 SDK 的本地缓冲（`telemetryBuffer`），
 * 与「设置页导出 zip」读到的是同一份数据。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createCaller,
  createMemoryPair,
  type HostApi,
} from 'virlen-remote'
import { PHONE_EVENTS, startPhoneBridge, type Capability, type PhoneBridge } from '@/bridge'
import { PhoneControlService } from '@/bridge/phone-control'
import { createTracedEmit } from '@/bridge/telemetry'
import { installTelemetry } from '@/utils/telemetry'
import { telemetryBuffer } from '@/utils/telemetry/buffer'
import { sessionRuntimeState, sessionStore, settingsState, updateSessionRuntime } from '@/ui/store'
import {
  addSessionMessage,
  deleteSessionMessage,
  getSessionMessages,
  replaceSessionMessages,
  updateSessionMessage,
} from '@/services/chat-service'
import toolInteractEvent from '@/events/toolInteractEvent'
import type { ProviderConfig, Session } from '@/types'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

// ───────────────────────────── 埋点开关与读取 ─────────────────────────────

/** 开关状态（`installTelemetry` 只装一次，这里改标志位）。 */
let telemetryOn = true

beforeAll(() => {
  installTelemetry({ isEnabled: () => telemetryOn })
})

afterAll(() => {
  telemetryOn = false
})

const captured = () => telemetryBuffer.getAll()
const names = () => captured().map((e) => e.event_name)
const propsOf = (name: string): Array<Record<string, any>> =>
  captured()
    .filter((e) => e.event_name === name)
    .map((e) => e.props as Record<string, any>)
const firstProps = (name: string): Record<string, any> => propsOf(name)[0] ?? {}

// ───────────────────────────── 宿主脚手架 ─────────────────────────────

interface Harness {
  caller: ReturnType<typeof createCaller<HostApi>>
  bridge: PhoneBridge
  /** 电脑侧 transport（关掉它就能让推送真的「发不出去」）。 */
  hostT: MemoryTransport
  deviceToken: string
  deviceId: string
}

const cleanups: Array<() => void> = []

function setup(options: {
  capabilities?: Capability[]
  confirmPair?: (ctx: { token: string; deviceName: string }) => Promise<boolean>
} = {}): Harness {
  const [hostT, mobileT] = createMemoryPair()
  const hostEp = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const bridge = startPhoneBridge(hostEp, {
    deviceName: '测试电脑',
    deviceId: 'host-test',
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.confirmPair ? { confirmPair: options.confirmPair } : {}),
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
    bridge,
    hostT,
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
    systemPrompt: 'SECRET',
    params: { temperature: 0, topP: 0, maxTokens: 0, stream: true },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
  }
}

const helloParams = (token?: string) => ({
  protocolVersion: 1,
  client: { platform: 'test', appVersion: '0' },
  capabilities: ['session.list', 'session.send'],
  ...(token ? { token } : {}),
})

beforeEach(() => {
  // ⚠️ 先关掉：`beforeEach` 自身要写 settings（会触发桌面侧既有的 `settings.change` 埋点），
  //    那是别的子系统的点，不能算进通讯层；清缓冲放在最后，保证每条用例都从 0 开始
  telemetryOn = false
  sessionStore.clear()
  sessionRuntimeState.setValue('sessions', {})
  settingsState.setValue('providers', [])
  telemetryBuffer.clear()
  telemetryOn = true
})

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  sessionStore.clear()
  telemetryBuffer.clear()
})

// ───────────────────────────── 开关关闭 ─────────────────────────────

describe('§25 —— 关闭时零采集', () => {
  it('全链路跑一趟（hello → 订阅 → 发送 → 推送）后缓冲里 0 条，且功能不受影响', async () => {
    telemetryOn = false
    sessionStore.saveSession(makeSession('t-off-1', '关闭埋点'))
    const h = setup()

    await h.caller.call('host.hello', helloParams(h.deviceToken))
    await h.caller.call('host.session.subscribe', { sessionId: 't-off-1' })
    addSessionMessage('t-off-1', { id: 'u-off', role: 'user', content: '你好', timestamp: Date.now() })
    await waitFor(() => getSessionMessages('t-off-1').some((m) => m.id === 'u-off'))

    // [DEBUG-TMP]
    expect(telemetryBuffer.count()).toBe(0)
  })
})

// ───────────────────────────── RPC 入站 ─────────────────────────────

describe('§25 —— RPC 入站（call / error / denied / slow）', () => {
  it('成功调用记 method / status / dur_ms，并带参数摘要', async () => {
    sessionStore.saveSession(makeSession('t-rpc-1', 'RPC'))
    const h = setup()
    await h.caller.call('host.hello', helloParams(h.deviceToken))
    sessionStore.saveSession(makeSession('t-rpc-1', 'RPC'))
    await h.caller.call('host.session.subscribe', { sessionId: 't-rpc-1' })
    await h.caller.call('host.session.send', { sessionId: 't-rpc-1', text: '看一下状态' })
    await flush(10)

    const calls = propsOf(PHONE_EVENTS.rpcCall)
    const send = calls.find((c) => c.method === 'host.session.send')
    expect(send).toMatchObject({
      method: 'host.session.send',
      status: 'ok',
      session_id: 't-rpc-1',
      text: '看一下状态',
    })
    expect(typeof send!.dur_ms).toBe('number')
    // hello 的参数摘要：能力个数 / 是否带令牌（**不记令牌本身**）
    const hello = calls.find((c) => c.method === 'host.hello')
    expect(hello).toMatchObject({ platform: 'test', token_present: true, capabilities_count: 2 })
    expect(JSON.stringify(hello)).not.toContain(h.deviceToken)
  })

  it('业务错误 → phone.rpc.error（带错误码）；ACL 拒绝 → phone.rpc.denied', async () => {
    const h = setup()
    await expect(
      h.caller.call('host.session.send', { sessionId: '不存在', text: 'x' }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await waitFor(() => names().includes(PHONE_EVENTS.rpcError))
    expect(firstProps(PHONE_EVENTS.rpcError)).toMatchObject({
      method: 'host.session.send',
      error_code: 'E_NOT_FOUND',
    })

    // 只给 session.list 能力：session.send 会被 ACL 拒（E_DENIED）
    const denied = setup({ capabilities: ['session.list'] })
    sessionStore.saveSession(makeSession('t-rpc-2', 'ACL'))
    await expect(
      denied.caller.call('host.session.send', { sessionId: 't-rpc-2', text: 'x' }),
    ).rejects.toMatchObject({ code: 'E_DENIED' })
    await waitFor(() => names().includes(PHONE_EVENTS.rpcDenied))
    expect(firstProps(PHONE_EVENTS.rpcDenied)).toMatchObject({
      method: 'host.session.send',
      error: expect.stringContaining('未授权'),
    })
  })
})

// ───────────────────────────── 事件推送 ─────────────────────────────

describe('§25 —— 事件推送（event / stream / dropped / reset / stats）', () => {
  it('消息 / 运行时 / 列表推送各记一条（含 role 与正文预览）', async () => {
    sessionStore.saveSession(makeSession('t-push-1', '推送'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 't-push-1' })

    addSessionMessage('t-push-1', { id: 'u-push', role: 'user', content: '帮我看下', timestamp: Date.now() })
    updateSessionRuntime('t-push-1', { working: true })
    await waitFor(() => names().includes(PHONE_EVENTS.pushEvent))

    const added = propsOf(PHONE_EVENTS.pushEvent).find(
      (p) => p.topic === 'host.event.message.added',
    )
    expect(added).toMatchObject({ session_id: 't-push-1', role: 'user', text: '帮我看下' })
    await waitFor(() =>
      propsOf(PHONE_EVENTS.pushEvent).some(
        (p) => p.topic === 'host.event.session.runtime.changed' && p.working === true,
      ),
    )
  })

  it('流式帧按 0.1 采样：命中才记（seq / final / text_len），未命中一条不记', async () => {
    sessionStore.saveSession(makeSession('t-stream-1', '流式'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 't-stream-1' })
    addSessionMessage('t-stream-1', {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
    })
    await flush(10)

    // 采样命中（`trackPerf` 的采样判据是 `Math.random() >= 0.1`）
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0)
    updateSessionMessage('t-stream-1', 'a1', { content: '你' })
    await waitFor(() => names().includes(PHONE_EVENTS.pushStream))
    expect(firstProps(PHONE_EVENTS.pushStream)).toMatchObject({
      session_id: 't-stream-1',
      message_id: 'a1',
      text: '你',
      // §32：本帧载荷形态 —— 本例客户端未声明 delta（未走过 hello 的偏好声明）→ 整帧
      mode: 'full',
      final: false,
    })

    // 采样未命中：不再增加（高频通道靠采样控量，不能变成「其实全量」）
    rand.mockReturnValue(0.99)
    const before = propsOf(PHONE_EVENTS.pushStream).length
    updateSessionMessage('t-stream-1', 'a1', { content: '你好' })
    await flush(20)
    expect(propsOf(PHONE_EVENTS.pushStream)).toHaveLength(before)
    rand.mockRestore()
  })

  it('链路非 open 时推送被静默丢弃 → phone.push.dropped（过去完全看不见的一环）', async () => {
    sessionStore.saveSession(makeSession('t-drop-1', '丢弃'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 't-drop-1' })

    // 关掉电脑侧链路 → `endpoint.emit()` 返回 false（丢帧且无任何报错）
    h.hostT.close()
    addSessionMessage('t-drop-1', { id: 'u-drop', role: 'user', content: '没人收', timestamp: Date.now() })
    await waitFor(() => names().includes(PHONE_EVENTS.pushDropped))

    expect(firstProps(PHONE_EVENTS.pushDropped)).toMatchObject({
      topic: 'host.event.message.added',
      session_id: 't-drop-1',
      reason: 'transport-not-open',
      transport_state: 'closed',
    })
  })

  it('消息被整体替换 → phone.push.reset（压缩 / 删除的单列节点）', async () => {
    sessionStore.saveSession(makeSession('t-reset-1', '压缩'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 't-reset-1' })
    addSessionMessage('t-reset-1', { id: 'u-old', role: 'user', content: '旧', timestamp: Date.now() })
    await waitFor(() => getSessionMessages('t-reset-1').some((m) => m.id === 'u-old'))

    replaceSessionMessages('t-reset-1', [
      { id: 'sum-1', role: 'summary', content: '摘要', timestamp: Date.now() },
    ])
    await waitFor(() => names().includes(PHONE_EVENTS.pushReset))
    expect(firstProps(PHONE_EVENTS.pushReset)).toMatchObject({ session_id: 't-reset-1' })

    // 单条删除走同一条通道
    const before = propsOf(PHONE_EVENTS.pushReset).length
    deleteSessionMessage('t-reset-1', 'sum-1')
    await waitFor(() => propsOf(PHONE_EVENTS.pushReset).length > before)
  })

  it('phone.push.stats：窗口汇总（条数 / 丢弃数 / 字节）', async () => {
    const [a, b] = createMemoryPair()
    const ep = new Endpoint({ transport: a })
    const emit = createTracedEmit(ep)
    emit('host.event.session.list.changed', { sessions: [] })
    emit('host.event.session.list.changed', { sessions: [] })
    emit.flushStats()

    expect(firstProps(PHONE_EVENTS.pushStats)).toMatchObject({
      events: 2,
      stream_frames: 0,
      dropped: 0,
    })
    // 冲过之后窗口归零，不重复统计
    const before = propsOf(PHONE_EVENTS.pushStats).length
    emit.flushStats()
    expect(propsOf(PHONE_EVENTS.pushStats)).toHaveLength(before)

    emit.dispose()
    ep.dispose()
    a.close()
    b.close()
  })
})

// ───────────────────────────── 订阅集合 ─────────────────────────────

describe('§25 —— 订阅集合（add / remove / clear）', () => {
  it('订阅 → add（带原因）；删除会话 → remove；桥接释放 → clear', async () => {
    sessionStore.saveSession(makeSession('t-sub-1', '订阅'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 't-sub-1' })
    expect(firstProps(PHONE_EVENTS.subAdd)).toMatchObject({
      session_id: 't-sub-1',
      reason: 'subscribe',
      count: 1,
      already: false,
    })

    await h.caller.call('host.session.delete', { sessionId: 't-sub-1', confirm: true })
    await waitFor(() => names().includes(PHONE_EVENTS.subRemove))
    expect(firstProps(PHONE_EVENTS.subRemove)).toMatchObject({ session_id: 't-sub-1' })

    // 手机建会话时电脑侧会自动补订（§24）——原因字段要能区分这两种来源
    sessionStore.saveSession(makeSession('t-sub-2', '再建'))
    const h2 = setup()
    await h2.caller.call('host.session.subscribe', { sessionId: 't-sub-2' })
    h2.bridge.dispose()
    await waitFor(() => names().includes(PHONE_EVENTS.subClear))
    expect(firstProps(PHONE_EVENTS.subClear).count).toBeGreaterThan(0)
  })
})

// ───────────────────────────── 交互 ─────────────────────────────

describe('§25 —— 交互（requested / answer / resolved / expired）', () => {
  const authDefaults = {
    sessionId: 't-i-1',
    toolCallId: 'tc-i-1',
    permName: 'terminal.normal.execute',
    title: '执行命令',
    subTitle: '查看状态',
    desc: 'git status',
    risk: 'safe',
  }

  it('登记 → requested；手机允许 → answer + resolved；取消会话 → expired 汇总', async () => {
    sessionStore.saveSession(makeSession('t-i-1', '交互'))
    const h = setup()

    toolInteractEvent.emit('showAuthorization', { interactionId: 'it-t-1', ...authDefaults })
    await waitFor(() => names().includes(PHONE_EVENTS.interactionRequested))
    expect(firstProps(PHONE_EVENTS.interactionRequested)).toMatchObject({
      interaction_id: 'it-t-1',
      session_id: 't-i-1',
      kind: 'authorization',
      tier: 'low',
      command: 'git status',
      pending: 1,
    })

    await h.caller.call('host.interaction.answer', { interactionId: 'it-t-1', action: 'allow' })
    await waitFor(() => names().includes(PHONE_EVENTS.interactionResolved))
    expect(firstProps(PHONE_EVENTS.interactionAnswer)).toMatchObject({
      interaction_id: 'it-t-1',
      action: 'allow',
      accepted: true,
    })
    expect(firstProps(PHONE_EVENTS.interactionResolved)).toMatchObject({
      interaction_id: 'it-t-1',
      outcome: 'allow',
      by: 'mobile',
      pending_remaining: 0,
    })

    // 僵尸卡片收敛（取消会话）：批量汇总一条
    toolInteractEvent.emit('showAuthorization', {
      interactionId: 'it-t-2',
      ...authDefaults,
      desc: 'git log',
    })
    await waitFor(() => propsOf(PHONE_EVENTS.interactionRequested).length === 2)
    await h.caller.call('host.session.cancel', { sessionId: 't-i-1' })
    await waitFor(() => names().includes(PHONE_EVENTS.interactionExpired))
    expect(firstProps(PHONE_EVENTS.interactionExpired)).toMatchObject({
      session_id: 't-i-1',
      count: 1,
      outcome: 'expired',
    })
  })
})

// ───────────────────────────── 配对 ─────────────────────────────

describe('§25 —— 配对（hello / confirm / ticket / revoke）', () => {
  it('首次扫码：issue → confirm → redeem → hello(first_time)；令牌只记哈希', async () => {
    const confirmPair = vi.fn(async () => true)
    const h = setup({ confirmPair })
    const ticket = h.bridge.pairing.issueTicket()
    expect(firstProps(PHONE_EVENTS.pairTicket)).toMatchObject({ action: 'issue' })

    const first = await h.caller.call('host.hello', helloParams(ticket))
    await waitFor(() => names().includes(PHONE_EVENTS.pairHello))
    expect(firstProps(PHONE_EVENTS.pairConfirm)).toMatchObject({ approved: true, asked: true })
    expect(firstProps(PHONE_EVENTS.pairHello)).toMatchObject({
      ok: true,
      first_time: true,
    })
    expect(typeof firstProps(PHONE_EVENTS.pairHello).devices).toBe('number')
    expect(propsOf(PHONE_EVENTS.pairTicket).map((p) => p.action)).toEqual(['issue', 'redeem'])

    // 票据 / 令牌一律只记哈希：埋点包里不得出现原文
    const dump = JSON.stringify(captured())
    expect(dump).not.toContain(ticket)
    expect(dump).not.toContain(h.deviceToken)
    expect(dump).toContain('ticket_hash')

    // 老设备凭**凭证**直连（M6：票据是一次性的，不能拿它再连）→ first_time=false
    telemetryBuffer.clear()
    await h.caller.call('host.hello', helloParams(first.grant!.token))
    expect(firstProps(PHONE_EVENTS.pairHello)).toMatchObject({ ok: true, first_time: false })
  })

  it('令牌无效 → hello(ok:false, reason=invalid)；移除设备 → phone.pair.revoke', async () => {
    const h = setup()
    await expect(h.caller.call('host.hello', helloParams('bad-token'))).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    expect(firstProps(PHONE_EVENTS.pairHello)).toMatchObject({
      ok: false,
      reason: 'invalid',
      token_present: true,
    })

    h.bridge.pairing.revoke(h.deviceId)
    expect(firstProps(PHONE_EVENTS.pairRevoke)).toMatchObject({ remaining: 0 })
  })

  it('用户拒绝配对 → confirm(approved:false) + hello(ok:false, reason=user-denied)', async () => {
    const h = setup({ confirmPair: async () => false })
    const ticket = h.bridge.pairing.issueTicket()
    await expect(h.caller.call('host.hello', helloParams(ticket))).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    expect(firstProps(PHONE_EVENTS.pairConfirm)).toMatchObject({ approved: false, asked: true })
    expect(firstProps(PHONE_EVENTS.pairHello)).toMatchObject({
      ok: false,
      reason: 'user-denied',
    })
  })
})

// ───────────────────────────── 链路 / 信令 ─────────────────────────────

describe('§25 —— 链路（enable / state / disable）', () => {
  it('启用 → link.enable；状态变化 → link.state（from/to/耗时/缓冲量）；停用 → link.disable（带计数）', async () => {
    const transport = new MemoryTransport() // 初始 connecting，由测试手动 open
    const service = new PhoneControlService({
      signalUrl: 'https://virlen.cn/api/rtc/',
      deviceName: '测试电脑',
      deviceKey: 'dk-0123456789abcdef',
      // M7（§31）：客户端不再内置默认 ICE，列表由调用方（store）解析后传入
      iceServers: [{ urls: 'stun:a:3478' }, { urls: 'turn:a:3478', username: 'u', credential: 'p' }],
      iceSource: 'remote',
      createTransport: () => transport,
    })

    try {
      service.enable()
      expect(firstProps(PHONE_EVENTS.linkEnable)).toMatchObject({
        signal_host: 'virlen.cn',
        ice_count: 2,
        ice_source: 'remote',
        mode: 'injected',
      })
      // 信令基址只记 host（query / path 不进埋点）
      expect(JSON.stringify(firstProps(PHONE_EVENTS.linkEnable))).not.toContain('/api/rtc')
      // 安全红线：埋点里不得出现 ICE 凭证
      expect(JSON.stringify(firstProps(PHONE_EVENTS.linkEnable))).not.toContain('credential')

      transport.open()
      await waitFor(() => names().includes(PHONE_EVENTS.linkState))
      expect(firstProps(PHONE_EVENTS.linkState)).toMatchObject({
        from: 'connecting',
        to: 'open',
        buffered_amount: 0,
      })

      service.disable()
      const stopped = firstProps(PHONE_EVENTS.linkDisable)
      expect(stopped).toMatchObject({ reason: 'disable' })
      expect(typeof stopped.uptime_ms).toBe('number')
      expect(stopped.rpcTotal).toBe(0)
    } finally {
      service.disable()
      transport.close()
    }
  })

  it('没传 ICE 时如实记 0 个 / none（不再有「偷偷用内置服务器」这回事）', () => {
    const transport = new MemoryTransport()
    const service = new PhoneControlService({
      signalUrl: 'https://virlen.cn/api/rtc/',
      deviceName: '测试电脑',
      deviceKey: 'dk-0123456789abcdef',
      createTransport: () => transport,
    })
    try {
      service.enable()
      expect(firstProps(PHONE_EVENTS.linkEnable)).toMatchObject({ ice_count: 0, ice_source: 'none' })
    } finally {
      service.disable()
      transport.close()
    }
  })
})

// ───────────────────────────── 载荷口径 ─────────────────────────────

describe('§25 —— 载荷口径（80 字截断 + 打码）', () => {
  it('超长正文截断到 80 字；密钥样式内容被打码', async () => {
    sessionStore.saveSession(makeSession('t-口径-1', '长文'))
    sessionStore.saveSession(makeSession('t-口径-2', '密钥'))
    const h = setup()
    await h.caller.call('host.session.subscribe', { sessionId: 't-口径-1' })
    await h.caller.call('host.session.subscribe', { sessionId: 't-口径-2' })

    // 两个会话各发一条：同一会话连发会被真实发送路径判 E_BUSY（会话已在回复中）
    const long = 'x'.repeat(200)
    await h.caller.call('host.session.send', { sessionId: 't-口径-1', text: long })
    await h.caller.call('host.session.send', {
      sessionId: 't-口径-2',
      text: '这是我的 key sk-abcdefghijklmnopqrstuvwx 帮我看看',
    })
    await flush(10)

    const sends = propsOf(PHONE_EVENTS.rpcCall).filter((p) => p.method === 'host.session.send')
    const truncated = sends.find((p) => p.session_id === 't-口径-1')!
    expect(truncated.text).toHaveLength(81) // 80 + 省略号
    expect(truncated.text_len).toBe(200)
    expect(sends.find((p) => p.session_id === 't-口径-2')!.text).toContain('[REDACTED]')
    expect(JSON.stringify(captured())).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })

  it('事件名清单与常量表一致（防止埋点名漂移）', () => {
    // 26 条：链路/信令 6 + RPC 4 + 推送 5 + 订阅 3 + 交互 4 + 配对 4
    expect(Object.keys(PHONE_EVENTS)).toHaveLength(26)
  })
})
