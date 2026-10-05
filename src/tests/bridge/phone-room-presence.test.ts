/**
 * 「原地重开」的两道护栏 —— 2026-10 真机缺陷回归。
 *
 * **缺陷现场**：手机连过一次，后来断开了。此后电脑端一直显示「等待手机连接…」，
 * 而手机上看到的是「电脑不在线」，怎么点连接都连不上。
 *
 * 两边其实都没看错：**信令房间里真的已经没有这台电脑了**，错的只是电脑端自己 ——
 * 它以为自己只是在等人。两条独立的成因，这里各钉一条：
 *
 *  1. **迟到的 `connecting` 把自愈拆掉**：`closed` 是终态（那条 PC 已 failed / closed，
 *     且仍会被下一次协商复用），电脑端据此排好「过 `LINK_CLOSED_RECOVER_MS` 原地重开」；
 *     而紧跟其后的 `connecting` 往往只是**拆链的余音**（对端离开的 `peer-left`、
 *     被关掉的 DataChannel 的 close 事件）。旧实现让它们把状态写回「等待手机连接…」，
 *     复位到点一看「已经不是 error 了」就放弃 —— **再也回不来**，只有用户去关一次再开。
 *     （共享包侧也修了同一个根：主动拆链不再补发事件，见 `virlen-remote` 的
 *     `rtc.ts::teardownPeer` 与它的被顶号用例；这里是电脑端自己的第二道网。）
 *  2. **从头到尾没有事件**：房间里的「在线」完全取决于 SSE 事件流活着 —— 它静默死掉
 *     （代理超时 / 服务重启 / 换链那一刻网络未就绪）时本机收不到任何东西，状态机无从得知
 *     「服务端已经不认识我了」。故服务按 `ROOM_PRESENCE_CHECK_MS` 拿手机端那份事实反查自己
 *     （`verifyRoomPresence`），对不上就如实报出并原地重开。
 *
 * 另有三条**反面**断言（防「修过头」）：手机主动走开不算故障；链路真的回到 `open` 就不白拆；
 * 问不到结论（`null` / 请求抛错）与「有手机正连着」这两种情况一律不动链路。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createCaller,
  roomFor,
  type HelloResult,
  type HostApi,
  type TransportState,
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

/**
 * 能模拟「链路回到 `connecting`」的内存链路。
 *
 * 真实 RTC 链路里 `disconnected` / `dc.onclose` 都映射到 `connecting`（**不是** `closed`），
 * 而 `MemoryTransport` 的公开辅助只有 `open` / `disconnect`(→closed) / `reconnect` ——
 * 少了这一档，真机上最常见的那条「拆链余音」就测不到（口径同 `phone-pairing-sync.test.ts`）。
 */
class StallingTransport extends MemoryTransport {
  stall(): void {
    ;(this as unknown as { setState(state: TransportState): void }).setState('connecting')
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
 * 建服务，并**保证每次建链路都给一对新的内存链路** —— 原地重开会换一条，用例得能分别观察
 * 「死掉的那条」与「新开的那条」。链路成对即 `open`（与 `createMemoryPair` 同口径）。
 */
function setup(overrides: Partial<PhoneControlOptions> = {}) {
  const links: Array<[StallingTransport, MemoryTransport]> = []
  const statuses: PhoneControlStatus[] = []
  const details: Array<string | undefined> = []
  const pairing = new PairingStore()

  const service = new PhoneControlService({
    signalUrl: 'https://virlen.cn/api/rtc',
    deviceName: '我的电脑',
    deviceKey: DEVICE_KEY,
    pairing,
    confirmPair: async () => true,
    createTransport: () => {
      const host = new StallingTransport()
      const mobile = new MemoryTransport()
      host.peer = mobile
      mobile.peer = host
      host.open()
      mobile.open()
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

  /** 第 `index` 条链路的电脑端（`stall()` / `disconnect()` 都打在它身上）。 */
  function host(index = links.length - 1): StallingTransport {
    return links[index][0]
  }

  cleanups.push(() => {
    service.disable()
    for (const endpoint of endpoints) endpoint.dispose()
    for (const [hostT, peer] of links) {
      hostT.close()
      peer.close()
    }
  })

  service.enable()
  return { service, pairing, links, statuses, details, mobile, host }
}

describe('链路已报 `closed` 之后：迟到的 `connecting` 不许撤销原地重开', () => {
  it(
    '到点仍原地重开（旧实现停在这里：电脑端「等待手机连接…」、手机端「电脑不在线」）',
    async () => {
      const ctx = setup()

      // 手机接进来过（链路通）→ 那条 PC 死了：真机来源是 `failed` / `closed`
      ctx.host().disconnect()
      expect(ctx.service.getStatus()).toBe('error')
      expect(ctx.details).toContain('链路已关闭')

      // 拆链的余音：对端离开的 `peer-left` / 被关掉的 DataChannel 的 close 事件
      ctx.host().stall()
      expect(ctx.service.getStatus()).toBe('error')

      await flush(LINK_CLOSED_RECOVER_MS + 300)
      // 真的重开了一条（不是停在原地等一个永远不会来的手机）
      expect(ctx.links).toHaveLength(2)
      expect(ctx.statuses[ctx.statuses.length - 1]).toBe('waiting')
    },
    20_000,
  )

  it(
    '手机主动走开（`connecting`，没有 `closed`）→ 照常回「等待手机连接…」，不白拆一条',
    async () => {
      const ctx = setup()
      ctx.host().stall()

      expect(ctx.service.getStatus()).toBe('waiting')
      await flush(LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(1)
    },
    20_000,
  )

  it(
    '观察窗内链路真的回到 `open` → 清掉「已关闭」标记，之后的抖动照常等（不误拆）',
    async () => {
      const ctx = setup()
      ctx.host().disconnect()
      expect(ctx.service.getStatus()).toBe('error')

      ctx.host().open() // 手机自己重连回来了（服务进 `verifying`，等握手出结论）
      expect(ctx.service.getStatus()).toBe('verifying')

      await flush(LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(1)
      expect(ctx.service.getStatus()).toBe('verifying')
    },
    20_000,
  )
})

describe('房间在线自检（`verifyRoomPresence`）', () => {
  it(
    '自检说「房间里没有本机」→ 如实报「信令连接已断开」，并原地重开',
    async () => {
      const probes: string[] = []
      const ctx = setup({
        probeRoom: async (room) => {
          probes.push(room)
          return false
        },
      })

      await ctx.service.verifyRoomPresence()
      // 问的就是本机那间房（手机端列表查的是同一个房间号）
      expect(probes).toEqual([roomFor(DEVICE_KEY)])
      // 先把真相说出来 —— 旧实现这里是「等待手机连接…」这句假话
      expect(ctx.details[ctx.details.length - 1]).toBe('信令连接已断开')
      expect(ctx.service.getStatus()).toBe('error')

      await flush(LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(2)
      expect(ctx.service.getStatus()).toBe('waiting')
    },
    20_000,
  )

  it('问不到结论（`null` / 请求抛错）→ 不动作：不能凭一次没答上来就拆链路', async () => {
    const unknown = setup({ probeRoom: async () => null })
    await unknown.service.verifyRoomPresence()
    expect(unknown.service.getStatus()).toBe('waiting')

    const failing = setup({
      probeRoom: async () => {
        throw new Error('network down')
      },
    })
    await failing.service.verifyRoomPresence()
    expect(failing.service.getStatus()).toBe('waiting')

    await flush(LINK_CLOSED_RECOVER_MS + 300)
    expect(unknown.links).toHaveLength(1)
    expect(failing.links).toHaveLength(1)
  })

  it(
    '有手机正连着（已授权）→ 自检不动那条链路；它下线之后的下一次自检才补上',
    async () => {
      const ctx = setup({ probeRoom: async () => false })
      const granted: HelloResult = await hello(ctx.mobile(), ctx.service.pairingPayload().ticket)
      expect(ctx.service.getStatus()).toBe('connected')

      // 一条正在用的链路不能因为一次自检就被拆掉
      await ctx.service.verifyRoomPresence()
      expect(ctx.service.getStatus()).toBe('connected')
      expect(ctx.links).toHaveLength(1)

      // 手机走了 → 下一次自检才动手
      ctx.host().stall()
      expect(ctx.service.getStatus()).toBe('waiting')
      await ctx.service.verifyRoomPresence()
      expect(ctx.details[ctx.details.length - 1]).toBe('信令连接已断开')

      await flush(LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(2)
      // 票据不变（重开不是「停用重开」，屏上那张码照旧可用，grant 也认）
      expect(granted.grant?.token).toBeTruthy()
    },
    20_000,
  )

  it(
    '拒绝结论生效期间，房间自检仍然重开（屏上那张码还在等别的手机来扫）',
    async () => {
      const ctx = setup({ probeRoom: async () => false })
      // 拿一张没人发过的票握手 → 电脑端拒签（状态进 `rejected`，并踢掉这条链路）
      await expect(hello(ctx.mobile(), 'pr-unknown-ticket')).rejects.toMatchObject({ code: 'E_DENIED' })
      expect(ctx.service.getStatus()).toBe('rejected')
      await flush(REJECT_KICK_DELAY_MS + 400) // 等踢链跑完（此时是第 2 条链路）
      expect(ctx.links).toHaveLength(2)

      await ctx.service.verifyRoomPresence()
      // 结论不抢屏（胶囊里留着更重要的「已拒绝接入」），但链路照样重开
      expect(ctx.service.getStatus()).toBe('rejected')
      await flush(LINK_CLOSED_RECOVER_MS + 300)
      expect(ctx.links).toHaveLength(3)
      expect(ctx.service.getStatus()).toBe('rejected')
    },
    20_000,
  )

  it('已停用 / 还没建链路 → 一次都不问（不打扰服务端）', async () => {
    let calls = 0
    const ctx = setup({
      probeRoom: async () => {
        calls += 1
        return false
      },
    })
    ctx.service.disable()

    await ctx.service.verifyRoomPresence()
    expect(calls).toBe(0)
    await flush(LINK_CLOSED_RECOVER_MS + 300)
    expect(ctx.links).toHaveLength(1)
    expect(ctx.service.getStatus()).toBe('disabled')
  })
})
