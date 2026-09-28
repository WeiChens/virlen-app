/**
 * 配对与授权凭证（M6，见 docs/phone-control-bridge.md §30）。
 *
 * 三个概念必须分清（M2 时被简化成同一个东西，正是「扫码后提示二维码失效」与
 * 「列表里看不出谁能连、谁过期」的根源）：
 *
 * | 概念 | 生命周期 | 谁持有 | 作用 |
 * |---|---|---|---|
 * | **设备 key** | 永久（除非清数据） | 各自的持久化 | 「谁」—— 手机 `mk-…` / 电脑 `dk-…` |
 * | **配对票据** `ticket` | 5 分钟、一次性 | 二维码 / 手机手上那一刻 | 证明「扫的是这台电脑的码」 |
 * | **授权凭证** `grant` | 30 天，滑动续期，最长 90 天 | 电脑是真源、手机存副本 | 「凭什么是它」—— 免扫码直连的依据 |
 *
 * 流程：
 *   1. 电脑出码（内含一次性票据）→ 手机扫码 → hello 带票据 + 手机 key；
 *   2. 电脑弹窗确认 → **签发凭证**（`grant`）→ 交回手机（`HelloResult.grant`）；
 *   3. 之后手机拿凭证直连，每次成功连接**滑动续期**（`touch`），到 90 天硬上限后必须重新扫码；
 *   4. 电脑端「移除」= 删记录 + 记一条 tombstone + **作废所有未使用的票** → 手机再连将被明确告知
 *      「已被移除」（`revoked`）；它手上那张（或截屏里的）二维码也不再有配对权。
 *   5. 「改名」= 只换一个**本地标签**（`rename`）：名字不进授权判定，于是改名既不重新配对、
 *      也不影响已连着的那台（手机侧甚至不知道本机给它起了什么名）。
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
  /** 本机生成的行 id（列表 key / 撤销目标；与手机 key 分开，便于旧记录迁移）。 */
  deviceId: string
  /**
   * 手机设备 key（`mk-…`）。
   * `null` = 旧版手机（当时没有这个字段）—— 等它下次带 key 连上时回填（`touch`）。
   */
  mobileKey: string | null
  /**
   * 手机显示名 —— 手机自己报的（`host.hello` 的 `mobileName`），用户可在设置页改成任何名字
   * （`PairingStore.rename`）；两者都没有时用 `DEFAULT_DEVICE_NAME`。
   *
   * ⚠️ 名字是**本机给人看的标签**，不参与授权判定（认的是 `token` / `mobileKey`）——
   * 所以改名不需要重新配对，也不会让正连着的那台掉线。
   */
  name: string
  /** 首次配对时刻。 */
  pairedAt: number
}

/** 配对表快照（持久化用）。 */
export interface PairingSnapshot {
  devices: PairedDevice[]
  tickets: Array<{ token: string; issuedAt: number }>
  /** 已移除手机的墓碑（只留 key + 时间，最多 `REVOKED_KEEP` 条）—— 用于给「你是被移除的」提示。 */
  revoked?: Array<{ mobileKey: string; at: number }>
}

/** 授权判定结果（`host.hello` 据此决定放行 / 拒绝，以及给手机什么文案）。 */
export type AuthorizationResult =
  | { ok: true; device: PairedDevice; firstTime: boolean }
  | {
      ok: false
      /**
       * - `first-time`：票据有效但**还没兑换**（需桌面确认 + 签发凭证）；
       * - `ticket-expired`：那张二维码票已过期 —— 手机端文案是「请电脑端刷新二维码后重扫」；
       * - `invalid` / `expired` / `revoked`：凭证问题（见 `CredentialRejectReason`）。
       */
      reason: CredentialRejectReason | 'first-time' | 'ticket-expired'
    }

/** 同一台电脑保留的「已移除手机」墓碑上限（超过就丢最旧的）。 */
const REVOKED_KEEP = 20
/** 同时保留的待用票据上限（旧票据不作废，只按 TTL 失效；见 `refreshTicket`）。 */
const TICKETS_KEEP = 8
/**
 * 手机的默认名字：手机在 `host.hello` 里**没报**名字时用（旧版手机 / 故意不报）。
 *
 * ⚠️ 三处（兑换票据 / 直接登记 / 旧记录迁移）**必须**共用这一个常量：以前是三份写死的
 *「Virlen 手机」字面量，改一处漏两处就会让 `rename` 的「名字没变」判断失效。
 */
export const DEFAULT_DEVICE_NAME = 'Virlen 手机'
/**
 * 设备名长度上限（超出截断）。
 *
 * 名字会进列表、审计与埋点（`device_name`），必须有个上界：超长名字会把设置页那一行挤爆，
 * 也会让埋点包凭空变大。设置页的输入框同用这个上限（`maxLength`），于是「截断」在界面上
 * 通常不会真的发生 —— 但**真源在本文件**，手改磁盘快照进来的超长名字同样会被截。
 */
export const DEVICE_NAME_MAX = 32

export class PairingStore {
  private readonly byToken = new Map<string, PairedDevice>()
  private readonly byDeviceId = new Map<string, PairedDevice>()
  private readonly byMobileKey = new Map<string, PairedDevice>()
  private readonly tickets = new Map<string, number>() // ticket → issuedAt
  private revoked: Array<{ mobileKey: string; at: number }> = []
  /**
   * 当前**正连着**的已配对设备（设置页「已连接」高亮）。
   *
   * ⚠️ 这是**瞬时**状态，故意**不进 `snapshot()`**：重启后「谁连着」本来就该从零开始，
   * 落盘只会把一台早就断开的手机永远标成「已连接」。
   */
  private activeId: string | null = null

  /**
   * 变更回调：任何票据 / 设备 / 在线标记变更后触发。
   *
   * 两件事都挂在这一个信号上（**别再新增第二个回调**）：
   *  - 持久化落盘（服务内部 / 设置页 store 都这么用）；
   *  - UI 刷新 —— ⚠️ 这正是「扫码配对后『已绑定的手机』不新增」的缺陷根源：
   *    没有这个信号，配对表怎么变都不会冒泡到设置页。
   */
  onChange: ((snapshot: PairingSnapshot) => void) | null = null

  /* ───────────────────────── 快照 / 迁移 ───────────────────────── */

  snapshot(): PairingSnapshot {
    return {
      devices: [...this.byDeviceId.values()].map((d) => ({ ...d })),
      tickets: [...this.tickets.entries()].map(([token, issuedAt]) => ({ token, issuedAt })),
      revoked: this.revoked.map((r) => ({ ...r })),
    }
  }

  /**
   * 从快照恢复（覆盖当前内存态）。
   *
   * **迁移**：M6 之前的记录形如 `{ deviceId, name, token, pairedAt }` —— 没有 key、没有有效期。
   * 这类记录按「`pairedAt` 起 30 天」补全（`pairedAt` 缺失则按当下算），
   * 于是**旧手机不会被这次升级踢下线**（它下次连上时会被回填 key 与新的到期时间）。
   */
  restore(data: PairingSnapshot | null | undefined): void {
    if (!data) return
    this.byToken.clear()
    this.byDeviceId.clear()
    this.byMobileKey.clear()
    this.tickets.clear()
    // 在线标记不随快照恢复（且可能指向一条已被覆盖掉的记录）→ 一律归零
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

  /* ───────────────────────── 在线标记（瞬时，不落盘） ───────────────────────── */

  /** 现在正连着本机的设备 id（没有连接时为 `null`）。 */
  get activeDeviceId(): string | null {
    return this.activeId
  }

  /**
   * 标记「哪台手机现在连着」（链路断开 / 停用时传 `null`）。
   *
   * 只在**真的变了**的时候通知：链路抖动（close → open 反复）不该反复触发落盘与重渲染。
   * 设备已被移除 / 不认识时归一成 `null` —— 「已连接」必须指向列表里真实存在的一行。
   */
  setActive(deviceId: string | null): void {
    const next = deviceId && this.byDeviceId.has(deviceId) ? deviceId : null
    if (this.activeId === next) return
    this.activeId = next
    this.notify()
  }

  /* ───────────────────────── 票据（一次性） ───────────────────────── */

  /** 生成一次性配对票据（二维码内容里携带）。 */
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

  /**
   * 刷新二维码：签发新票据并返回。
   *
   * ⚠️ **不作废旧票据**（M6 修正）。旧实现是「刷新即作废」，但真机上存在这个竞态：
   * 用户扫码的那一刻恰好赶上自动刷新 → 手机手上那张票据刚被作废 → 「二维码失效」。
   * 现在旧票据只按 TTL（5 分钟）自然过期，且数量上限 `TICKETS_KEEP`（超出丢最旧）。
   */
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
      // 「扫码后连不上」的第一现场：票据过期（默认 5 分钟）
      track(PHONE_EVENTS.pairTicket, {
        action: 'expired',
        ticket_hash: tokenHash(token),
        tickets: this.tickets.size,
      })
      return false
    }
    return true
  }

  /** 作废一张未使用的票据（用户主动点「刷新」以外的场景；一般不必用）。 */
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

  /** 清理过期票据 + 限制数量（防止长开机的电脑攒下成百上千张）。 */
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

  /* ───────────────────────── 凭证（长期） ───────────────────────── */

  /**
   * 用票据登记一台手机并**签发凭证**（首次配对路径）。
   *
   * ⚠️ **同一台手机重复扫码不新增记录**（按 `mobileKey` 归并）：手机每次扫到的都是一张
   * 新的一次性票据，若每次 `redeem` 都新登记一条，「已绑定手机」列表就会堆出多条一模一样的
   * 记录。凭证（`token`）本就允许换新 —— **记录只留一条，凭证换成最新的**，授权通过后写回即可。
   *
   * 归并口径：
   *  - 命中已有设备（按 `mobileKey`）→ **复用同一条**（`deviceId` / `name` / `pairedAt` 不变），
   *    换发一版新 `grant`，并置为当前在线设备；
   *  - 未命中（新手机，或原记录已被移除）→ 新登记一条；
   *  - 两种情况都**清掉该 key 的「已移除」墓碑** —— 重新配对成功 = 它不再是「被移除」的。
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
          ...grant, // 换最新凭证；deviceId / name / pairedAt 沿用原记录
          mobileKey: options.mobileKey ?? existing.mobileKey,
        }
      : {
          ...grant,
          deviceId: `dev-${randomToken()}`,
          mobileKey: options.mobileKey ?? null,
          name: normalizeDeviceName(options.name) ?? DEFAULT_DEVICE_NAME,
          pairedAt: now,
        }

    // 换 token 时删掉旧键的反查项，否则 `byToken` 里会残留一条指向同一设备的旧凭证
    if (existing) this.byToken.delete(existing.token)
    this.index(device)
    this.clearRevoked(device.mobileKey)
    // 刚兑换票据 = 这台手机此刻就在用（直接写字段，与下面的 notify 合并成一次变更通知）
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
   * 给一台已配对手机**改名**（设置页行内编辑的唯一入口）。
   *
   * 名字是纯本地标注 —— 手机关心的是凭证（`token`），它甚至不知道本机给它起了什么名。
   * 所以这里刻意**只动 `name`**：`token` / 有效期 / `mobileKey` / `pairedAt` / 在线标记一律不变
   * （改名不是重新授权，也不会把正连着的那台踢下线）。
   *
   * 三条判定：
   *  - 名字非法（空白 / 非字符串）→ `null` 且**保持原名**。把设备名清成空串会让列表出现一行
   *    无名记录，比拒绝更难解释；设置页的「保存」按钮同理（空白时禁用）；
   *  - 名字没变 → 返回当前记录，**不发通知**（一次无意义的落盘 + 全页重渲染不值得，与
   *    `setActive` 同一取舍）；
   *  - 设备不存在 → `null`（多半是它刚被移除，调用方据此提示）。
   *
   * @returns 改好后的设备；设备不存在或名字非法时 `null`
   */
  rename(deviceId: string, name: string): PairedDevice | null {
    const current = this.byDeviceId.get(deviceId)
    if (!current) return null
    const next = normalizeDeviceName(name)
    if (!next) return null
    if (next === current.name) return current
    const updated: PairedDevice = { ...current, name: next }
    // 三张索引表共用同一个对象引用：改了名字必须**重新登记**，否则按凭证 / key 反查拿到的是旧对象
    this.index(updated)
    this.notify()
    return updated
  }

  /** 按凭证串找设备（**不**校验有效期 —— 由 `authorize` 统一判定）。 */
  lookup(token: string | undefined): PairedDevice | null {
    if (!token) return null
    return this.byToken.get(token) ?? null
  }

  lookupByMobileKey(mobileKey: string | undefined): PairedDevice | null {
    if (!mobileKey) return null
    return this.byMobileKey.get(mobileKey) ?? null
  }

  /**
   * 授权判定（`host.hello` 的唯一入口）。
   *
   * 四种结果：
   *  - `ok` + `firstTime=false`：老设备直连（顺带滑动续期、回填手机 key）；
   *  - `ok` + `firstTime=true`：票据兑换（**调用方需先完成桌面确认**）；
   *  - `expired`：凭证过期 → 手机端提示「重新扫码」；
   *  - `revoked`：该手机的 key 在墓碑里 → 提示「已被电脑端移除」；
   *  - `invalid`：凭证串无效（伪造 / 换了电脑端身份）。
   *
   * ⚠️ 这里**不**弹确认框：首次配对的确认在 `host-source`（它要 await 用户的点击），
   * 本方法只回答「这张票据/凭证能不能用」。
   */
  authorize(
    params: { token?: string; mobileKey?: string | null; now?: number },
  ): AuthorizationResult {
    const now = params.now ?? Date.now()
    const device = this.lookup(params.token)
    if (!device) {
      // ⚠️ 顺序关键：**先看票据**。用户拿着新扫的码来配对时，即使这台手机之前在墓碑里
      //（曾被移除），也应该能重新配对 —— 这正是「移除后必须重新扫码」的完整语义。
      if (this.hasValidTicket(params.token, now)) {
        // 票据可用：调用方（host-source）先走桌面确认，再 `redeemTicket`
        return { ok: false, reason: 'first-time' }
      }
      if (params.mobileKey && this.isRevoked(params.mobileKey)) {
        return { ok: false, reason: 'revoked' }
      }
      // 区分「过期的一次性票据」与「凭空来的串」：前者的文案应该是「请电脑端刷新二维码」
      if (params.token?.startsWith('pr-')) return { ok: false, reason: 'ticket-expired' }
      return { ok: false, reason: 'invalid' }
    }

    // 绑定校验：记录里有 key 而这次带了另一个 key → 拒绝（凭证被搬到别的手机）
    if (device.mobileKey && params.mobileKey && device.mobileKey !== params.mobileKey) {
      return { ok: false, reason: 'invalid' }
    }
    const reject = checkGrant(device, now)
    if (reject) return { ok: false, reason: reject }

    const updated = this.touch(device.deviceId, { mobileKey: params.mobileKey, now })
    return { ok: true, device: updated ?? device, firstTime: false }
  }

  /**
   * 记录一次成功连接：滑动续期 + 回填手机 key + 更新 `lastSeenAt`。
   * @returns 更新后的设备（不存在则 `null`）
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
    // 三张索引表共用同一个对象引用，回填 key 后必须重新登记（否则 byMobileKey 查不到）
    this.byToken.set(updated.token, updated)
    this.byDeviceId.set(updated.deviceId, updated)
    if (mobileKey) this.byMobileKey.set(mobileKey, updated)
    // 握过手 = 它现在就连着（`authorize` 只在成功后调 touch）
    this.activeId = updated.deviceId
    this.notify()
    return updated
  }

  /**
   * 撤销某台手机（电脑端「移除」）。
   *
   * 同时记一条墓碑：手机下次来连时能被明确告知「已被移除」（而不是笼统的「凭证无效」）——
   * 这正是用户要的「移除后点击列表连不上，必须重新扫码」的可解释版本。
   *
   * ⚠️ **同时作废所有未使用的配对票**（M10 真机反馈）。
   *
   * 为什么「删设备 + 记墓碑」还不够：**票本身是一种「配对权」** —— 任何拿到它的端（只要出示
   * 就给配）都能换出一台**新**设备。而被移除的那台手机手上正好可能有票：它扫过屏上那张码、
   * 缓存过配对载荷，断开后自动重试时把票再交一次，就又是一台「已绑定的手机」。
   * 于是「移除」在用户看来等于没移除（删记录 → 立刻长回来）。
   *
   * 票只按 TTL 自然过期（`refreshTicket` 的既定语义），所以这里必须显式全清：
   * 清掉之后，被移除的那台手机**唯一**的回来方式就只剩「重新扫电脑屏幕上那张新码 + 电脑确认」。
   * 清票的副作用（扫到旧码的人会拿到 `ticket-expired`）由调用方补齐：
   * `PhoneControlService` 会在移除后立刻换一张新码，屏上的码始终可用。
   */
  revoke(deviceId: string, now: number = Date.now()): boolean {
    const device = this.byDeviceId.get(deviceId)
    if (!device) return false
    this.byDeviceId.delete(deviceId)
    this.byToken.delete(device.token)
    // 移除的正是当前连着的那台 → 在线标记同步清掉（否则列表里会留下一个指向空行的「已连接」）
    if (this.activeId === deviceId) this.activeId = null
    if (device.mobileKey) {
      this.byMobileKey.delete(device.mobileKey)
      this.revoked = [...this.revoked.filter((r) => r.mobileKey !== device.mobileKey), { mobileKey: device.mobileKey, at: now }].slice(
        -REVOKED_KEEP,
      )
    }
    // 已发出去的票一律不再作数（见上面的说明）；数量只为埋点，不留存原文
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

  /** 清掉某台手机的「已移除」墓碑（重新配对成功后调用）。 */
  private clearRevoked(mobileKey: string | null): void {
    if (!mobileKey) return
    const next = this.revoked.filter((r) => r.mobileKey !== mobileKey)
    if (next.length !== this.revoked.length) this.revoked = next
  }

  list(): PairedDevice[] {
    return [...this.byDeviceId.values()].sort((a, b) => b.pairedAt - a.pairedAt)
  }

  /**
   * 列表 + 在线标记（设置页「已绑定的手机」的全部读取面）。
   *
   * `activeId` 单独给而不是塞进 `PairedDevice`：它是「这次连接」的事实，不是设备本身的属性，
   * 落盘的快照里也不该有它。
   */
  view(): { devices: PairedDevice[]; activeDeviceId: string | null } {
    return { devices: this.list(), activeDeviceId: this.activeId }
  }

  get size(): number {
    return this.byDeviceId.size
  }
}

/**
 * 迁移一条可能来自旧版本（或损坏）的设备记录。
 * @returns 合法记录；无法救回时 `null`（丢一条记录好过整表加载失败）
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

/**
 * 归一一个设备名：折叠空白（换行 / 制表符都压成空格）+ 去首尾 + 截到 `DEVICE_NAME_MAX`。
 *
 * 折叠空白不只是洁癖：名字会进列表的一行、审计正文与埋点，带换行的名字会把那三处都撑歪。
 *
 * @returns 可用的名字；**全是空白 / 不是字符串**时 `null`（调用方一律回退到默认名或保持原名）
 */
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
