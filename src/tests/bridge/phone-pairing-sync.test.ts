/**
 * 配对表 → UI 的同步（M8 真机缺陷回归）。
 *
 * **缺陷**：扫码授权绑定通过连接后，设置页「已绑定的手机」没有数据新增。
 *
 * 根因不在配对逻辑，而在**没有信号**：`PairingStore` 的变更原本只被用于落盘，
 * 服务、store 都不监听 → 设置页只在 enable / 点「允许」那一瞬间拉一次列表，
 * 而那一刻手机还**没**兑换票据（`host.hello` 是异步的），于是列表永远停在旧值。
 *
 * 本文件钉住四件事（都是缺陷现场）：
 *  1. 配对表变更（兑换票据 / 滑动续期 / 撤销）一定**对外发通知**，且通知里的快照已含新设备；
 *  2. 从磁盘恢复后**补发**一次通知（否则「磁盘里有 3 台、界面 0 台」会一直持续到下次变更）；
 *  3. 「哪台手机现在连着」有明确来源（`activeDeviceId`），且**不随快照落盘**；
 *  4. 注入配对表时服务不碰落盘与通知（所有权归调用方，防两个所有者互相覆盖）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Endpoint, createCaller, createMemoryPair, MemoryTransport, type HelloResult, type HostApi, type TransportState } from 'virlen-remote'
import { PairingStore, PhoneControlService, type PairingSnapshot, type PhoneControlOptions } from '@/bridge'

const cleanups: Array<() => void> = []

/**
 * 能模拟「链路回到 `connecting`」的 memory transport。
 *
 * 真实 RTC 链路里 `disconnected` / `dc.onclose` 都映射到 `connecting`（不是 `closed`），而
 * `MemoryTransport` 的公开辅助只有 `open` / `disconnect`(→closed) / `reconnect` ——
 * 少了这一档，真机上最容易出的那类「手机主动断开」就测不到。`setState` 是私有的，
 * 这里仅测试内通过 cast 触达（运行时就是一次普通的状态广播）。
 */
class StallingTransport extends MemoryTransport {
  stall(): void {
    ;(this as unknown as { setState(state: TransportState): void }).setState('connecting')
  }
}

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
 * 建一对 memory 链路并接到服务上，**按设置页 store 的用法注入配对表**
 *（订阅归调用方，服务不碰 `onChange`）。
 */
function setup(overrides: Partial<PhoneControlOptions> = {}) {
  const [hostT, mobileT] = createMemoryPair()
  const pairing = new PairingStore()
  const changes: PairingSnapshot[] = []
  // 与 `phoneControlStore.restorePairing()` 同一件事：变更 → 刷新界面
  pairing.onChange = (snap) => changes.push(snap)
  const service = new PhoneControlService(
    baseOptions({ createTransport: () => hostT, pairing, ...overrides }),
  )
  const mobileEp = new Endpoint({ transport: mobileT })
  const caller = createCaller<HostApi>(mobileEp)
  cleanups.push(() => {
    service.disable()
    mobileEp.dispose()
    hostT.close()
    mobileT.close()
  })
  service.enable()
  return { service, pairing, caller, changes, hostT }
}

describe('配对表变更 —— 必须冒泡到界面', () => {
  it('首次扫码配对：兑换票据后发通知，且通知里的快照已经包含这台手机', async () => {
    const { service, pairing, caller, changes } = setup({ confirmPair: async () => true })

    const ticket = service.pairingPayload().ticket
    // `pairingPayload()` 自己会签发票据并通知一次，故以「配对前的次数」为基准
    const before = changes.length

    await hello(caller, ticket)

    expect(pairing.list()).toHaveLength(1)
    // ① 配对完成后确实对外发了通知（缺失这一条 = 界面永远不新增）
    expect(changes.length).toBeGreaterThan(before)
    // ② 通知里带的就是新设备（界面据此新增一行，不需要自己再拉一次）
    const last = changes[changes.length - 1]
    expect(last.devices).toHaveLength(1)
    expect(last.devices[0].deviceId).toBe(pairing.list()[0].deviceId)
  })

  it('老设备凭凭证直连（滑动续期）也会发通知 —— 「上次连接」/ 有效期跟着刷新', async () => {
    const { service, pairing, caller, changes } = setup({ confirmPair: async () => true })

    const first: HelloResult = await hello(caller, service.pairingPayload().ticket)
    const before = changes.length
    const again: HelloResult = await hello(caller, first.grant!.token)

    expect(pairing.list()).toHaveLength(1)
    expect(changes.length).toBeGreaterThan(before)
    expect(again.grant!.token).toBe(first.grant!.token)
  })

  it('撤销：列表变空也发通知（否则界面会留着一个已经移除的手机）', async () => {
    const { service, pairing, caller, changes } = setup({ confirmPair: async () => true })

    await hello(caller, service.pairingPayload().ticket)
    const before = changes.length
    expect(pairing.revoke(pairing.list()[0].deviceId)).toBe(true)

    expect(changes.length).toBeGreaterThan(before)
    expect(changes[changes.length - 1].devices).toEqual([])
  })
})

describe('哪台手机现在连着（activeDeviceId）', () => {
  it('配对成功 → 指向它；断链 → 归零，但设备仍在列表里', async () => {
    const { service, pairing, caller, hostT } = setup({ confirmPair: async () => true })

    await hello(caller, service.pairingPayload().ticket)
    const device = pairing.list()[0]
    expect(pairing.activeDeviceId).toBe(device.deviceId)

    hostT.disconnect()
    // 断开的是「连接」而不是「绑定」：列表还在，只是不再标「已连接」
    expect(pairing.activeDeviceId).toBe(null)
    expect(pairing.list()).toHaveLength(1)
  })

  /**
   * 真机缺陷回归：手机**主动断开**时，RTC 链路回到的是 `connecting`（`rtc.ts`：`disconnected` /
   * `dc.onclose` 都映射到它），**不是** `closed`。旧实现只在 `closed` 清在线标记 →
   * 「状态已『等待手机连接…』、列表那一行却还高亮着已连接」。
   */
  it('链路回到 connecting（抖动 / 手机主动断开）→ 在线标记也要清掉', async () => {
    const hostT = new StallingTransport()
    const mobileT = new MemoryTransport()
    hostT.peer = mobileT
    mobileT.peer = hostT
    hostT.open()
    mobileT.open()

    const pairing = new PairingStore()
    const service = new PhoneControlService(
      baseOptions({ createTransport: () => hostT, pairing, confirmPair: async () => true }),
    )
    const mobileEp = new Endpoint({ transport: mobileT })
    const caller = createCaller<HostApi>(mobileEp)
    cleanups.push(() => {
      service.disable()
      mobileEp.dispose()
      hostT.close()
      mobileT.close()
    })
    service.enable()

    await hello(caller, service.pairingPayload().ticket)
    expect(pairing.activeDeviceId).toBe(pairing.list()[0].deviceId)

    hostT.stall()
    expect(pairing.activeDeviceId).toBe(null)
    // 断开的是「连接」而不是「绑定」：设备仍在列表里
    expect(pairing.list()).toHaveLength(1)
  })

  it('停用服务 → 在线标记归零', async () => {
    const { service, pairing, caller } = setup({ confirmPair: async () => true })

    await hello(caller, service.pairingPayload().ticket)
    expect(pairing.activeDeviceId).not.toBe(null)

    service.disable()
    expect(pairing.activeDeviceId).toBe(null)
    expect(pairing.list()).toHaveLength(1)
  })

  it('移除当前在线的手机 → 列表与在线标记一起清干净', async () => {
    const { service, pairing, caller } = setup({ confirmPair: async () => true })

    await hello(caller, service.pairingPayload().ticket)
    pairing.revoke(pairing.list()[0].deviceId)
    expect(pairing.list()).toEqual([])
    expect(pairing.activeDeviceId).toBe(null)
  })

  it('在线标记**不进快照**（重启后「谁连着」必须从零开始）', async () => {
    const { service, pairing, caller } = setup({ confirmPair: async () => true })

    await hello(caller, service.pairingPayload().ticket)
    const snapshot = pairing.snapshot()
    // 注意：设备记录本身有 `deviceId`，所以只能断言「快照里没有这个字段」，不能断言不含它的值
    expect(Object.keys(snapshot)).not.toContain('activeDeviceId')
    // 读回快照的新实例也不会带着在线标记
    const restored = new PairingStore()
    restored.restore(snapshot)
    expect(restored.activeDeviceId).toBe(null)
  })

  it('setActive 只认列表里真实存在的设备（不认识的 id 归一成 null）', () => {
    const store = new PairingStore()
    store.setActive('dev-不存在')
    expect(store.activeDeviceId).toBe(null)
  })
})

describe('配对表的所有权（注入 vs 自持）', () => {
  it('注入配对表时：服务不顶掉 onChange，也不落盘（落盘归调用方）', async () => {
    const pairing = new PairingStore()
    const external = vi.fn()
    const save = vi.fn()
    pairing.onChange = external

    const service = new PhoneControlService(
      baseOptions({
        pairing,
        persistence: { load: async () => null, save },
        onPairingChange: vi.fn(),
      }),
    )
    cleanups.push(() => service.disable())

    const device = pairing.register('手机', { mobileKey: MOBILE_KEY })
    expect(pairing.onChange).toBe(external)
    expect(external).toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    // 「登记」不等于「连接」：只有握手成功（redeem / touch）才算在线
    expect(pairing.activeDeviceId).toBe(null)
    expect(device.deviceId).toMatch(/^dev-/)
  })

  it('服务自持配对表：从磁盘恢复后**补发**一次通知（否则磁盘有、界面没有）', async () => {
    const template = new PairingStore()
    template.register('旧手机', { mobileKey: MOBILE_KEY })
    const raw = JSON.stringify(template.snapshot())

    const changes: PairingSnapshot[] = []
    const save = vi.fn()
    const service = new PhoneControlService(
      baseOptions({
        persistence: { load: async () => raw, save },
        onPairingChange: (snap) => changes.push(snap),
      }),
    )
    cleanups.push(() => service.disable())

    // 等 `persistence.load()` 的 then 跑完
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(service.pairing.list()).toHaveLength(1)
    // 恢复**不**是变更（`restore` 自己不发通知），所以这一条是「补发」的
    expect(changes).toHaveLength(1)
    expect(changes[0].devices).toHaveLength(1)

    // 之后的变更照常双重上报：落盘 + 通知
    service.pairing.register('新手机')
    expect(save).toHaveBeenCalled()
    expect(changes).toHaveLength(2)
  })

  it('坏数据读回不抛错（保持空配对表，功能不受影响）', async () => {
    const changes: PairingSnapshot[] = []
    const service = new PhoneControlService(
      baseOptions({
        persistence: { load: async () => '{ 坏 JSON', save: vi.fn() },
        onPairingChange: (snap) => changes.push(snap),
      }),
    )
    cleanups.push(() => service.disable())

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.pairing.list()).toEqual([])
  })
})
