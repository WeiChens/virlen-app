/**
 * 配对表 / 授权凭证（M6，§30.4）—— 纯逻辑用例。
 *
 * 与 `phone-control.test.ts` 的分工：那边走**完整 RPC 链路**（memory transport + hello），
 * 这边直接打 `PairingStore`，把「时间」注入进去 —— 90 天硬上限、旧快照迁移这类边界
 * 用真实时钟根本测不了（要么等 90 天，要么就只能不测）。
 */
import { describe, expect, it, vi } from 'vitest'
import { GRANT_MAX_LIFETIME_MS, GRANT_TTL_MS, PAIRING_TICKET_TTL_MS } from 'virlen-remote'
import { PairingStore, type PairingSnapshot } from '@/bridge'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

describe('PairingStore —— 旧快照迁移', () => {
  it('M6 之前的记录（无 key / 无有效期）→ 按 pairedAt 补 30 天，手机不失联', () => {
    const store = new PairingStore()
    const legacy = {
      devices: [{ deviceId: 'dev-1', name: '旧手机', token: 'tk-old', pairedAt: T0 }],
      tickets: [],
    } as unknown as PairingSnapshot
    store.restore(legacy)
    const [device] = store.list()
    expect(device.deviceId).toBe('dev-1')
    expect(device.token).toBe('tk-old')
    expect(device.mobileKey).toBe(null)
    expect(device.issuedAt).toBe(T0)
    expect(device.expiresAt).toBe(T0 + GRANT_TTL_MS)
  })

  it('坏记录（缺 token）被丢掉，不影响其它记录加载', () => {
    const store = new PairingStore()
    store.restore({
      devices: [
        { deviceId: 'ok', name: '好记录', token: 'tk-1', pairedAt: T0, issuedAt: T0, expiresAt: T0 + DAY } as never,
        { deviceId: 'bad', name: '坏记录', pairedAt: T0 } as never,
        null as never,
      ],
      tickets: [],
    })
    expect(store.list().map((d) => d.deviceId)).toEqual(['ok'])
  })

  it('往返快照一致（落盘 → 读回）', () => {
    const store = new PairingStore()
    const device = store.register('手机', { mobileKey: 'mk-1', now: T0 })
    const snapshot = JSON.parse(JSON.stringify(store.snapshot())) as PairingSnapshot
    const restored = new PairingStore()
    restored.restore(snapshot)
    expect(restored.list()[0]).toEqual(device)
    expect(restored.lookup(device.token)?.deviceId).toBe(device.deviceId)
    expect(restored.lookupByMobileKey('mk-1')?.deviceId).toBe(device.deviceId)
  })
})

describe('PairingStore —— 滑动续期与 90 天硬上限', () => {
  it('每次连接 +30 天，但**永不超过** issuedAt + 90 天', () => {
    const store = new PairingStore()
    const device = store.register('手机', { mobileKey: 'mk-1', now: T0 })

    // 第 10 天连一次 → 到期 = 第 40 天
    const a = store.touch(device.deviceId, { now: T0 + 10 * DAY })!
    expect(a.expiresAt).toBe(T0 + 10 * DAY + GRANT_TTL_MS)

    // 第 70 天连一次 → 本想到第 100 天，被硬上限截在 90 天
    const b = store.touch(device.deviceId, { now: T0 + 70 * DAY })!
    expect(b.expiresAt).toBe(T0 + GRANT_MAX_LIFETIME_MS)

    // 第 85 天连一次 → 仍是 90 天（不再延长）
    const c = store.touch(device.deviceId, { now: T0 + 85 * DAY })!
    expect(c.expiresAt).toBe(T0 + GRANT_MAX_LIFETIME_MS)

    // 第 91 天：已过期，`authorize` 会明确拒（手机端提示重新扫码）
    const verdict = store.authorize({ token: device.token, mobileKey: 'mk-1', now: T0 + 91 * DAY })
    expect(verdict).toEqual({ ok: false, reason: 'expired' })
  })

  it('touch 会更新 lastSeenAt 并回填手机 key', () => {
    const store = new PairingStore()
    const device = store.register('手机', { now: T0 })
    expect(device.mobileKey).toBe(null)
    const touched = store.touch(device.deviceId, { mobileKey: 'mk-new', now: T0 + DAY })!
    expect(touched.mobileKey).toBe('mk-new')
    expect(touched.lastSeenAt).toBe(T0 + DAY)
    expect(store.lookupByMobileKey('mk-new')?.deviceId).toBe(device.deviceId)
  })
})

describe('PairingStore —— 票据', () => {
  it('issue → 有效；超过 TTL → 失效（并被清掉）', () => {
    const store = new PairingStore()
    const ticket = store.issueTicket()
    expect(store.hasValidTicket(ticket)).toBe(true)
    expect(store.hasValidTicket(ticket, Date.now() + PAIRING_TICKET_TTL_MS + 1)).toBe(false)
    expect(store.pendingTickets()).toBe(0)
  })

  it('redeem：一次性消费，签发凭证（token 与票据不同）', () => {
    const store = new PairingStore()
    const ticket = store.issueTicket()
    const device = store.redeemTicket(ticket, { mobileKey: 'mk-1', name: '小米', now: T0 })
    expect(device.token).not.toBe(ticket)
    expect(device.token).toMatch(/^gt-/)
    expect(device.name).toBe('小米')
    expect(store.hasValidTicket(ticket)).toBe(false)
    // 再兑一次 → 抛（票据已消费）
    expect(() => store.redeemTicket(ticket, { now: T0 })).toThrow()
  })

  it('redeem 不接受过期票据', () => {
    const store = new PairingStore()
    const ticket = store.issueTicket()
    expect(() => store.redeemTicket(ticket, { now: Date.now() + PAIRING_TICKET_TTL_MS + 1 })).toThrow()
  })
})

describe('PairingStore —— 撤销与墓碑', () => {
  it('撤销：凭证立即失效，且给手机留一条「你是被移除的」依据', () => {
    const store = new PairingStore()
    const device = store.register('手机', { mobileKey: 'mk-1', now: T0 })
    const spy = vi.fn()
    store.onChange = spy

    expect(store.revoke(device.deviceId, T0 + DAY)).toBe(true)
    expect(store.lookup(device.token)).toBe(null)
    expect(store.isRevoked('mk-1')).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)

    // 凭旧凭证来连 → revoked（而不是笼统的 invalid）
    expect(store.authorize({ token: device.token, mobileKey: 'mk-1', now: T0 + DAY })).toEqual({
      ok: false,
      reason: 'revoked',
    })

    // 重新扫码（有效票据）时可以重新配对 —— 即使这台手机在墓碑里
    const ticket = store.issueTicket()
    expect(store.authorize({ token: ticket, mobileKey: 'mk-1', now: T0 + 2 * DAY })).toEqual({
      ok: false,
      reason: 'first-time',
    })
    const again = store.redeemTicket(ticket, { mobileKey: 'mk-1', now: T0 + 2 * DAY })
    expect(again.token).toMatch(/^gt-/)
  })

  it('墓碑有上限（不无限增长）', () => {
    const store = new PairingStore()
    for (let i = 0; i < 25; i += 1) {
      const d = store.register(`手机${i}`, { mobileKey: `mk-${i}`, now: T0 })
      store.revoke(d.deviceId, T0 + i)
    }
    expect(store.snapshot().revoked!.length).toBeLessThanOrEqual(20)
  })

  it('撤销不存在的设备 → false，不抛错', () => {
    const store = new PairingStore()
    expect(store.revoke('dev-nope')).toBe(false)
  })

  /**
   * M10 真机反馈：移除一台手机后，它断开又自动重连，结果**又连上了**。
   *
   * 记录与凭证都删对了 —— 漏的是**票**：票是一张「配对权」，任何端出示它就能换出一台**新**设备，
   * 而被移除的那台手机手上正好可能有（它扫过屏上那张码、缓存过配对载荷）。
   */
  it('移除 = 删记录 + 记墓碑 + **作废所有未使用的票**（旧码不再有配对权）', () => {
    const store = new PairingStore()
    const t1 = store.issueTicket()
    const device = store.register('手机', { mobileKey: 'mk-1', now: T0 })
    const t2 = store.issueTicket()
    expect(store.pendingTickets()).toBe(2)

    expect(store.revoke(device.deviceId, T0)).toBe(true)

    expect(store.list()).toEqual([])
    expect(store.lookup(device.token)).toBe(null)
    expect(store.isRevoked('mk-1')).toBe(true)
    // 已发出去的票一张都不作数（无论是最早那张还是刚刚那张）
    expect(store.hasValidTicket(t1)).toBe(false)
    expect(store.hasValidTicket(t2)).toBe(false)
    expect(store.pendingTickets()).toBe(0)
    // 快照里也不留票：否则重启后它们又「活」了
    expect(store.snapshot().tickets).toEqual([])
  })
})
