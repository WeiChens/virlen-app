/**
 * 电脑端「手机控制」服务测试（M3-4 建立，M6 扩展）。
 *
 * 用 **memory transport** 注入，不依赖 WebRTC / 信令服务器：
 *  - 状态机（waiting → connected → disabled）；
 *  - 配对载荷字段（M6：`host` 是设备 key、一次性票据、房间由 key 派生）；
 *  - **二维码刷新不再作废旧票**（真机竞态回归，§30.2）；
 *  - 首次绑定经桌面确认 → **签发授权凭证**；老设备凭凭证直连（不再确认）；
 *  - 拒绝 / 票据过期 / 凭证过期 / 被移除 → 各给各的理由与文案。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  PAIRING_TICKET_TTL_MS,
  createCaller,
  createMemoryPair,
  type HelloResult,
  type HostApi,
} from 'virlen-remote'
import { PhoneControlService, type PhoneControlOptions, type PhoneControlStatus } from '@/bridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** 稳定的电脑设备 key（真实实现由 `device-identity.ts` 持久化而来）。 */
const DEVICE_KEY = 'dk-0123456789abcdef'
const MOBILE_KEY = 'mk-fedcba9876543210'

function makeService(overrides: Partial<PhoneControlOptions> = {}) {
  return new PhoneControlService({
    signalUrl: 'https://virlen.cn/api/rtc',
    deviceName: '我的电脑',
    deviceKey: DEVICE_KEY,
    ...overrides,
  })
}

/**
 * 建一对 memory 链路、把电脑侧接到 service 上，并返回手机侧 caller。**已 enable。**
 *
 * ⚠️ 必须把 `hostT` 通过 `createTransport` 注入 service —— 否则 service 会去建真的 RtcTransport
 *（测试环境没有 `EventSource` / `RTCPeerConnection`），手机侧发的 hello 永远送不到，
 * 表现为「每个用例都超时」而不是明确的失败。
 */
function setup(overrides: Partial<PhoneControlOptions> = {}) {
  const [hostT, mobileT] = createMemoryPair()
  const service = makeService({ createTransport: () => hostT, ...overrides })
  const mobileEp = new Endpoint({ transport: mobileT })
  const caller = createCaller<HostApi>(mobileEp)
  cleanups.push(() => {
    service.disable()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
  service.enable()
  return { service, caller, hostT, mobileT }
}

/** 一条 hello 调用（缺省带上手机设备 key）。 */
function hello(
  caller: ReturnType<typeof createCaller<HostApi>>,
  token: string | undefined,
  mobileKey: string | null = MOBILE_KEY,
) {
  return caller.call('host.hello', {
    protocolVersion: 1,
    client: { platform: 'test', appVersion: '0' },
    capabilities: [],
    ...(token === undefined ? {} : { token }),
    ...(mobileKey ? { mobileKey, mobileName: '测试手机' } : {}),
  })
}

describe('PhoneControlService —— 配对载荷（M6）', () => {
  it('字段完整：v2 / host=设备 key / 一次性票据 / signal 规范化', () => {
    const service = makeService()
    const p = service.pairingPayload()
    expect(p.v).toBe(2)
    expect(p.host).toBe(DEVICE_KEY)
    expect(p.name).toBe('我的电脑')
    expect(p.ticket).toMatch(/^pr-/)
    expect(p.signal).toBe('https://virlen.cn/api/rtc/')
    // room 不再进载荷：两端都用 roomFor(host) 派生，少一处可漂移的冗余
    expect('room' in p).toBe(false)
    expect(service.room).toBe(`virlen:${DEVICE_KEY}`)
    expect(service.deviceKey).toBe(DEVICE_KEY)
    service.disable()
  })

  it('二维码有到期时刻（设置页倒计时用）', () => {
    const service = makeService()
    service.pairingPayload()
    const deadline = service.ticketDeadline
    expect(deadline).not.toBe(null)
    expect(deadline! - Date.now()).toBeGreaterThan(PAIRING_TICKET_TTL_MS - 2000)
    service.disable()
  })

  it('刷新二维码：换新票，但**不作废旧票**（防扫码在途时被作废）', () => {
    const service = makeService()
    const oldTicket = service.pairingPayload().ticket
    const newTicket = service.refreshTicket().ticket
    expect(newTicket).not.toBe(oldTicket)
    // 真机竞态回归：旧票仍有效（只按 TTL 自然过期）
    expect(service.pairing.hasValidTicket(oldTicket)).toBe(true)
    expect(service.pairing.hasValidTicket(newTicket)).toBe(true)
    service.disable()
  })

  it('票据不会无限堆积：超出上限丢最旧的', () => {
    const service = makeService()
    const issued: string[] = []
    for (let i = 0; i < 12; i += 1) issued.push(service.refreshTicket().ticket)
    expect(service.pendingTickets).toBeLessThanOrEqual(8)
    // 最近一张一定还在
    expect(service.pairing.hasValidTicket(issued[issued.length - 1])).toBe(true)
    service.disable()
  })

  it('rotateTicketIfStale：未到期的票不动；**被扫走（已兑换）**或到期的换新', () => {
    const service = makeService()
    const first = service.pairingPayload().ticket
    expect(service.rotateTicketIfStale()).toBe(false)
    expect(service.pairingPayload().ticket).toBe(first)

    /*
     * 真机缺陷回归：「第一台手机连上后，第二台手机再扫屏幕上那张码 → 二维码已过期」。
     * 兑换 = 票据被删（一次性）。只查 TTL 的旧实现会让这张死票留在屏幕上最长 5 分钟 ——
     * 下一台手机扫它必然被拒（而它的接入在 hello 之前就把已连的那台顶掉了）。
     */
    service.pairing.redeemTicket(first, { mobileKey: MOBILE_KEY, name: '先连上的手机' })
    expect(service.rotateTicketIfStale()).toBe(true)
    const second = service.pairingPayload().ticket
    expect(second).not.toBe(first)
    expect(service.pairing.hasValidTicket(second)).toBe(true)

    // 把「现在」推到 TTL 之后（到期同样换新）
    expect(service.rotateTicketIfStale(Date.now() + PAIRING_TICKET_TTL_MS + 1)).toBe(true)
    expect(service.pairingPayload().ticket).not.toBe(second)
    service.disable()
  })
})

describe('PhoneControlService —— 状态机', () => {
  /**
   * M10 修正：**链路通 ≠ 手机已连上**；M11 再补一刀：**「有人在连」≠「在等手机连」**。
   *
   * 原实现把 `transport` 的 `open` 直接当「已连接」。真机反馈正好踩在这上面：被移除的手机
   * 重连上来、WebRTC 又建好了，界面于是显示「已连接」—— 而它手上那张票 / 凭证早就作废了。
   * 改成「等握手」之后又留下另一个含糊：链路 open 一律写成「等待手机握手…」，
   * 用户读到的是「我在等它连上」，而事实往往是「刚才被移除的那台又摸进来了」。
   * 现在这段落进 `verifying`（有人接入了、还没证明它是谁），否定结论另走 `rejected`。
   */
  it('enable → waiting；链路 open → verifying（有人接入，尚未证明它是谁）；disable → disabled', () => {
    const transport = new MemoryTransport() // 初始 connecting
    const statuses: PhoneControlStatus[] = []
    const details: Array<string | undefined> = []
    const service = makeService({
      createTransport: () => transport,
      onStatusChange: (s, detail) => {
        statuses.push(s)
        details.push(detail)
      },
    })
    service.enable()
    expect(service.getStatus()).toBe('waiting')

    transport.open() // 模拟 DataChannel 就绪
    expect(service.getStatus()).toBe('verifying')
    // 不再是「等待手机握手…」：链路已通，没人在等谁
    expect(details).not.toContain('链路已建立，等待手机握手…')

    service.disable()
    expect(service.getStatus()).toBe('disabled')
    expect(statuses).toContain('waiting')
    expect(statuses[statuses.length - 1]).toBe('disabled')
  })

  it('hello 通过 → connected（授权了才算连上）', async () => {
    const { service, caller } = setup()
    expect(service.getStatus()).toBe('waiting')

    await hello(caller, service.pairingPayload().ticket)

    expect(service.getStatus()).toBe('connected')
  })

  it('hello 被拒（已被移除）→ `rejected` + 原因（不是含糊的「还在等」）', async () => {
    const details: Array<string | undefined> = []
    const statuses: PhoneControlStatus[] = []
    const { service, caller } = setup({
      onStatusChange: (s, detail) => {
        statuses.push(s)
        details.push(detail)
      },
    })
    const device = service.pairing.register('手机', { mobileKey: MOBILE_KEY })
    service.pairing.revoke(device.deviceId)

    await expect(hello(caller, device.token)).rejects.toMatchObject({ code: 'E_DENIED' })

    // 拒绝是一个**已成立的否定结论**：界面必须说「已拒绝接入（该手机已被移除）」，
    // 而不是「等待手机连接…」—— 后者会被读成「我在等它」，与事实相反
    expect(service.getStatus()).toBe('rejected')
    expect(statuses).toContain('rejected')
    expect(details).toContain('该手机已被移除')
  })
})

describe('PhoneControlService —— 首次绑定与授权凭证（M6）', () => {
  it('票据首次兑换 → 弹确认 → 签发凭证；老设备凭凭证直连不再确认', async () => {
    const calls: string[] = []
    const { service, caller } = setup({
      confirmPair: async ({ token }) => {
        calls.push(token)
        return true
      },
    })

    const ticket = service.pairingPayload().ticket
    const first: HelloResult = await hello(caller, ticket)
    expect(calls).toEqual([ticket])
    expect(first.deviceId).toBe(DEVICE_KEY)
    expect(first.deviceName).toBe('我的电脑')
    expect(first.grant?.token).toMatch(/^gt-/)
    expect(first.grant!.expiresAt - first.grant!.issuedAt).toBeGreaterThan(29 * 24 * 3600_000)

    // 电脑端记下了这台手机（含 key 与凭证）
    const [device] = service.pairing.list()
    expect(device.mobileKey).toBe(MOBILE_KEY)
    expect(device.name).toBe('测试手机')
    expect(device.token).toBe(first.grant!.token)

    // 再次连接：用凭证（不是票据）→ 不再确认
    const second = await hello(caller, first.grant!.token)
    expect(calls).toEqual([ticket])
    expect(second.grant?.token).toBe(first.grant!.token)
  })

  it('一次性票据只能用一次（兑换后再拿票来 → E_DENIED）', async () => {
    const { service, caller } = setup()

    const ticket = service.pairingPayload().ticket
    await hello(caller, ticket)
    await expect(hello(caller, ticket)).rejects.toMatchObject({ code: 'E_DENIED' })
  })

  it('桌面拒绝确认 → E_DENIED，且**不登记**任何设备', async () => {
    const { service, caller } = setup({ confirmPair: async () => false })

    await expect(hello(caller, service.pairingPayload().ticket)).rejects.toMatchObject({
      code: 'E_DENIED',
    })
    expect(service.pairing.list()).toEqual([])
    // 票据没被消费（用户点错拒绝还能扫同一张码重来）
    expect(service.pairing.pendingTickets()).toBeGreaterThan(0)
  })

  it('无效令牌 → E_DENIED，不触发确认', async () => {
    let called = false
    const { caller } = setup({
      confirmPair: async () => {
        called = true
        return true
      },
    })

    await expect(hello(caller, 'bogus')).rejects.toMatchObject({ code: 'E_DENIED' })
    expect(called).toBe(false)
  })

  it('凭证过期 → E_DENIED(data.reason=expired)（手机端据此提示重新扫码）', async () => {
    const { service, caller } = setup()

    await hello(caller, service.pairingPayload().ticket)
    const [device] = service.pairing.list()
    // 直接改到已过期（等价于「到期后一直没连过」）
    device.expiresAt = Date.now() - 1000

    await expect(hello(caller, device.token)).rejects.toMatchObject({
      code: 'E_DENIED',
      data: { reason: 'expired' },
    })
  })

  it('二维码过期 → E_DENIED(data.reason=ticket-expired)（提示「请刷新二维码」）', async () => {
    const { service, caller } = setup()

    const ticket = service.pairingPayload().ticket
    // 把票据改成「已过期」
    service.pairing.restore({
      devices: [],
      tickets: [{ token: ticket, issuedAt: Date.now() - PAIRING_TICKET_TTL_MS - 1000 }],
    })
    await expect(hello(caller, ticket)).rejects.toMatchObject({
      code: 'E_DENIED',
      data: { reason: 'ticket-expired' },
    })
  })

  it('电脑端「移除」后：该手机再连 → E_DENIED(data.reason=revoked)，必须重新扫码', async () => {
    const { service, caller } = setup()

    const first = await hello(caller, service.pairingPayload().ticket)
    const [device] = service.pairing.list()
    expect(service.pairing.revoke(device.deviceId)).toBe(true)
    expect(service.pairing.list()).toEqual([])

    await expect(hello(caller, first.grant!.token)).rejects.toMatchObject({
      code: 'E_DENIED',
      data: { reason: 'revoked' },
    })
    // 重新扫码 → 又能配对（票据路径不受移除影响）
    const again = await hello(caller, service.pairingPayload().ticket)
    expect(again.grant?.token).toMatch(/^gt-/)
  })

  it('凭证与手机 key 绑定：换个手机 key 拿同一凭证 → E_DENIED', async () => {
    const { service, caller } = setup()

    const first = await hello(caller, service.pairingPayload().ticket)
    await expect(hello(caller, first.grant!.token, 'mk-9999999999999999')).rejects.toMatchObject({
      code: 'E_DENIED',
    })
  })

  it('旧版手机（不带 key）能用凭证连上，并在下次带 key 时回填绑定', async () => {
    const { service, caller } = setup()

    // 旧版路径：票据兑换时也不带 mobileKey
    const first = await hello(caller, service.pairingPayload().ticket, null)
    expect(service.pairing.list()[0].mobileKey).toBe(null)

    // 之后手机端升级，带 key 直连 → 回填
    await hello(caller, first.grant!.token, MOBILE_KEY)
    expect(service.pairing.list()[0].mobileKey).toBe(MOBILE_KEY)
  })

  it('每次成功连接都会滑动续期（到期时间被推后）', async () => {
    const { service, caller } = setup()

    const first = await hello(caller, service.pairingPayload().ticket)
    const before = first.grant!.expiresAt
    // 人为把到期时间提前 10 天，再连一次 —— 应被续回到 ~30 天
    const [device] = service.pairing.list()
    device.expiresAt = before - 10 * 24 * 3600_000

    const second: HelloResult = await hello(caller, first.grant!.token)
    expect(second.grant!.expiresAt).toBeGreaterThan(device.expiresAt)
    expect(second.grant!.expiresAt - Date.now()).toBeGreaterThan(29 * 24 * 3600_000)
    // 凭证串本身不变（换串会让内存里的重连参数失效）
    expect(second.grant!.token).toBe(first.grant!.token)
  })

  it('设置页要的字段都在：deviceId / mobileKey / 凭证 / 上次连接', async () => {
    const { service, caller } = setup()
    const first = await hello(caller, service.pairingPayload().ticket)
    const [device] = service.pairing.list()
    expect(device.deviceId).toMatch(/^dev-/)
    expect(device.token).toBe(first.grant!.token)
    expect(device.issuedAt).toBeGreaterThan(0)
    expect(device.expiresAt).toBeGreaterThan(device.issuedAt)
    expect(device.pairedAt).toBeGreaterThan(0)
    expect(device.lastSeenAt).toBeGreaterThan(0)
  })
})
