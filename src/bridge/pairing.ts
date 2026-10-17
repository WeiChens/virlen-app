/**
 * 配对与授权凭证。三个概念：设备 key（谁是设备）、配对票据（5 分钟一次性）、
 * 授权凭证（30 天滑动，最长 90 天）。移除 = 删记录 + 墓碑 + 作废所有未使用的票。
 */
import {
  GRANT_MAX_LIFETIME_MS,
  GRANT_TTL_MS,
  PAIRING_TICKET_TTL_MS,
  checkGrant,
  issueGrant,
  renewGrant,
  type CredentialRejectReason,
  type GrantRecord,
} from 'virlen-remote'
import { track } from '@/utils/telemetry'
import { PHONE_EVENTS, tokenHash } from './telemetry'

export interface PairedDevice extends GrantRecord {
  /** 本机生成的行 id（列表 key / 撤销目标）。 */
  deviceId: string
  /** 手机设备 key（mk-…）；null = 旧版记录，等它下次连上回填。 */
  mobileKey: string | null
  /** 显示名，纯本地标签：不参与授权判定，改名不需重新配对。 */
  name: string
  /** 首次配对时刻。 */
  pairedAt: number
}

/** 配对表快照（持久化用）。 */
export interface PairingSnapshot {
  devices: PairedDevice[]
  tickets: Array<{ token: string; issuedAt: number }>
  /** 已移除手机的墓碑（只留 key + 时间，最多 REVOKED_KEEP 条）。 */
  revoked?: Array<{ mobileKey: string; at: number }>
}

/** 授权判定结果（`host.hello` 据此决定放行 / 拒绝，以及给手机什么文案）。 */
export type AuthorizationResult =
  | { ok: true; device: PairedDevice; firstTime: boolean }
  | {
      ok: false
      /**
       * first-time：票据有效但未兑换；ticket-expired：二维码票过期；
       * 其余为凭证问题（见 CredentialRejectReason）。
       */
      reason: CredentialRejectReason | 'first-time' | 'ticket-expired'
    }

/** 同一台电脑保留的「已移除手机」墓碑上限（超过就丢最旧的）。 */
const REVOKED_KEEP = 20
/** 同时保留的待用票据上限（旧票据只按 TTL 失效）。 */
const TICKETS_KEEP = 8
/** 默认设备名：手机没报名时用。兑换 / 登记 / 迁移三处必须共用。 */
export const DEFAULT_DEVICE_NAME = 'Virlen 手机'
/** 设备名长度上限（会进列表 / 审计 / 埋点，必须有上界）。 */
export const DEVICE_NAME_MAX = 32

export class PairingStore {
  private readonly byToken = new Map<string, PairedDevice>()
  private readonly byDeviceId = new Map<string, PairedDevice>()
  private readonly byMobileKey = new Map<string, PairedDevice>()
  private readonly tickets = new Map<string, number>() // ticket → issuedAt
  private revoked: Array<{ mobileKey: string; at: number }> = []
  /**
   * 当前正连着的设备（瞬时状态，故意不进 snapshot：重启后就该从零开始）。
   */
  private activeId: string | null = null

  /** 变更回调：落盘与 UI 刷新都挂在这一个信号上，不要新增第二个。 */
  onChange: ((snapshot: PairingSnapshot) => void) | null = null

  /* 快照 / 迁移 */

  snapshot(): PairingSnapshot {
    return {
      devices: [...this.byDeviceId.values()].map((d) => ({ ...d })),
      tickets: [...this.tickets.entries()].map(([token, issuedAt]) => ({ token, issuedAt })),
      revoked: this.revoked.map((r) => ({ ...r })),
    }
  }

  /**
   * 从快照恢复（覆盖内存态）。旧记录（无 key / 有效期）按 pairedAt 起 30 天补全，
   * 旧手机不会因这次升级被踢下线。
   */
  restore(data: PairingSnapshot | null | undefined): void {
    if (!data) return
    this.byToken.clear()
    this.byDeviceId.clear()
    this.byMobileKey.clear()
    this.tickets.clear()
    // 在线标记不恢复（可能指向已被覆盖的记录）
    this.activeId = null
    for (const raw of (data.devices ?? []) as Array<Partial<PairedDevice>>) {
      const device = migrateDevice(raw)
      if (!device) continue
      this.index(device)
    }
    for (const t of data.tickets ?? []) this.tickets.set(t.token, t.issuedAt)
    this.revoked = (data.revoked ?? []).slice(-REVOKED_KEEP)
    this.pruneTickets()
  }

  private notify(): void {
    this.onChange?.(this.snapshot())
  }

  private index(device: PairedDevice): void {
    this.byToken.set(device.token, device)
    this.byDeviceId.set(device.deviceId, device)
    if (device.mobileKey) this.byMobileKey.set(device.mobileKey, device)
  }

  /* 在线标记（瞬时，不落盘） */

  /** 现在正连着本机的设备 id。 */
  get activeDeviceId(): string | null {
    return this.activeId
  }

  /** 标记哪台手机连着；只在真的变了时通知，抖动不反复落盘。 */
  setActive(deviceId: string | null): void {
    const next = deviceId && this.byDeviceId.has(deviceId) ? deviceId : null
    if (this.activeId === next) return
    this.activeId = next
    this.notify()
  }

  /* 票据（一次性） */

  /** 生成一次性配对票据（二维码携带）。 */
  issueTicket(): string {
    this.pruneTickets()
    const ticket = `pr-${randomToken()}`
    this.tickets.set(ticket, Date.now())
    this.notify()
    // 票据是凭证，只记哈希（不进埋点包原文）
    track(PHONE_EVENTS.pairTicket, {
      action: 'issue',
      ticket_hash: tokenHash(ticket),
      tickets: this.tickets.size,
    })
    return ticket
  }

  /** 刷新二维码：签发新票，不作废旧票（否则扫码在途时会失效）。 */
  refreshTicket(): string {
    return this.issueTicket()
  }

  /** 是否为有效（未过期）票据。 */
  hasValidTicket(token: string | undefined, now: number = Date.now()): boolean {
    if (!token) return false
    const issuedAt = this.tickets.get(token)
    if (issuedAt === undefined) return false
    if (now - issuedAt > PAIRING_TICKET_TTL_MS) {
      this.tickets.delete(token)
      // 票据过期（默认 5 分钟）
      track(PHONE_EVENTS.pairTicket, {
        action: 'expired',
        ticket_hash: tokenHash(token),
        tickets: this.tickets.size,
      })
      return false
    }
    return true
  }

  /** 作废一张未使用的票据（一般不必用）。 */
  revokeTicket(token: string): boolean {
    const ok = this.tickets.delete(token)
    if (ok) this.notify()
    track(PHONE_EVENTS.pairTicket, {
      action: 'revoke',
      ticket_hash: tokenHash(token),
      ok,
      tickets: this.tickets.size,
    })
    return ok
  }

  /** 清理过期票据并限制数量（防长开机攒下成百上千张）。 */
  pruneTickets(now: number = Date.now()): number {
    let dropped = 0
    for (const [token, issuedAt] of [...this.tickets]) {
      if (now - issuedAt > PAIRING_TICKET_TTL_MS) {
        this.tickets.delete(token)
        dropped += 1
      }
    }
    while (this.tickets.size > TICKETS_KEEP) {
      const oldest = [...this.tickets.entries()].sort((a, b) => a[1] - b[1])[0]
      if (!oldest) break
      this.tickets.delete(oldest[0])
      dropped += 1
    }
    return dropped
  }

  /** 待用票据数（设置页提示用）。 */
  pendingTickets(): number {
    this.pruneTickets()
    return this.tickets.size
  }

  /* 凭证（长期） */

  /**
   * 用票据登记一台手机并签发凭证。同一台手机重复扫码按 mobileKey 归并：
   * 复用原记录、换发新 grant，并清掉它的「已移除」墓碑。
   */
  redeemTicket(
    ticket: string,
    options: { mobileKey?: string | null; name?: string; now?: number } = {},
  ): PairedDevice {
    const now = options.now ?? Date.now()
    if (!this.hasValidTicket(ticket, now)) {
      throw new Error('配对票据无效或已过期')
    }
    this.tickets.delete(ticket)

    const existing = options.mobileKey ? this.lookupByMobileKey(options.mobileKey) : null
    const grant = issueGrant(now)
    const device: PairedDevice = existing
      ? {
          ...existing,
          ...grant, // 换最新凭证；deviceId / name / pairedAt 沿用
          mobileKey: options.mobileKey ?? existing.mobileKey,
        }
      : {
          ...grant,
          deviceId: `dev-${randomToken()}`,
          mobileKey: options.mobileKey ?? null,
          name: normalizeDeviceName(options.name) ?? DEFAULT_DEVICE_NAME,
          pairedAt: now,
        }

    // 换 token 时删掉旧反查项，否则 byToken 会残留指向同一设备的旧凭证
    if (existing) this.byToken.delete(existing.token)
    this.index(device)
    this.clearRevoked(device.mobileKey)
    // 刚兑换 = 这台手机此刻就在用（与下面的 notify 合并成一次通知）
    this.activeId = device.deviceId
    this.notify()
    track(PHONE_EVENTS.pairTicket, {
      action: existing ? 'redeem-existing' : 'redeem',
      ticket_hash: tokenHash(ticket),
      device_id_hash: tokenHash(device.deviceId),
      tickets: this.tickets.size,
    })
    return device
  }

  /** 直接登记一台手机并签发凭证（测试 / 已配对设备续用）。 */
  register(
    name: string,
    options: { mobileKey?: string | null; now?: number } = {},
  ): PairedDevice {
    const now = options.now ?? Date.now()
    const device: PairedDevice = {
      ...issueGrant(now),
      deviceId: `dev-${randomToken()}`,
      mobileKey: options.mobileKey ?? null,
      name: normalizeDeviceName(name) ?? DEFAULT_DEVICE_NAME,
      pairedAt: now,
    }
    this.index(device)
    this.notify()
    return device
  }

  /**
   * 改名：只动 name，token / 有效期 / mobileKey / 在线标记不变。
   * 名字非法保持原名，没变则不发通知，设备不存在返回 null。
   */
  rename(deviceId: string, name: string): PairedDevice | null {
    const current = this.byDeviceId.get(deviceId)
    if (!current) return null
    const next = normalizeDeviceName(name)
    if (!next) return null
    if (next === current.name) return current
    const updated: PairedDevice = { ...current, name: next }
    // 三张索引表共用同一对象引用，改名必须重新登记
    this.index(updated)
    this.notify()
    return updated
  }

  /** 按凭证串找设备（不校验有效期，由 authorize 统一判定）。 */
  lookup(token: string | undefined): PairedDevice | null {
    if (!token) return null
    return this.byToken.get(token) ?? null
  }

  lookupByMobileKey(mobileKey: string | undefined): PairedDevice | null {
    if (!mobileKey) return null
    return this.byMobileKey.get(mobileKey) ?? null
  }

  /**
   * 授权判定（host.hello 的唯一入口），不弹确认框。
   * 顺序关键：先看票据 —— 被移除过的手机拿新码来时应能重新配对。
   */
  authorize(
    params: { token?: string; mobileKey?: string | null; now?: number },
  ): AuthorizationResult {
    const now = params.now ?? Date.now()
    const device = this.lookup(params.token)
    if (!device) {
      // 先看票据：被移除过的手机重新扫码应能再配对
      if (this.hasValidTicket(params.token, now)) {
        // 票据可用：调用方先走桌面确认，再 redeemTicket
        return { ok: false, reason: 'first-time' }
      }
      if (params.mobileKey && this.isRevoked(params.mobileKey)) {
        return { ok: false, reason: 'revoked' }
      }
      // 区分「过期的一次性票据」与「凭空来的串」
      if (params.token?.startsWith('pr-')) return { ok: false, reason: 'ticket-expired' }
      return { ok: false, reason: 'invalid' }
    }

    // 记录有 key 而这次带了另一个 key → 凭证被搬到别的手机
    if (device.mobileKey && params.mobileKey && device.mobileKey !== params.mobileKey) {
      return { ok: false, reason: 'invalid' }
    }
    const reject = checkGrant(device, now)
    if (reject) return { ok: false, reason: reject }

    const updated = this.touch(device.deviceId, { mobileKey: params.mobileKey, now })
    return { ok: true, device: updated ?? device, firstTime: false }
  }

  /**
   * 记录一次成功连接：滑动续期 + 回填手机 key + 更新 lastSeenAt。
   */
  touch(
    deviceId: string,
    options: { mobileKey?: string | null; now?: number } = {},
  ): PairedDevice | null {
    const current = this.byDeviceId.get(deviceId)
    if (!current) return null
    const now = options.now ?? Date.now()
    const renewed = renewGrant(current, now)
    const mobileKey = current.mobileKey ?? options.mobileKey ?? null
    const updated: PairedDevice = { ...current, ...renewed, mobileKey }
    // 索引表共用同一对象引用，回填 key 后必须重新登记
    this.byToken.set(updated.token, updated)
    this.byDeviceId.set(updated.deviceId, updated)
    if (mobileKey) this.byMobileKey.set(mobileKey, updated)
    // 握过手 = 它现在就连着
    this.activeId = updated.deviceId
    this.notify()
    return updated
  }

  /**
   * 撤销某台手机（「移除」）：删记录 + 记墓碑，并作废所有未使用的票。
   * 票本身就是「配对权」，不清理的话被移除的手机会拿缓存的票换出一台新设备。
   */
  revoke(deviceId: string, now: number = Date.now()): boolean {
    const device = this.byDeviceId.get(deviceId)
    if (!device) return false
    this.byDeviceId.delete(deviceId)
    this.byToken.delete(device.token)
    // 移除的正是当前连着的那台 → 同步清在线标记
    if (this.activeId === deviceId) this.activeId = null
    if (device.mobileKey) {
      this.byMobileKey.delete(device.mobileKey)
      this.revoked = [...this.revoked.filter((r) => r.mobileKey !== device.mobileKey), { mobileKey: device.mobileKey, at: now }].slice(
        -REVOKED_KEEP,
      )
    }
    // 已发出去的票一律作废；数量只为埋点，不留存原文
    const droppedTickets = this.tickets.size
    this.tickets.clear()
    this.notify()
    track(PHONE_EVENTS.pairRevoke, {
      device_id_hash: tokenHash(deviceId),
      remaining: this.byDeviceId.size,
      tickets_dropped: droppedTickets,
    })
    return true
  }

  /** 该手机 key 是否在「已移除」墓碑里。 */
  isRevoked(mobileKey: string | undefined): boolean {
    if (!mobileKey) return false
    return this.revoked.some((r) => r.mobileKey === mobileKey)
  }

  /** 清掉某台手机的墓碑（重新配对成功后）。 */
  private clearRevoked(mobileKey: string | null): void {
    if (!mobileKey) return
    const next = this.revoked.filter((r) => r.mobileKey !== mobileKey)
    if (next.length !== this.revoked.length) this.revoked = next
  }

  list(): PairedDevice[] {
    return [...this.byDeviceId.values()].sort((a, b) => b.pairedAt - a.pairedAt)
  }

  /**
   * 列表 + 在线标记（设置页的全部读取面）。activeId 是连接状态，不是设备属性。
   */
  view(): { devices: PairedDevice[]; activeDeviceId: string | null } {
    return { devices: this.list(), activeDeviceId: this.activeId }
  }

  get size(): number {
    return this.byDeviceId.size
  }
}

/**
 * 迁移一条可能来自旧版本或损坏的设备记录；救不回来则返回 null（丢一条好过整表加载失败）。
 */
function migrateDevice(raw: Partial<PairedDevice> | null | undefined): PairedDevice | null {
  if (!raw || typeof raw.token !== 'string' || !raw.token) return null
  const pairedAt = typeof raw.pairedAt === 'number' ? raw.pairedAt : Date.now()
  const issuedAt = typeof raw.issuedAt === 'number' ? raw.issuedAt : pairedAt
  const expiresAt =
    typeof raw.expiresAt === 'number'
      ? raw.expiresAt
      : Math.min(issuedAt + GRANT_TTL_MS, issuedAt + GRANT_MAX_LIFETIME_MS)
  return {
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : `dev-${randomToken()}`,
    mobileKey: typeof raw.mobileKey === 'string' && raw.mobileKey ? raw.mobileKey : null,
    name: normalizeDeviceName(raw.name) ?? DEFAULT_DEVICE_NAME,
    token: raw.token,
    issuedAt,
    expiresAt,
    pairedAt,
    ...(typeof raw.lastSeenAt === 'number' ? { lastSeenAt: raw.lastSeenAt } : {}),
  }
}

/** 归一设备名：折叠空白 + 去首尾 + 截断。全空白或非字符串返回 null。 */
export function normalizeDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  return oneLine.length > DEVICE_NAME_MAX ? oneLine.slice(0, DEVICE_NAME_MAX) : oneLine
}

function randomToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && 'randomUUID' in c) return c.randomUUID().replace(/-/g, '')
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
