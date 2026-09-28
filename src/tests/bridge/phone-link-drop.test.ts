/**
 * 「移除」的完整语义 = **删记录 + 断链**（M9 真机需求）。
 *
 * 用户对着「已绑定的手机」点「移除」，期望是那台手机**当场连不上**。原实现只删配对记录：
 * 凭证确实失效了，但**已经建好的链路不会自己断** —— 它会一直操作到链路自己关闭为止
 * （RPC 通道只看凭证的签发时刻，不看之后有没有被移除）。
 *
 * 本文件钉住四条：
 *  1. 移除在线设备 → 当前链路被拆掉，且服务**继续等下一台**（不是停用）；
 *  2. 断链是「原地重开」：**二维码/票据不变**（移除一台手机不该顺带把屏上的码换掉）；
 *  3. 被移除的那台再连 → `revoked`（必须重新扫码）；它手上缓存的那张码也不再有配对权
 *    （M10：否则它会「自动重连 → 又换出一台新设备」，用户的观感就是移除没用）；
 *  4. 没启用服务时 `dropLink()` 是空操作（不能凭空建一条链路）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createCaller,
  createMemoryPair,
  type HelloResult,
  type HostApi,
} from 'virlen-remote'
import { PairingStore, PhoneControlService, type PairingSnapshot, type PhoneControlOptions } from '@/bridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const DEVICE_KEY = 'dk-0123456789abcdef'
const MOBILE_KEY = 'mk-fedcba9876543210'

function baseOptions(overrides: Partial<PhoneControlOptions> = {}): PhoneControlOptions {
  return {
    signalUrl: 'https://virlen.cn/api/rtc',
    deviceName: '我的电脑',
    deviceKey: DEVICE_KEY,
    ...overrides,
  }
}

/** 一条 hello 调用（与 `phone-control.test.ts` 同一口径）。 */
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
 * 建服务，并**保证每次建链路都给一对新的 memory transport** —— `dropLink()` 会原地重开一条，
 * 测试得能分别观察「旧的那条（应被关掉）」与「新的那条（应能接客）」。
 */
function setup(overrides: Partial<PhoneControlOptions> = {}) {
  const links: Array<[MemoryTransport, MemoryTransport]> = []
  const pairing = new PairingStore()
  const changes: PairingSnapshot[] = []
  pairing.onChange = (snap) => changes.push(snap)

  const service = new PhoneControlService(
    baseOptions({
      pairing,
      createTransport: () => {
        const [host, mobile] = createMemoryPair()
        links.push([host, mobile])
        return host
      },
      ...overrides,
    }),
  )

  const endpoints: Endpoint[] = []
  const callers = new Map<number, ReturnType<typeof createCaller<HostApi>>>()
  /** 手机端 caller：默认取**最新**那条链路（手机重连后走的就是它）。 */
  function mobile(index = links.length - 1) {
    const cached = callers.get(index)
    if (cached) return cached
    const endpoint = new Endpoint({ transport: links[index][1] })
    endpoints.push(endpoint)
    const caller = createCaller<HostApi>(endpoint)
    callers.set(index, caller)
    return caller
  }

  cleanups.push(() => {
    service.disable()
    for (const endpoint of endpoints) endpoint.dispose()
    for (const [host, peer] of links) {
      host.close()
      peer.close()
    }
  })

  service.enable()
  return { service, pairing, changes, links, mobile }
}

describe('移除正在连接的手机 → 链路当场断掉', () => {
  it('当前链路被拆掉，且服务继续等下一台（不是停用）', async () => {
    const { service, pairing, links, mobile } = setup({ confirmPair: async () => true })
    await hello(mobile(), service.pairingPayload().ticket)
    const device = pairing.list()[0]
    expect(pairing.activeDeviceId).toBe(device.deviceId)

    // 设置页「移除」此刻做的两件事：删记录 + 让服务断链（store 侧接线见 ui 用例）
    pairing.revoke(device.deviceId)
    service.dropLink()

    // ① 那台手机这条链路真的断了（不是「等它下次重连才发现」）
    expect(links[0][0].state).toBe('closed')
    expect(pairing.list()).toEqual([])
    expect(pairing.activeDeviceId).toBe(null)
    // ② 服务没停：仍在等下一台（停用会说 disabled，且屏上的二维码也会作废）
    expect(service.getStatus()).toBe('waiting')
    // ③ 断链是「原地重开」——已经有一条新链路在等
    expect(links).toHaveLength(2)
  })

  it('断链重开**不换二维码**（移除一台手机不该顺带把屏上的码换掉）', async () => {
    const { service, mobile } = setup({ confirmPair: async () => true })
    await hello(mobile(), service.pairingPayload().ticket)

    const before = service.pairingPayload().ticket
    service.dropLink()

    expect(service.pairingPayload().ticket).toBe(before)
  })

  it('断链重开后，下一台手机扫码仍能配对（服务真的还在等）', async () => {
    const { service, pairing, links, mobile } = setup({ confirmPair: async () => true })
    await hello(mobile(), service.pairingPayload().ticket)
    pairing.revoke(pairing.list()[0].deviceId)
    service.dropLink()

    const fresh: HelloResult = await hello(mobile(), service.pairingPayload().ticket)

    expect(fresh.grant?.token).toMatch(/^gt-/)
    expect(links).toHaveLength(2)
    expect(pairing.list()).toHaveLength(1)
    expect(pairing.activeDeviceId).toBe(pairing.list()[0].deviceId)
  })

  it('被移除的那台拿旧凭证再连 → revoked（必须重新扫码）', async () => {
    const { service, pairing, mobile } = setup({ confirmPair: async () => true })
    const first: HelloResult = await hello(mobile(), service.pairingPayload().ticket)

    pairing.revoke(pairing.list()[0].deviceId)
    service.dropLink()

    await expect(hello(mobile(), first.grant!.token)).rejects.toMatchObject({
      code: 'E_DENIED',
      data: { reason: 'revoked' },
    })
  })

  /**
   * M10 真机反馈：手机断开后会**自动重连**，并把手上缓存的那张码（或截屏里的）再交一次。
   * 光删记录是不够的 —— 票本身就是「配对权」，交一次就能换出一台**新**设备。
   */
  it('移除后，此前发出去的那张码**不再能配对**（手机缓存着它也换不出新设备）', async () => {
    const { service, pairing, mobile } = setup({ confirmPair: async () => true })
    // 手机扫的就是这张码 —— 它会把它缓存下来，断开重连时再交一次
    const scanned = service.pairingPayload().ticket
    await hello(mobile(), scanned)

    pairing.revoke(pairing.list()[0].deviceId)
    service.dropLink()

    // ① 那张码本身已作废（不是「码还在、只是设备被删了」）
    expect(pairing.hasValidTicket(scanned)).toBe(false)
    // ② 再交一次 → 换不出设备。reason 是 `revoked`：墓碑优先于「票过期」告诉手机「你被移除了」
    await expect(hello(mobile(), scanned)).rejects.toMatchObject({
      code: 'E_DENIED',
      data: { reason: 'revoked' },
    })
    expect(pairing.list()).toEqual([])
  })

  it('移除后屏上的码换新：那张新码照样能配对（别的手机不受影响）', async () => {
    const { service, pairing, mobile } = setup({ confirmPair: async () => true })
    const scanned = service.pairingPayload().ticket
    await hello(mobile(), scanned)

    pairing.revoke(pairing.list()[0].deviceId)
    service.dropLink()

    const fresh = service.pairingPayload().ticket
    expect(fresh).not.toBe(scanned)

    const granted: HelloResult = await hello(mobile(), fresh)
    expect(granted.grant?.token).toMatch(/^gt-/)
    expect(pairing.list()).toHaveLength(1)
  })
})

describe('dropLink 的边界', () => {
  it('服务未启用时是空操作：不会凭空建出一条链路', () => {
    const service = new PhoneControlService(
      baseOptions({
        createTransport: () => {
          throw new Error('未启用就不该建链路')
        },
      }),
    )
    cleanups.push(() => service.disable())

    service.dropLink()

    expect(service.getStatus()).toBe('disabled')
  })
})
