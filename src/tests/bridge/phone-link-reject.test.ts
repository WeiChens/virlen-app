/**
 * 「拒绝」的完整语义 = **状态是否定结论 + 链路一起踢掉**（M11 真机反馈）。
 *
 * 缺陷现场：在设置页点「移除」，那台手机断开后自动重连，电脑端于是显示
 * 「等待手机连接…（链路已建立，等待手机握手…）」。用户的原话是「不应该是直接拒绝吗，
 * 不要搞这么暧昧的状态」。
 *
 * 两件事都不对：
 *  1. **状态**：链路 `open` 一律写成「等待手机握手…」，而真正的结论（`hello` 被拒）只活到下一次
 *     链路事件为止 —— 那台手机每次重连都会把它刷掉，界面上于是永远是一场「等待…」；
 *  2. **链路**：拒绝只发生在 `host.*` 闸门上（见 `phone-auth-gate.test.ts`），链路本身还留着，
 *     那台手机看到的是一个「连上了、但什么都做不了」的就绪态。
 *
 * 本文件钉住四条：
 *  1. 被拒 → 状态进 `rejected`（带原因），**不是** `waiting` / `verifying`；
 *  2. 拒绝原因必须**先送到手机**（`E_DENIED.data.reason`）、链路后踢 —— 反了的话手机只会看到
 *     「连接超时」，与「你已被移除，请重新扫码」正好相反；
 *  3. 踢链：那条链路当场断掉并原地重开（服务继续等下一台，屏上的码照旧可用）；
 *  4. 拒绝结论在那台手机反复重连 / 掉线期间**不被刷掉**，直到下一次成功握手或停用。
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
import {
  PairingStore,
  PhoneControlService,
  REJECT_KICK_DELAY_MS,
  type PhoneControlOptions,
  type PhoneControlStatus,
} from '@/bridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const DEVICE_KEY = 'dk-0123456789abcdef'
const MOBILE_KEY = 'mk-fedcba9876543210'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 一条 hello 调用（与 `phone-control.test.ts` 同一口径）。 */
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

/**
 * 建服务，并**保证每次建链路都给一对新的 memory transport** —— 踢链会原地重开一条，
 * 用例得能分别观察「被踢的那条」与「新开的那条」。
 */
function setup(overrides: Partial<PhoneControlOptions> = {}) {
  const links: Array<[MemoryTransport, MemoryTransport]> = []
  const pairing = new PairingStore()
  const statuses: PhoneControlStatus[] = []
  const details: Array<string | undefined> = []

  const service = new PhoneControlService({
    signalUrl: 'https://virlen.cn/api/rtc',
    deviceName: '我的电脑',
    deviceKey: DEVICE_KEY,
    pairing,
    confirmPair: async () => true,
    createTransport: () => {
      const [host, mobile] = createMemoryPair()
      links.push([host, mobile])
      return host
    },
    onStatusChange: (status, detail) => {
      statuses.push(status)
      details.push(detail)
    },
    ...overrides,
  })

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
  return { service, pairing, links, statuses, details, mobile }
}

/** 配对一台手机 → 电脑端「移除」（删记录 + 断链重开，即设置页那一下）。返回它手上的旧凭证。 */
async function pairThenRemove(ctx: ReturnType<typeof setup>): Promise<string> {
  const granted: HelloResult = await hello(ctx.mobile(), ctx.service.pairingPayload().ticket)
  ctx.pairing.revoke(ctx.pairing.list()[0].deviceId)
  ctx.service.dropLink()
  return granted.grant!.token
}

describe('被移除的手机重连 → 直接拒绝（不是「等待手机握手」）', () => {
  it('状态进 `rejected` 并带上原因；此刻链路还开着（原因正从这条链路上回去）', async () => {
    const ctx = setup()
    const oldGrant = await pairThenRemove(ctx)
    ctx.statuses.length = 0
    ctx.details.length = 0

    // 手机自动重连：新链路（links[1]）上再交一次旧凭证
    await expect(hello(ctx.mobile(1), oldGrant)).rejects.toMatchObject({
      code: 'E_DENIED',
      data: { reason: 'revoked' },
    })

    // ① 否定结论：不是 waiting（在等）/ verifying（在验）/ connected
    expect(ctx.service.getStatus()).toBe('rejected')
    expect(ctx.statuses).toContain('rejected')
    expect(ctx.details).toContain('该手机已被移除')
    // ② 「等待手机握手…」这类暧昧话术从实现里消失（它说的正是「我在等它连上」）
    expect(ctx.details.join('|')).not.toContain('等待手机握手')
    // ③ 拒绝原因正在回程：这条链路此刻还没被踢（踢是延迟的，见下一条）
    expect(ctx.links[1][0].state).toBe('open')
  })

  it('踢链：那条链路当场断掉，并原地重开（服务继续等下一台）', async () => {
    const ctx = setup()
    const oldGrant = await pairThenRemove(ctx)
    await expect(hello(ctx.mobile(1), oldGrant)).rejects.toMatchObject({ code: 'E_DENIED' })
    expect(ctx.links).toHaveLength(2)
    expect(ctx.service.getStatus()).toBe('rejected')

    await flush(REJECT_KICK_DELAY_MS + 60)

    // ① 它那条链路真的断了（不是「等它下次重连才发现」）
    expect(ctx.links[1][0].state).toBe('closed')
    // ② 原地重开：服务没停，屏上的码照旧可用 —— 拒的是那台手机，不是本次服务
    expect(ctx.links).toHaveLength(3)
    expect(ctx.service.getStatus()).toBe('rejected')
  })

  it('它反复重连 / 掉线都不改状态：拒绝结论留到下一次成功握手或停用', async () => {
    const ctx = setup()
    const oldGrant = await pairThenRemove(ctx)
    await expect(hello(ctx.mobile(1), oldGrant)).rejects.toMatchObject({ code: 'E_DENIED' })
    await flush(REJECT_KICK_DELAY_MS + 60)

    // 它又摸回来：链路再次 open。以前这一步会把状态刷成「等待手机握手…」（就是用户看到的那一幕）
    ctx.links[2][0].close()
    ctx.links[2][0].open()
    expect(ctx.service.getStatus()).toBe('rejected')

    // 它又走了：链路 closed 也不该把它顶成「出错（链路已关闭）」
    ctx.links[2][0].close()
    expect(ctx.service.getStatus()).toBe('rejected')
    expect(ctx.details).not.toContain('链路已关闭')
  })

  it('下一次成功握手（重新扫屏上那张新码）之后，拒绝结论作废、链路事件重新说话', async () => {
    const ctx = setup()
    const oldGrant = await pairThenRemove(ctx)
    await expect(hello(ctx.mobile(1), oldGrant)).rejects.toMatchObject({ code: 'E_DENIED' })
    await flush(REJECT_KICK_DELAY_MS + 60)

    // 移除时已换过一张新码（`phoneControlStore.revokeDevice`），别的手机扫它照常能配
    const fresh: HelloResult = await hello(ctx.mobile(2), ctx.service.pairingPayload().ticket)

    expect(fresh.grant?.token).toMatch(/^gt-/)
    expect(ctx.service.getStatus()).toBe('connected')

    // 结论作废之后链路事件又能写状态了（探针：`closed` 应把它改成「出错（链路已关闭）」）
    ctx.links[2][0].close()
    expect(ctx.service.getStatus()).toBe('error')
    expect(ctx.details).toContain('链路已关闭')
  })

  it('停用 = 从头再来：拒绝结论与待踢的定时器都不跟到下一次启用', async () => {
    const ctx = setup()
    const oldGrant = await pairThenRemove(ctx)
    await expect(hello(ctx.mobile(1), oldGrant)).rejects.toMatchObject({ code: 'E_DENIED' })
    expect(ctx.service.getStatus()).toBe('rejected')

    ctx.service.disable()
    expect(ctx.service.getStatus()).toBe('disabled')

    ctx.service.enable()
    expect(ctx.service.getStatus()).toBe('waiting')
    // 停用时那条待踢的定时器已被取消：等到它本该触发的时刻，也不该再动一次链路
    const linksAfterEnable = ctx.links.length
    await flush(REJECT_KICK_DELAY_MS + 60)
    expect(ctx.links).toHaveLength(linksAfterEnable)
  })
})
