/**
 * 「握手截止」兜底（P1）—— 链路已 open 却迟迟不握手 → 到期踢链。
 *
 * 为什么需要：授权只发生在 `host.hello` 里，而链路可以在「同一次会话里」被对端透明重建
 * （手机端只看到 `connecting → open`，不会重跑连接流程、也就不会重发 hello）。此时电脑端会
 * 永远停在「正在验证接入的设备」。本兜底给它一个尽头。
 *
 * 两个用例分别钉：
 *  1. 开了链路却不说话 → 到期踢掉并原地重开（回到 `waiting`）；
 *  2. **一旦收到 hello 请求就不再踢** —— 首次配对的确认弹窗可能让人等几十秒，不能被误伤。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Endpoint, MemoryTransport, createCaller, createMemoryPair, type HostApi } from 'virlen-remote'
import {
  HANDSHAKE_DEADLINE_MS,
  PhoneControlService,
  type PhoneControlOptions,
  type PhoneControlStatus,
} from '@/bridge'

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

afterEach(() => {
  vi.useRealTimers()
})

describe('握手截止 —— open 之后迟迟不握手就踢链', () => {
  it('链路 open 后没收到 hello → 到期踢链并回到 waiting', async () => {
    vi.useFakeTimers()
    const created: MemoryTransport[] = []
    const statuses: PhoneControlStatus[] = []
    const service = makeService({
      createTransport: () => {
        const t = new MemoryTransport()
        created.push(t)
        return t
      },
      onStatusChange: (s) => statuses.push(s),
    })
    service.enable()
    expect(created).toHaveLength(1)

    created[0].open() // 链路通了，但没人握手
    expect(service.getStatus()).toBe('verifying')
    expect(statuses).toContain('verifying')

    await vi.advanceTimersByTimeAsync(HANDSHAKE_DEADLINE_MS)

    // 到期 → 旧链路被踢、原地重开一条新的
    expect(created).toHaveLength(2)
    expect(created[0].state).toBe('closed')
    expect(service.getStatus()).toBe('waiting')

    service.disable()
  })

  it('收到 hello 请求就不再踢（首次配对确认弹窗等几十秒也安全）', async () => {
    vi.useFakeTimers()
    // 手动配对两端：host 侧初始 connecting，enable 后再 open —— 才能触发「open → 起计时」
    const hostT = new MemoryTransport()
    const mobileT = new MemoryTransport()
    hostT.peer = mobileT
    mobileT.peer = hostT

    let factoryCalls = 0
    const service = makeService({
      createTransport: () => {
        factoryCalls += 1
        return hostT
      },
      // 永不 resolve：模拟「确认弹窗一直挂着」——hello 处理函数卡在这里
      confirmPair: () => new Promise<boolean>(() => {}),
    })
    service.enable()

    const mobileEp = new Endpoint({ transport: mobileT, defaultTimeoutMs: 2000 })
    const caller = createCaller<HostApi>(mobileEp)
    hostT.open()
    mobileT.open()
    expect(service.getStatus()).toBe('verifying')

    // 票据路径 → 触发 confirmPair（挂起）；但 hello 请求已到达 → 取消截止
    void caller
      .call('host.hello', {
        protocolVersion: 1,
        client: { platform: 'test', appVersion: '0' },
        capabilities: [],
        token: service.pairingPayload().ticket,
        mobileKey: MOBILE_KEY,
        mobileName: '测试手机',
      })
      .catch(() => {})

    // 让请求送达，再推进远超截止的时间
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(HANDSHAKE_DEADLINE_MS * 3)

    // 确认弹窗挂着也不算「不握手」→ 不重开链路
    expect(factoryCalls).toBe(1)

    service.disable()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
})
