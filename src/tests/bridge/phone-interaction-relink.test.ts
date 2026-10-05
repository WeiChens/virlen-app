/**
 * 待应答交互必须**跨链路存活**（真机缺陷回归，2026-10）。
 *
 * 现象（用户原话大意）：AI 调 `user_choice` 时手机端看不到卡片；若卡片还残留在手机上，
 * 点一下得到「该请求已在电脑上处理」—— 而电脑端**根本没人答过**（弹窗还挂着、引擎还在等）；
 * 「断开重新连接」也救不回来。
 *
 * 根因：交互注册表原先挂在**链路**上（`startPhoneBridge` 内自建、随 `bridge.dispose()` 丢弃）。
 * 而电脑侧换链路是常态 —— `closed` 自愈、`open` 后 8s 未握手、移除手机、改 ICE
 * （见 `phone-control.ts` 的四条 `dropLink` 路径）—— 一换就把排队中的交互连表一起丢掉，
 * 手机侧再拉 `host.interaction.list` 也拿不回来（新链路的表天然是空的）。
 *
 * 本文件钉住三条：
 *  1. `dropLink()`（换链路）之后，待应答交互**仍在**，并且能在**新链路**上被应答；
 *  2. 换链路后**新登记**的交互照样推到新链路（推送出口自动指向新链路）；
 *  3. **换服务实例**（改 ICE：`RTCPeerConnection` 的 `iceServers` 只能构造时给）后同样在位 ——
 *     这正是表要归调用方（设置页 store）持有的原因。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createCaller,
  createMemoryPair,
  type HelloResult,
  type HostApi,
  type InteractionDTO,
} from 'virlen-remote'
import toolInteractEvent from '@/events/toolInteractEvent'
import { PairingStore, PhoneControlService, createInteractionRegistry, type PhoneControlOptions } from '@/bridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const DEVICE_KEY = 'dk-0123456789abcdef'
const MOBILE_KEY = 'mk-fedcba9876543210'

/** 一条 hello 调用（与 `phone-link-drop.test.ts` 同一口径）。 */
function hello(
  caller: ReturnType<typeof createCaller<HostApi>>,
  token: string,
  mobileKey: string | null = MOBILE_KEY,
) {
  return caller.call('host.hello', {
    protocolVersion: 1,
    client: { platform: 'test', appVersion: '0' },
    capabilities: [],
    token,
    ...(mobileKey ? { mobileKey, mobileName: '测试手机' } : {}),
  })
}

/**
 * 建服务，并保证每次建链路都给一对新的 memory transport —— `dropLink()` 会原地重开一条，
 * 用例要能分别观察「旧的那条（应被关掉）」与「新的那条（应能接客）」。
 */
function setup(overrides: Partial<PhoneControlOptions> = {}) {
  const links: Array<[MemoryTransport, MemoryTransport]> = []
  const pairing = new PairingStore()

  const service = new PhoneControlService({
    signalUrl: 'https://virlen.cn/api/rtc',
    deviceName: '我的电脑',
    deviceKey: DEVICE_KEY,
    pairing,
    createTransport: () => {
      const [host, mobile] = createMemoryPair()
      links.push([host, mobile])
      return host
    },
    ...overrides,
  })

  const endpoints: Endpoint[] = []
  const callers = new Map<number, ReturnType<typeof createCaller<HostApi>>>()
  /** 手机端**端点**：默认取最新那条链路（需要订阅事件时用它，`caller` 上没有 `subscribe`）。 */
  function mobileEndpoint(index = links.length - 1) {
    const existing = endpoints[index]
    if (existing) return existing
    const endpoint = new Endpoint({ transport: links[index][1], defaultTimeoutMs: 2000 })
    endpoints[index] = endpoint
    return endpoint
  }
  /** 手机端 caller：默认取最新那条链路（手机重连后走的就是它）。 */
  function mobile(index = links.length - 1) {
    const cached = callers.get(index)
    if (cached) return cached
    const caller = createCaller<HostApi>(mobileEndpoint(index))
    callers.set(index, caller)
    return caller
  }

  cleanups.push(() => {
    service.dispose()
    // `endpoints` 是按链路下标稀疏填的（可能中间有空位）
    for (const endpoint of endpoints) endpoint?.dispose()
    for (const [host, mobileTransport] of links) {
      host.close()
      mobileTransport.close()
    }
  })

  service.enable()
  return { service, links, mobile, mobileEndpoint }
}

/** 一次 AI 提问（= `user_choice` 在电脑侧的真实入口，见 `interaction-source.ts`）。 */
function askUser(interactionId: string, sessionId = 's-1') {
  toolInteractEvent.emit('showChoice', {
    interactionId,
    sessionId,
    toolCallId: 'tc-1',
    question: '选哪个？',
    options: ['A', 'B'],
    multi: false,
  })
}

describe('待应答交互跨链路存活（真机缺陷回归）', () => {
  it('dropLink 换链路后，交互仍在，且能在新链路上被应答', async () => {
    const { service, links, mobile } = setup({ confirmPair: async () => true })

    const first: HelloResult = await hello(mobile(), service.pairingPayload().ticket)
    expect(first.grant?.token).toMatch(/^gt-/)

    // 电脑侧弹出了 AI 提问 → 登记进注册表
    askUser('it-relink')
    const before = await mobile().call('host.interaction.list', {})
    expect(before.interactions.map((i) => i.interactionId)).toEqual(['it-relink'])

    // 换链路（closed 自愈 / 握手超时 / 移除设备 / 改 ICE 走的是同一条 dropLink）
    service.dropLink()
    expect(links).toHaveLength(2)
    await hello(mobile(), service.pairingPayload().ticket)

    // ① 修复点：新链路上**仍然看得见**这条待答交互（修复前这里是 0 条 → 手机上的卡片成为
    //    点不动的僵尸，点一下得「该请求已在电脑上处理」，而电脑端其实还在等）
    const after = await mobile().call('host.interaction.list', {})
    expect(after.interactions.map((i) => i.interactionId)).toEqual(['it-relink'])

    // ② 而且应答落点仍然有效：与桌面点「确认」完全同形的 `resolve` 载荷（含 uiData）
    const resolved: Array<{ id: string; value: unknown }> = []
    const off = toolInteractEvent.on('resolve', (id, value) => resolved.push({ id, value }))
    cleanups.push(off)

    const answer = await mobile().call('host.interaction.answer', {
      interactionId: 'it-relink',
      action: 'choose',
      value: { selected: ['B'], customReply: '' },
    })
    expect(answer).toEqual({ accepted: true })
    expect(resolved).toEqual([{ id: 'it-relink', value: { content: 'B', uiData: { selected: ['B'], customReply: '' } } }])

    // ③ 应答后从表里消失（不会留下二义性：手机再点就是 not-found）
    const gone = await mobile().call('host.interaction.list', {})
    expect(gone.interactions).toEqual([])
  })

  it('换链路后**新登记**的交互照样推到新链路（推送出口自动指向新链路）', async () => {
    const { service, mobile, mobileEndpoint } = setup({ confirmPair: async () => true })
    await hello(mobile(), service.pairingPayload().ticket)

    service.dropLink()
    await hello(mobile(), service.pairingPayload().ticket)

    const pushed: InteractionDTO[] = []
    mobileEndpoint().subscribe('host.event.interaction.requested', (payload) => {
      pushed.push((payload as { interaction: InteractionDTO }).interaction)
    })

    askUser('it-after-relink')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pushed.map((i) => i.interactionId)).toEqual(['it-after-relink'])
  })

  it('改 ICE 换服务实例（表归调用方持有）后，交互仍在且能在新实例上应答', async () => {
    /*
     * 模拟 `phoneControlStore` 的做法：表由 store 持有（`ensureInteractions`），推送出口指向
     * 「当前那个服务实例」（`service?.emitToLink`）。改 ICE = 丢旧实例 + 建新实例
     *（`rebuildService`）—— 表必须活下来。
     */
    let current: PhoneControlService | null = null
    const registry = createInteractionRegistry({
      emit: (topic, payload) => current?.emitToLink(topic, payload),
    })

    const a = setup({ confirmPair: async () => true, interactions: registry })
    current = a.service
    await hello(a.mobile(), a.service.pairingPayload().ticket)

    askUser('it-ice')
    const before = await a.mobile().call('host.interaction.list', {})
    expect(before.interactions.map((i) => i.interactionId)).toEqual(['it-ice'])

    // 换服务实例（真实路径：改 ICE → dispose 旧实例 + 丢引用 + 新建）
    a.service.dispose()
    const b = setup({ confirmPair: async () => true, interactions: registry })
    current = b.service
    await hello(b.mobile(), b.service.pairingPayload().ticket)

    // ① 表跨实例存活：新实例上仍然看得见（修复前这里是 0 条 → 手机上的卡片成为点不动的僵尸）
    const after = await b.mobile().call('host.interaction.list', {})
    expect(after.interactions.map((i) => i.interactionId)).toEqual(['it-ice'])

    // ② 新实例上应答仍然有效
    const answer = await b.mobile().call('host.interaction.answer', {
      interactionId: 'it-ice',
      action: 'choose',
      value: { selected: ['A'], customReply: '' },
    })
    expect(answer).toEqual({ accepted: true })

    // ③ 新实例把「本机交互来源」重新接上了线（旧实例 dispose 时已解绑）
    askUser('it-ice-2')
    const next = await b.mobile().call('host.interaction.list', {})
    expect(next.interactions.map((i) => i.interactionId)).toEqual(['it-ice-2'])
  })

  it('停用 → 解绑接线：关掉期间不登记；重新启用后恢复（已排队的条目**不清**）', async () => {
    /*
     * 接线订阅的是**全局** `toolInteractEvent`，与链路无关 —— 不解绑的话，用户「启用过又关掉」
     * 之后，桌面每次提问 / 授权仍会登记并上报 `phone.interaction.*`（远端根本没人能应答，纯噪音），
     * 而且这些登记的收敛还得靠「桌面应答必广播 `interactionSettled`」这条别的模块的不变量兜着。
     */
    const { service, mobile } = setup({ confirmPair: async () => true })
    await hello(mobile(), service.pairingPayload().ticket)

    askUser('it-on')
    expect(service.interactions.list().map((i) => i.interactionId)).toEqual(['it-on'])

    service.disable()
    askUser('it-while-off')
    // 关掉期间不登记（旧实现：登记 + 上报 → 纯噪音）
    expect(service.interactions.list().map((i) => i.interactionId)).toEqual(['it-on'])

    service.enable()
    askUser('it-on-2')
    // 重新启用 ⇒ 接线回来；且**关闭前**那条仍在（表不清空：本机弹窗与引擎都还在等）
    expect(service.interactions.list().map((i) => i.interactionId)).toEqual(['it-on', 'it-on-2'])
  })
})
