/**
 * 已配对手机的**改名**（`PairingStore.rename`）。
 *
 * 需求原话是「给记录的手机添加改名功能，可以修改名称」。手机自己在 `host.hello` 里会报一个名字
 * （`mobileName`，多数是「Android」「iPhone」这类出厂名），两台一样的手机在列表里就分不清谁是谁。
 *
 * 这里钉住改名的**边界**，因为「改个名」听起来简单，真正会出事的是这四件：
 *  1. **只改名字**：`token` / 有效期 / `mobileKey` / `pairedAt` / 在线标记都不能动 —— 改名不是
 *     重新授权，不能让已连着的那台掉线、也不能把凭证换掉；
 *  2. **索引要跟着走**：三张索引表（token / deviceId / mobileKey）共用同一个对象引用，忘了重新
 *     登记就会出现「按凭证查得到，但名字还是旧的」这种鬼影；
 *  3. **空名要拒**（保持原名）：清成空串会让列表多一行无名记录，比拒绝更难解释；
 *  4. **改名要活过下一次连接**：`touch`（滑动续期）只回填 key，绝不能用手机报的名字把用户的
 *     命名盖回去 —— 否则每次重连名字都会「弹回」出厂商名。
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DEVICE_NAME, DEVICE_NAME_MAX, PairingStore, normalizeDeviceName } from '@/bridge'

const T0 = 1_700_000_000_000

describe('PairingStore —— 给手机改名', () => {
  it('改成功：名字落到列表与快照，并**通知一次**（界面据此刷新 + 落盘）', () => {
    const store = new PairingStore()
    const device = store.register('Android', { mobileKey: 'mk-1', now: T0 })
    const spy = vi.fn()
    store.onChange = spy

    const updated = store.rename(device.deviceId, '我的主力机')

    expect(updated?.name).toBe('我的主力机')
    expect(store.list()[0].name).toBe('我的主力机')
    expect(store.snapshot().devices[0].name).toBe('我的主力机')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('只动名字：凭证 / 有效期 / 手机 key / 配对时刻 / 在线标记一律不变', () => {
    const store = new PairingStore()
    const device = store.register('Android', { mobileKey: 'mk-1', now: T0 })
    // 让它「正连着」——改名不该把它踢下线
    store.touch(device.deviceId, { mobileKey: 'mk-1', now: T0 + 1000 })
    const before = store.list()[0]

    const updated = store.rename(device.deviceId, '书房那台')!

    expect(updated.token).toBe(before.token)
    expect(updated.expiresAt).toBe(before.expiresAt)
    expect(updated.issuedAt).toBe(before.issuedAt)
    expect(updated.mobileKey).toBe('mk-1')
    expect(updated.pairedAt).toBe(before.pairedAt)
    expect(updated.lastSeenAt).toBe(before.lastSeenAt)
    expect(store.activeDeviceId).toBe(device.deviceId)
  })

  it('三张索引表都指向改名后的记录（否则按凭证 / key 反查会拿到旧对象）', () => {
    const store = new PairingStore()
    const device = store.register('Android', { mobileKey: 'mk-1', now: T0 })

    store.rename(device.deviceId, '新名字')

    expect(store.lookup(device.token)?.name).toBe('新名字')
    expect(store.lookupByMobileKey('mk-1')?.name).toBe('新名字')
    // 同一台（不是复制了一份）
    expect(store.lookup(device.token)?.deviceId).toBe(device.deviceId)
    expect(store.size).toBe(1)
  })

  it('名字前后空白 / 内部换行都归一（名字会进列表、审计与埋点，不能带换行）', () => {
    const store = new PairingStore()
    const device = store.register('Android', { now: T0 })

    expect(store.rename(device.deviceId, '  客厅\n那台  ')?.name).toBe('客厅 那台')
  })

  it('超长名字截到 DEVICE_NAME_MAX', () => {
    const store = new PairingStore()
    const device = store.register('Android', { now: T0 })

    const updated = store.rename(device.deviceId, 'x'.repeat(DEVICE_NAME_MAX + 20))!

    expect(updated.name).toHaveLength(DEVICE_NAME_MAX)
    expect(updated.name).toBe('x'.repeat(DEVICE_NAME_MAX))
  })

  it('空名 / 纯空白 → 拒绝改名（保持原名），且不发通知', () => {
    const store = new PairingStore()
    const device = store.register('Android', { now: T0 })
    const spy = vi.fn()
    store.onChange = spy

    expect(store.rename(device.deviceId, '')).toBe(null)
    expect(store.rename(device.deviceId, '   \n ')).toBe(null)

    expect(store.list()[0].name).toBe('Android')
    // 没改成就别惊动落盘与重渲染
    expect(spy).not.toHaveBeenCalled()
  })

  it('名字没变 → 返回当前记录但**不发通知**（一次无意义落盘 + 全页重渲染不值得）', () => {
    const store = new PairingStore()
    const device = store.register('Android', { now: T0 })
    const spy = vi.fn()
    store.onChange = spy

    // 前后空白不同、归一后同名，也算「没变」
    expect(store.rename(device.deviceId, ' Android ')?.name).toBe('Android')
    expect(spy).not.toHaveBeenCalled()
  })

  it('设备不存在（多半是刚被移除）→ null，不抛错、不发通知', () => {
    const store = new PairingStore()
    const spy = vi.fn()
    store.onChange = spy

    expect(store.rename('dev-不存在', '随便')).toBe(null)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('改名要活过下一次连接 / 重启', () => {
  it('滑动续期（touch）不会用手机报的名字盖回用户起的名', () => {
    const store = new PairingStore()
    const device = store.register('Android', { mobileKey: 'mk-1', now: T0 })
    store.rename(device.deviceId, '我的主力机')

    // 手机重连：`authorize` 成功 → `touch`（续期 + 回填 key）
    const verdict = store.authorize({ token: device.token, mobileKey: 'mk-1', now: T0 + 1000 })
    expect(verdict.ok).toBe(true)

    expect(store.list()[0].name).toBe('我的主力机')
  })

  it('落盘 → 读回，名字还在（改名是真的持久化了）', () => {
    const store = new PairingStore()
    const device = store.register('Android', { mobileKey: 'mk-1', now: T0 })
    store.rename(device.deviceId, '办公室那台')

    const restored = new PairingStore()
    restored.restore(JSON.parse(JSON.stringify(store.snapshot())))

    expect(restored.list()[0].name).toBe('办公室那台')
  })
})

describe('默认名与归一（改名功能的两个底座）', () => {
  it('手机没报名字 → 用 DEFAULT_DEVICE_NAME（兑换票据 / 直接登记 / 迁移三处同一口径）', () => {
    const store = new PairingStore()
    expect(store.register('', { now: T0 }).name).toBe(DEFAULT_DEVICE_NAME)
    const ticket = store.issueTicket()
    expect(store.redeemTicket(ticket, { now: T0 }).name).toBe(DEFAULT_DEVICE_NAME)

    // 旧快照里名字被写坏（空白 / 不是字符串）也要能救回默认名，而不是留一行空白
    const restored = new PairingStore()
    restored.restore({
      devices: [
        { deviceId: 'dev-1', token: 'tk-1', name: '   ', pairedAt: T0, issuedAt: T0, expiresAt: T0 + 1 },
        { deviceId: 'dev-2', token: 'tk-2', name: 42, pairedAt: T0, issuedAt: T0, expiresAt: T0 + 1 },
      ],
      tickets: [],
    } as never)
    expect(restored.list().map((d) => d.name)).toEqual([DEFAULT_DEVICE_NAME, DEFAULT_DEVICE_NAME])
  })

  it('normalizeDeviceName：非字符串 / 全空白给 null，其余折叠空白并截断', () => {
    expect(normalizeDeviceName(undefined)).toBe(null)
    expect(normalizeDeviceName(42)).toBe(null)
    expect(normalizeDeviceName('  \t ')).toBe(null)
    expect(normalizeDeviceName(' a \n b ')).toBe('a b')
    expect(normalizeDeviceName('y'.repeat(DEVICE_NAME_MAX + 1))).toHaveLength(DEVICE_NAME_MAX)
  })
})
