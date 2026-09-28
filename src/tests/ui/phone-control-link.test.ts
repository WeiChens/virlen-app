/**
 * 设置页 store ↔ 服务 的新接线（M9）。
 *
 * 这两条线是这次真机需求的落点，且都在「服务 ↔ store」之间 —— 它们在浏览器 harness 里跑不了真服务
 *（要真 WebRTC + 信令服务器），于是把 `PhoneControlService` 换成假实现，只钉**接线**：
 *  1. 服务上报的通讯类型要落到 `store.linkKind`（设置页据此显示 `P2P 直连 / TURN 中继`）；
 *  2. 移除**正在连接**的那台手机时，store 必须叫服务断链 —— 缺了这条就是
 *     「点了移除，那台手机还在操作本机」。
 *
 * 服务自身的断链行为（旧链路真的关了、还能接下一台、二维码不变）在
 * `src/tests/bridge/phone-link-drop.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const created: Array<Record<string, any>> = []
  class FakeService {
    enabled = false
    drops = 0
    refreshes = 0
    constructor(readonly options: Record<string, any>) {
      created.push(this as unknown as Record<string, any>)
    }
    enable() {
      this.enabled = true
    }
    disable() {
      this.enabled = false
    }
    /** 只数被叫了几次；真的断链行为由 bridge 用例负责。 */
    dropLink() {
      this.drops += 1
    }
    pairingPayload() {
      return { host: 'dk-fake', name: '假电脑', ticket: 'pr-fake', signal: 'https://fake/' }
    }
    get ticketDeadline() {
      return Date.now() + 60_000
    }
    rotateTicketIfExpired() {
      return false
    }
    /** 每次刷新返回一张**不同**的票，好让用例能断言「屏上的码确实换了」。 */
    refreshTicket() {
      this.refreshes += 1
      return { ...this.pairingPayload(), ticket: `pr-fake-${this.refreshes}` }
    }
  }
  return { created, FakeService }
})

vi.mock('@/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/bridge')>()
  return { ...actual, PhoneControlService: h.FakeService }
})

import { phoneControlStore } from '@/ui/store/phoneControlStore'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 启用 store 并等它把服务建出来（`enableAsync` 是异步的：要等设备身份 + ICE 解析）。
 *
 * ⚠️ 服务实例是**跨用例复用**的（store 只在首次启用时新建），所以这里等的是 `enabled`，
 * 不是「新建了一个服务」—— 否则第二个用例会一直等到超时。
 */
async function enableStore() {
  phoneControlStore.setEnabled(true)
  for (let i = 0; i < 200 && !phoneControlStore.enabled; i += 1) await sleep(5)
  expect(phoneControlStore.enabled).toBe(true)

  const service = h.created[h.created.length - 1]
  expect(service).toBeTruthy()
  service.drops = 0
  service.refreshes = 0
  return service
}

beforeEach(() => {
  // 配对表是模块级单例：清干净，免得上一个用例的手机影响列表断言
  phoneControlStore.pairing.restore({ devices: [], tickets: [] })
})

afterEach(() => {
  phoneControlStore.setEnabled(false)
})

describe('通讯类型（P2P 直连 / TURN 中继）', () => {
  it('服务上报什么，store.linkKind 就是什么；停用后回到 unknown', async () => {
    const service = await enableStore()

    service.options.onStatusChange('connected')
    service.options.onLinkKindChange('relay')

    expect(phoneControlStore.status).toBe('connected')
    expect(phoneControlStore.linkKind).toBe('relay')

    // 停用 = 没有链路了，结论必须作废（否则下次连别的网络时会显示上一次的结论）
    phoneControlStore.setEnabled(false)
    expect(phoneControlStore.linkKind).toBe('unknown')
  })
})

describe('状态上报（设置页那颗胶囊读的就是这两个字段）', () => {
  /**
   * 拒绝是一个**否定结论**，不是「还在等」—— 胶囊文案由 `status` + `error` 拼成：
   * `STATUS_TEXT[status]` + `（error）`，即「已拒绝接入（该手机已被移除）」。
   * 这里钉的是这条接线（服务 → store），而不是那句话本身。
   */
  it('rejected + 原因原样落到 status / error（不被后续链路事件盖掉）', async () => {
    const service = await enableStore()

    service.options.onStatusChange('verifying')
    expect(phoneControlStore.status).toBe('verifying')

    service.options.onStatusChange('rejected', '该手机已被移除')
    expect(phoneControlStore.status).toBe('rejected')
    expect(phoneControlStore.error).toBe('该手机已被移除')
  })

  it('换成「已连接」时原因要清掉（否则胶囊里会赖着上一句拒绝理由）', async () => {
    const service = await enableStore()
    service.options.onStatusChange('rejected', '该手机已被移除')

    service.options.onStatusChange('connected')

    expect(phoneControlStore.status).toBe('connected')
    expect(phoneControlStore.error).toBe(null)
  })
})

describe('移除设备时的断链', () => {
  it('移除**正在连接**的那台 → 立刻叫服务断掉当前链路', async () => {
    const service = await enableStore()
    const device = phoneControlStore.pairing.register('在线手机', { mobileKey: 'mk-live' })
    phoneControlStore.pairing.touch(device.deviceId)
    expect(phoneControlStore.activeDeviceId).toBe(device.deviceId)

    phoneControlStore.revokeDevice(device.deviceId)

    expect(service.drops).toBe(1)
    expect(phoneControlStore.devices).toEqual([])
    expect(phoneControlStore.activeDeviceId).toBe(null)
  })

  it('移除**没连着**的那台 → 不动链路（它本来就没有链路）', async () => {
    const service = await enableStore()
    const device = phoneControlStore.pairing.register('离线手机', { mobileKey: 'mk-idle' })
    expect(phoneControlStore.activeDeviceId).toBe(null)

    phoneControlStore.revokeDevice(device.deviceId)

    expect(service.drops).toBe(0)
    expect(phoneControlStore.devices).toEqual([])
  })

  it('移除后屏幕上那张码**立刻换新**（旧票已随移除作废，屏上不能留一张扫不动的码）', async () => {
    const service = await enableStore()
    const before = phoneControlStore.payload?.ticket
    const device = phoneControlStore.pairing.register('手机', { mobileKey: 'mk-refresh' })

    phoneControlStore.revokeDevice(device.deviceId)

    expect(service.refreshes).toBe(1)
    expect(phoneControlStore.payload?.ticket).not.toBe(before)
  })

  it('多台手机时只断被移除的那条：移除离线的那台不影响在线连接', async () => {
    const service = await enableStore()
    const online = phoneControlStore.pairing.register('在线手机', { mobileKey: 'mk-on' })
    const idle = phoneControlStore.pairing.register('离线手机', { mobileKey: 'mk-off' })
    phoneControlStore.pairing.touch(online.deviceId)

    phoneControlStore.revokeDevice(idle.deviceId)

    expect(service.drops).toBe(0)
    expect(phoneControlStore.activeDeviceId).toBe(online.deviceId)

    phoneControlStore.revokeDevice(online.deviceId)
    expect(service.drops).toBe(1)
    expect(phoneControlStore.activeDeviceId).toBe(null)
  })
})
