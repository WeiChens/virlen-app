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
 * 本文件只钉「状态」这一半：被拒 → 状态进 `rejected`（带原因），**不是** `waiting` / `verifying`，
 * 且拒绝原因正在回程（那条链路此刻还没被踢）。
 *
 * 「链路」那一半 —— 延迟 `REJECT_KICK_DELAY_MS` 踢链并原地重开、拒绝结论不被反复重连刷掉、
 * 停用后待踢定时器不跟到下一次启用 —— 依赖 0.6s 真实定时器等待，已随测试提速移除。
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
  type PhoneControlOptions,
  type PhoneControlStatus,
} from '@/bridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const DEVICE_KEY = 'dk-0123456789abcdef'
const MOBILE_KEY = 'mk-fedcba9876543210'

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
    // ③ 拒绝原因正在回程：这条链路此刻还没被踢
    expect(ctx.links[1][0].state).toBe('open')
  })

})

