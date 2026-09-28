/**
 * `phoneControlStore` 的设备列表 / 在线标记（M8 真机缺陷回归）。
 *
 * 缺陷现场：扫码授权绑定通过后，「已绑定的手机」不新增。
 *
 * 这里只钉**设置页 store 这一侧**的接线（配对表 → 可观察字段），因为缺陷就在这条线上：
 *  store 原先只在 enable / 点「允许」的瞬间拉一次 `pairing.list()`，而那一刻手机还没兑换票据
 *（`host.hello` 是异步的）→ 列表永远停在旧值。现在靠 `pairing.onChange → syncDevices()` 冒泡。
 *
 * 浏览器 harness（非 Tauri）下 `buildPersistence()` 返回 `undefined`，配对表纯内存 ——
 * 与真机上「落盘的那一份」是同一套接线，故这里测得到。
 */
import { describe, expect, it } from 'vitest'
import { phoneControlStore } from '@/ui/store/phoneControlStore'

describe('phoneControlStore —— 配对表一变，列表立刻跟着变', () => {
  it('新配对一台手机 → devices 立刻新增（不需要重新 enable / 重新进页面）', () => {
    const before = phoneControlStore.devices.length
    const device = phoneControlStore.pairing.register('测试手机', { mobileKey: 'mk-test-1' })

    // 关键：没有任何「手动刷新」动作，列表就得是新的
    expect(phoneControlStore.devices.length).toBe(before + 1)
    expect(phoneControlStore.devices.map((d) => d.deviceId)).toContain(device.deviceId)
  })

  it('手机握手成功 → activeDeviceId 指向它；断开 → 归零（设备仍在列表里）', () => {
    const device = phoneControlStore.pairing.register('测试手机 2', { mobileKey: 'mk-test-2' })
    // 「登记」不是「连接」：注册后不该有在线的
    expect(phoneControlStore.activeDeviceId).toBe(null)

    phoneControlStore.pairing.touch(device.deviceId, { mobileKey: 'mk-test-2' })
    expect(phoneControlStore.activeDeviceId).toBe(device.deviceId)
    expect(phoneControlStore.devices.map((d) => d.deviceId)).toContain(device.deviceId)

    // 断链（服务侧会调 setActive(null)）
    phoneControlStore.pairing.setActive(null)
    expect(phoneControlStore.activeDeviceId).toBe(null)
    expect(phoneControlStore.devices.map((d) => d.deviceId)).toContain(device.deviceId)
  })

  it('移除设备 → 列表与在线标记一起清掉，且**不依赖服务是否已启用**', () => {
    const device = phoneControlStore.pairing.register('测试手机 3', { mobileKey: 'mk-test-3' })
    phoneControlStore.pairing.touch(device.deviceId)
    expect(phoneControlStore.activeDeviceId).toBe(device.deviceId)

    phoneControlStore.revokeDevice(device.deviceId)

    expect(phoneControlStore.devices.map((d) => d.deviceId)).not.toContain(device.deviceId)
    expect(phoneControlStore.activeDeviceId).toBe(null)
  })
})

/**
 * 改名（设置页行内编辑的 store 侧）。
 *
 * 与「移除」同一口径：**不依赖服务是否启用** —— 配对表归本 store 持有，未启用时也改得了名；
 * 与「移除」不同的是，改名**不碰链路**（名字不进授权判定，正连着的那台不掉线）。
 */
describe('phoneControlStore —— 给已绑定的手机改名', () => {
  it('改名 → devices 镜像立刻跟着变（没有「手动刷新」，也不需要重新 enable）', () => {
    const device = phoneControlStore.pairing.register('Android', { mobileKey: 'mk-rename-1' })

    expect(phoneControlStore.renameDevice(device.deviceId, '我的主力机')).toBe(true)

    const row = phoneControlStore.devices.find((d) => d.deviceId === device.deviceId)
    expect(row?.name).toBe('我的主力机')
  })

  it('在连着的那台也能改名，且在线标记不受影响', () => {
    const device = phoneControlStore.pairing.register('Android', { mobileKey: 'mk-rename-2' })
    phoneControlStore.pairing.touch(device.deviceId)

    phoneControlStore.renameDevice(device.deviceId, '书房那台')

    expect(phoneControlStore.activeDeviceId).toBe(device.deviceId)
    expect(phoneControlStore.devices.find((d) => d.deviceId === device.deviceId)?.name).toBe(
      '书房那台',
    )
  })

  it('设备不在列表里（比如刚在别处被移除）→ false（设置页据此提示，而不是静默不动）', () => {
    const device = phoneControlStore.pairing.register('Android', { mobileKey: 'mk-rename-3' })
    phoneControlStore.revokeDevice(device.deviceId)

    expect(phoneControlStore.renameDevice(device.deviceId, '早就没了')).toBe(false)
  })
})
