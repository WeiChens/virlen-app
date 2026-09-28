/**
 * 电脑端发出 `host.event.connection.changed`（协议表里那个「从未发过」的事件）。
 *
 * 为什么值得单测：这个事件是手机**拿电脑视角交叉校验**本端判定的唯一来源。它此前只在桌面设置页
 * 消费（`onLinkKindChange`），协议表有、但电脑端从不发。这里钉住三件事：
 *  1. 通讯类型**确定**（`direct` / `relay`）时，事件真的推到了手机；
 *  2. 拿不到结论（`unknown`）时**不发** —— 宁可没有，也不发一个猜测；
 *  3. 未完成 `hello` 的链路**发不出去**（`requireAuthorization` 出站闸门），但本地回调照常。
 *
 * 真实 WebRTC 跑不进 CI，所以这里用**假 PC**（只实现 `getStats()`）驱动真实的 `LinkKindWatcher`，
 * 从而把 watcher → `onLinkKind` → `emit` 这条**真实胶水**走通，而不是只测某个纯函数。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  createCaller,
  createMemoryPair,
  createSubscriber,
  type HostApi,
  type HostEvents,
  type StatsProvider,
  type StatsReportLike,
} from 'virlen-remote'
import { PhoneControlService, type LinkKindWatcher, type PhoneControlOptions } from '@/bridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等条件成立（内存传输的事件投递是异步的）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

const DEVICE_KEY = 'dk-0123456789abcdef'
const MOBILE_KEY = 'mk-fedcba9876543210'

/** 可切换的假 PC：`set()` 之后 `getStats()` 返回新的那份 stats。 */
function fakePc(localType: string, remoteType: string): { pc: StatsProvider; set(l: string, r: string): void } {
  let local = localType
  let remote = remoteType
  const report = (): StatsReportLike => {
    const entries = [
      { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP1' },
      {
        id: 'CP1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'L-1',
        remoteCandidateId: 'R-1',
      },
      { id: 'L-1', type: 'local-candidate', candidateType: local },
      { id: 'R-1', type: 'remote-candidate', candidateType: remote },
    ]
    return {
      forEach(cb: (entry: unknown) => void) {
        for (const e of entries) cb(e)
      },
    }
  }
  return {
    pc: { getStats: async () => report() },
    set(l, r) {
      local = l
      remote = r
    },
  }
}

/** 取服务的巡检器（私有字段）。用例驱动它即可覆盖真实的 watcher → emit 胶水。 */
function watcherOf(service: PhoneControlService): LinkKindWatcher {
  return (service as unknown as { kindWatch: LinkKindWatcher }).kindWatch
}

function setup(overrides: Partial<PhoneControlOptions> = {}) {
  const [hostT, mobileT] = createMemoryPair()
  const service = new PhoneControlService({
    signalUrl: 'https://virlen.cn/api/rtc',
    deviceName: '我的电脑',
    deviceKey: DEVICE_KEY,
    createTransport: () => hostT,
    ...overrides,
  })
  const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
  const sub = createSubscriber<HostEvents>(mobileEp)
  const caller = createCaller<HostApi>(mobileEp)
  cleanups.push(() => {
    service.disable()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
  service.enable()
  return { service, caller, sub }
}

/** 走一次 `host.hello`（票据路径）—— 事件**必须授权后**才发得出去。 */
function connect(service: PhoneControlService, caller: ReturnType<typeof createCaller<HostApi>>) {
  return caller.call('host.hello', {
    protocolVersion: 1,
    client: { platform: 'test', appVersion: '0' },
    capabilities: [],
    token: service.pairingPayload().ticket,
    mobileKey: MOBILE_KEY,
    mobileName: '测试手机',
  })
}

function collect(sub: ReturnType<typeof createSubscriber<HostEvents>>) {
  const received: Array<HostEvents['host.event.connection.changed']> = []
  sub.subscribe('host.event.connection.changed', (p) => received.push(p))
  return received
}

describe('host.event.connection.changed —— 电脑端把链路类型发给手机', () => {
  it('类型确定时推送（relay → direct 跟着变）；unknown 不发', async () => {
    const kinds: string[] = []
    const { service, caller, sub } = setup({ onLinkKindChange: (k) => kinds.push(k) })
    const received = collect(sub)

    await connect(service, caller)

    const { pc, set } = fakePc('relay', 'host')
    watcherOf(service).watch(pc)
    await waitFor(() => received.length === 1)
    // 本地回调（桌面设置页）与协议事件（手机）同一个结论
    expect(received).toEqual([{ path: 'relay' }])
    expect(kinds).toEqual(['relay'])

    // 打洞完成 → 直连候选对胜出：事件要跟着变（否则手机会一直以为在走中继）
    set('srflx', 'srflx')
    await watcherOf(service).poll()
    await waitFor(() => received.length === 2)
    expect(received).toEqual([{ path: 'relay' }, { path: 'direct' }])

    // 停掉巡检 = 结论作废 → 只更新本地回调，**不发**（事件取值域只有 direct / relay）
    watcherOf(service).stop()
    await waitFor(() => kinds.includes('unknown'))
    expect(kinds).toEqual(['relay', 'direct', 'unknown'])
    expect(received).toEqual([{ path: 'relay' }, { path: 'direct' }])
  })

  it('未完成 hello 的链路发不出去（出站闸门）；本地回调照常', async () => {
    const kinds: string[] = []
    const { service, sub } = setup({ onLinkKindChange: (k) => kinds.push(k) })
    const received = collect(sub)

    // 还没 hello：链路「有人接入」但未授权 —— 事件应被 `requireAuthorization` 闸门拦下
    const { pc } = fakePc('relay', 'host')
    watcherOf(service).watch(pc)
    await waitFor(() => kinds.length >= 1)

    expect(kinds).toEqual(['relay'])
    // 给足投递时间；闸门拦住的那帧不该到手机
    await flush(30)
    expect(received).toEqual([])
  })
})
