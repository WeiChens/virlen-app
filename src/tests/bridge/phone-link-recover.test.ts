/**
 * 「出错（链路已关闭）」不是终点 —— 过几秒仍未恢复就**原地重开**（真机反馈）。
 *
 * 缺陷现场：电脑端停在「出错（链路已关闭）」，几秒后还是它，**手机再也连不回来**。
 *
 * 根因不在状态文案，而在链路本身：`closed` 是**终态** —— 它来自 PeerConnection 的
 * `failed` / `closed`（见共享包 `rtc.ts::onConnectionState`），那条 PC 已经不可恢复；
 * 而 host 角色的下一次协商仍会复用它（`rtc.ts::ensurePC` 的 `if (this.pc) return this.pc`）
 * —— 手机重新进房间、信令也把 `peer-joined` 送达了，电脑端却只是对着一条死 PC 发 offer，
 * 链路永远建不起来。旧实现里唯一出路是用户去设置页手动关掉再打开。
 *
 * 本文件钉住四条：
 *  1. `closed` → 状态先进 `error`（如实报出「链路已关闭」），且**观察窗内不急着重建**；
 *  2. 到点仍在 `error` → 原地重开（服务保持启用、票据不变），**手机能重新连上**（原始缺陷的正面断言）；
 *  3. 链路在观察窗内自己回来（`open`）→ 不白拆一次；
 *  4. 服务已停用 / 拒绝结论生效期间，一律不触发复位。
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
  LINK_CLOSED_RECOVER_MS,
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
 * 建服务，并**保证每次建链路都给一对新的 memory transport** —— 复位会原地重开一条，
 * 用例得能分别观察「死掉的那条」与「新开的那条」。
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

describe('链路已关闭 → 延时自动复位（重新等待手机连接）', () => {
  it(
    '到点仍在 `error` → 原地重开，且手机能重新连上（不会再被一条死 PC 卡住）',
    async () => {
      const ctx = setup()
      // 先让一台手机正常连上，再模拟链路被判定为终态（真机来源：PC failed / closed）
      const first: HelloResult = await hello(ctx.mobile(), ctx.service.pairingPayload().ticket)
      expect(ctx.service.getStatus()).toBe('connected')
      const ticket = ctx.service.pairingPayload().ticket

      ctx.links[0][0].close()
      expect(ctx.service.getStatus()).toBe('error')
      expect(ctx.details).toContain('链路已关闭')

      // ① 观察窗内不急着重建：对端的短抖动（切网 / 息屏）可能自己就回来了
      await flush(LINK_CLOSED_RECOVER_MS - 800)
      expect(ctx.links).toHaveLength(1)
      expect(ctx.service.getStatus()).toBe('error')

      // ② 到点仍在 error → 拆掉重开：服务保持启用、回到「等待手机连接…」
      await flush(1200)
      expect(ctx.links[0][0].state).toBe('closed')
      expect(ctx.links).toHaveLength(2)
      expect(ctx.service.getStatus()).toBe('waiting')
      // 票据不变（复位不是「停用重开」，屏上的码照旧可用）
      expect(ctx.service.pairingPayload().ticket).toBe(ticket)

      // ③ 原始缺陷的正面断言：手机**重新连得回来**（旧实现里它会永远卡在死 PC 上）
      const again: HelloResult = await hello(ctx.mobile(1), first.grant!.token)
      expect(again.grant?.token).toBe(first.grant!.token)
      expect(ctx.service.getStatus()).toBe('connected')
    },
    20_000,
  )

  it(
    '观察窗内链路自己回来了（`open`）→ 不白拆一次',
    async () => {
      const ctx = setup()
      ctx.links[0][0].close()
      expect(ctx.service.getStatus()).toBe('error')

      // 对端自己的重连把链路带回可用态（服务进 `verifying`，等握手出结论）
      ctx.links[0][0].open()
      expect(ctx.service.getStatus()).toBe('verifying')

      await flush(LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(1)
      expect(ctx.service.getStatus()).toBe('verifying')
    },
    20_000,
  )

  it(
    '服务已停用 → 不再建任何链路（复位不能凭空把服务拉起来）',
    async () => {
      const ctx = setup()
      ctx.links[0][0].close()
      ctx.service.disable()
      expect(ctx.service.getStatus()).toBe('disabled')

      await flush(LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(1)
      expect(ctx.service.getStatus()).toBe('disabled')
    },
    20_000,
  )

  it(
    '拒绝结论生效期间不安排复位（拆链由踢链负责，不能多拆一次）',
    async () => {
      const ctx = setup()
      const granted: HelloResult = await hello(ctx.mobile(), ctx.service.pairingPayload().ticket)
      // 设置页「移除」：删记录 + 断链重开
      ctx.pairing.revoke(ctx.pairing.list()[0].deviceId)
      ctx.service.dropLink()
      expect(ctx.links).toHaveLength(2)

      // 被移除的那台重连 → 被拒（状态进 `rejected`，那条链路此刻还活着）
      await expect(hello(ctx.mobile(1), granted.grant!.token)).rejects.toMatchObject({
        code: 'E_DENIED',
      })
      expect(ctx.service.getStatus()).toBe('rejected')
      // 它那条链路随后关闭：状态**保持** `rejected`（链路事件在这段时间不参与状态机）
      ctx.links[1][0].close()
      expect(ctx.service.getStatus()).toBe('rejected')

      // 等到「踢链」与「复位」两个时限都过去：只该有踢链产生的那一条新链路
      await flush(REJECT_KICK_DELAY_MS + LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(3)
      expect(ctx.service.getStatus()).toBe('rejected')
      expect(ctx.details).not.toContain('链路已关闭')
    },
    20_000,
  )
})
