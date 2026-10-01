/**
 * 电脑端「手机控制」服务 —— 设置页 QR 入口背后的常驻服务。
 *
 * 职责：启用后**常驻信令房间**（角色 host），等手机扫码加入 → 建 RTC 链路 →
 * 挂上 `startPhoneBridge`（复用 M2 的 host.* 接口层 / ACL / 审计 / store 推送）。
 *
 * 角色（§8 拍板）：**电脑发起 offer**；手机加入后由电脑发 offer。
 *
 * 状态机（设置页那颗胶囊的全部真相）：
 *
 * ```
 * disabled ──enable──▶ waiting ──有人接入──▶ verifying ──hello ok──▶ connected
 *                          ▲                    │
 *                          └──── 对端离开 ───────┤
 *                                               └──hello 被拒──▶ rejected（并踢掉那条链路）
 * ```
 *
 * 关键是 `waiting` / `verifying` / `rejected` **三件事分开说**：
 * 「没人在连」、「有人在连但还没证明它是谁」、「刚拒了一台」——原实现把它们挤进
 * 「等待手机连接…（链路已建立，等待手机握手…）」，用户读到的就成了「我在等它连上」。
 *
 * ⚠️ 真机蜂窝网联调需人工完成（无法在此环境跑真实 WebRTC）。
 */
import {
  Endpoint,
  PAIRING_TICKET_TTL_MS,
  RtcTransport,
  SseSignalingClient,
  buildPairingPayload,
  roomFor,
  type GrantRecord,
  type IceServerInit,
  type PairingPayload,
  type SignalingChannel,
  type Transport,
} from 'virlen-remote'
import { hashText, urlHost } from '@/utils/telemetry'
import { AuditLog, type AuditPersist } from './audit'
import type { InteractionRegistry } from './interaction-registry'
import { LinkKindWatcher, transferTierOf, type LinkKind } from './link-kind'
import { PairingStore, type PairingSnapshot } from './pairing'
import { startPhoneBridge, type HelloOutcome, type PhoneBridge } from './index'
import {
  instrumentSignaling,
  instrumentTransport,
  traceLinkDisable,
  traceLinkEnable,
  traceLinkError,
  type PhoneInstrument,
} from './telemetry'

/**
 * 服务状态（设置页那颗状态胶囊直接读它）。
 *
 * 正常路径 `waiting → verifying → connected`；两条否定路径单独成态，因为它们要说的事不是
 * 「还在等」：
 *  - `verifying`：**有人接入了，还没证明它是谁**（链路已通，`host.hello` 还没出结论）；
 *  - `rejected`：**接入被拒**（已被移除 / 凭证过期 / 二维码过期 / 用户点了拒绝）。
 *
 * 为什么把 `verifying` 从 `waiting` 里拆出来：这两件事在原实现里共用一个状态，界面上
 * 一律显示「等待手机连接…（链路已建立，等待手机握手…）」—— 用户读到的是「我在等一台手机连上」，
 * 而事实往往是「刚才那台被移除的手机又摸进来了」。等和拒是两件事，不能含糊成一句。
 */
export type PhoneControlStatus =
  | 'disabled'
  | 'waiting'
  | 'verifying'
  | 'connected'
  | 'rejected'
  | 'error'

/**
 * 二维码 / 配对串载荷 —— **单一真源在 `virlen-remote`**（与手机端 `parsePairingPayload` 同一份）。
 * 这里只是重新导出，避免电脑端再写一份 interface 与之漂移（§26 的教训）。
 */
export type { PairingPayload }

export interface PhoneControlOptions {
  /** 信令基址，如 `https://virlen.cn/api/rtc/`。 */
  signalUrl: string
  deviceName: string
  /**
   * 电脑设备 key（`dk-…`）。**必须持久化**（见 `device-identity.ts`）——
   * 房间号由它派生，手机列表也记它；变了就等于换了一台电脑。
   */
  deviceKey: string
  appVersion?: string
  /**
   * ICE 服务器列表 —— **由调用方解析后传入**（M7，§31）。
   *
   * 服务本身不再内置任何默认值，更不会内置 TURN 凭证：默认值来自信令服务下发
   * （`GET <信令基址>/ice`），解析与降级都在共享包的 `resolveIceServers()` 里（两端同一份）。
   * 不传 = 只用本机候选（局域网可用，跨网多半连不上）—— 不再是「偷偷用某个内置服务器」。
   */
  iceServers?: IceServerInit[]
  /** 本次 ICE 的来源（`custom` / `remote` / `cache` / `stale-cache` / `none`），只进埋点。 */
  iceSource?: string
  /** 首次绑定确认（桌面弹窗）；返回 false 则拒绝。生产必须传。 */
  confirmPair?: (ctx: { token: string; deviceName: string }) => Promise<boolean>
  /**
   * 审计日志实例（M4）：由调用方（设置页 store）持有，使设置页能读到与 bridge **同一份**记录。
   * 不传则内部新建（仅内存）。
   */
  audit?: AuditLog
  /** 审计落盘（旁路）。Tauri 下接 Rust JSONL 追加。 */
  auditPersist?: AuditPersist
  /** 桌面侧提示（手机批准高风险操作时，§16.3-2）。 */
  notify?: (text: string) => void
  /** 状态变化回调（UI 订阅）。 */
  onStatusChange?: (status: PhoneControlStatus, detail?: string) => void
  /**
   * 通讯类型变化回调（设置页「已连接」旁边那枚 `P2P 直连 / TURN 中继` 胶囊）。
   *
   * 独立于 `onStatusChange`：两者正交 —— 状态是「连没连上」，类型是「怎么连上的」。
   * 链路断开 / 停用时回调 `unknown`（UI 据此把胶囊收起来，而不是留着上一次的结论）。
   */
  onLinkKindChange?: (kind: LinkKind) => void
  /** 测试注入：按房间建传输（默认建 host 角色的 RtcTransport）。 */
  createTransport?: (room: string) => Transport
  /**
   * 配对表持久化（M3-5：Tauri 下由 Rust 命令写 `<data_dir>/phone-pairing.json`）。
   * 不传则仅内存保存（浏览器 harness / 单测）。
   *
   * ⚠️ 只在**服务自己持有配对表**（未注入 `pairing`）时生效。
   */
  persistence?: PhonePairingPersistence
  /**
   * 复用调用方持有的配对表（设置页 store 传入）。
   *
   * 为什么必须能注入（M8，真机缺陷「配对成功后『已绑定的手机』不新增」）：
   *  - 列表要能冒泡：服务原本只把配对表的变更用于**落盘**，配对表怎么变都不通知 UI，
   *    而设置页只在 enable / 点「允许」的瞬间拉一次 —— 那时手机还没兑换票据（异步），
   *    于是列表永远是旧的；
   *  - 列表要随时可见：未启用时服务根本不存在，「磁盘里有 3 台手机」在界面上是 0 台。
   * 把配对表交给**设置页 store 持有**（一张表、一个所有者），服务的启停 / 改 ICE 重建
   * 都不再影响它。注入后**落盘与变更通知归调用方**（本类不碰 `onChange`），
   * 避免两个所有者互相覆盖。
   */
  pairing?: PairingStore
  /**
   * 配对表变更回调（票据 / 设备 / 在线标记任一变化）。
   *
   * ⚠️ 只在服务**自己持有**配对表（未注入 `pairing`）时生效；注入时由调用方自行订阅 ——
   * 那是设置页刷新「已绑定的手机」的**唯一**信号，缺了它就是上面那个缺陷。
   */
  onPairingChange?: (snapshot: PairingSnapshot) => void
}

/** 配对表持久化端口（Rust 侧实现：读 / 写 JSON 文件）。 */
export interface PhonePairingPersistence {
  load(): Promise<string | null>
  save(json: string): void
}

/*
 * ⚠️ M7（§31）：这里**曾经**写死过一整套默认 ICE（含带静态口令的 TURN）。本客户端要开源，
 * 凭证不能随源码走 —— 现在默认值一律由信令服务下发（`GET <信令基址>/ice`），用户也可在
 * 设置页自行覆盖，解析逻辑在共享包 `resolveIceServers()`（两端同一份）。
 * **不要再往这里加任何服务器地址或凭证。**
 */

function normalizeBase(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * 握手被拒后「踢链」的延迟（毫秒）。
 *
 * 为什么不能当场断：拒绝原因要**通过这条链路**回给手机（`E_DENIED.data.reason`），而回帧是在
 * `host.hello` 抛出之后才发的（`Endpoint.onCall` 的 `catch` 里），当场 `close()` 会让那一帧发不出去
 *（`sendFrames` 见 `transport.state !== 'open'` 直接丢）→ 手机端收到的是「连接超时」而不是
 *「你已被移除」，与「移除后必须重新扫码」正好相反。留一点时间让那帧落地，再把它踢下去。
 */
export const REJECT_KICK_DELAY_MS = 500

/**
 * 「链路已 `open` 却迟迟没收到 `host.hello`」的兜底截止（毫秒）。
 *
 * 为什么需要：授权只发生在 `hello` 里，而**链路可以在同一次会话里被对端透明重建** ——
 * 手机端只看到 `connecting → open`，不会重跑连接流程，也就不会重发 `hello`。此时电脑端会
 * 永远停在「正在验证接入的设备」，而手机端还显示「在线」（典型：被移除的旧客户端在静默重连）。
 *
 * 取值刻意 > 手机端的 `HELLO_TIMEOUT_MS`（4 秒）：正常手机在链路 open 后立刻发 `hello`，
 * 收到请求即取消本计时（见 `onHelloReceived`）—— 所以本截止只对「开了链路却不说话」的对端生效；
 * 首次配对的确认弹窗（可能等几十秒）也因「请求已收到」而不受影响。
 */
export const HANDSHAKE_DEADLINE_MS = 8000

export class PhoneControlService {
  /**
   * 配对表（票据 / 已绑定设备）。
   *
   * 可由调用方注入（设置页 store 持有，使其在未启用时也能读）——
   * 不注入时本类自建，并自己管落盘与变更通知（单测 / 独立使用）。
   */
  readonly pairing: PairingStore
  /** 是否自己持有配对表：决定 `onChange` 与启动恢复归谁管（注入时一概不碰）。 */
  private readonly ownsPairing: boolean

  private status: PhoneControlStatus = 'disabled'
  private ticket: string | null = null
  /** 当前票据的签发时刻（二维码倒计时与「到期自动重生成」据此判定）。 */
  private ticketIssuedAt = 0
  private transport: Transport | null = null
  private endpoint: Endpoint | null = null
  private bridge: PhoneBridge | null = null
  private readonly base: string
  /** 通讯层埋点的包装器（链路/信令），停用时一并拆掉。 */
  private traces: PhoneInstrument[] = []
  /** 本次启用的时刻（算 `phone.link.disable` 的 uptime）。 */
  private enabledAt = 0
  /**
   * 本机侧 `RTCPeerConnection` —— 判定「直连 / 中继」用（`RtcTransport` 不对外暴露它）。
   * 每次重连 / 重协商都会换一个，故在工厂回调里**每次**重新挂钩。
   */
  private peerConnection: RTCPeerConnection | null = null
  /**
   * 本次链路是否已**通过 `hello`**（= 真的有一台被授权的手机在用）。
   *
   * 为什么不看 `transport` 状态：链路通只说明「有人进了房间」—— 被移除的那台手机也进得来
   *（房间号由设备 key 派生）。授权事实只有 `hello` 能给，见 `onHelloResult`。
   */
  private authorized = false
  /**
   * 最近一次握手被拒的原因（`null` = 没有待显示的拒绝结论）。
   *
   * 为什么它是「粘住」的，而不是一条转瞬即逝的提示：被拒的那台手机会不停重连，每次重连都会
   * 带来 `open`（有人接入了）与 `connecting`（它又走了）两条链路事件。若让这些事件照常写状态，
   * 用户看到的是「等待手机连接… → 正在验证… → 等待…」不停闪，而真正的事实（这台手机已经不许可了）
   * 一秒后就被刷掉 —— 那正是「不要搞这么暧昧的状态」要消掉的东西。
   * 所以拒绝结论**留到下一次成功握手或停用为止**，这期间链路怎么抖都不改状态。
   */
  private rejectReason: string | null = null
  /** 待执行的「踢链」（见 `REJECT_KICK_DELAY_MS`）；连续被拒只留一个定时器。 */
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 「链路 open 后握手截止」计时器（见 `HANDSHAKE_DEADLINE_MS`）。
   * 收到 `host.hello` 请求即取消；到点仍未收到 → 踢掉这条链路。
   */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 通讯类型巡检器（链路开着期间定时复查）。
   *
   * 为什么必须巡检而不是只靠事件：所选候选对会在打洞完成后、变网重协商后**变化**，
   * 而 ICE 状态可以一直停在 `completed` —— 那一刻一个事件都不会来（详见 `link-kind.ts`）。
   */
  private readonly kindWatch = new LinkKindWatcher((kind) => this.onLinkKind(kind))

  constructor(private readonly options: PhoneControlOptions) {
    this.base = normalizeBase(options.signalUrl)
    this.ownsPairing = options.pairing == null
    this.pairing = options.pairing ?? new PairingStore()
    // 注入的配对表：落盘 + 变更通知都在调用方那边（参见 options.pairing 的说明）
    if (!this.ownsPairing) return
    const persistence = options.persistence
    // 变更即落盘（fire-and-forget）+ 通知 UI；两者挂同一个信号，不拆两个回调
    this.pairing.onChange = (snap: PairingSnapshot) => {
      persistence?.save(JSON.stringify(snap))
      options.onPairingChange?.(snap)
    }
    if (!persistence) return
    // 启动时恢复
    void persistence
      .load()
      .then((raw) => {
        if (raw) this.pairing.restore(JSON.parse(raw) as PairingSnapshot)
        // ⚠️ `restore` **不**发变更通知（它是一次性覆盖）—— 必须在这里补一次，
        //    否则「磁盘里有 3 台手机、界面上是 0 台」会一直持续到下一次变更。
        options.onPairingChange?.(this.pairing.snapshot())
      })
      .catch(() => {
        /* 坏数据 / 读取失败：保持空配对表 */
      })
  }

  getStatus(): PhoneControlStatus {
    return this.status
  }

  /** 当前链路的通讯类型（`direct` = P2P 直连 / `relay` = TURN 中继 / `unknown` = 没结论）。 */
  getLinkKind(): LinkKind {
    return this.kindWatch.kind
  }

  /**
   * 通讯类型变化 → 桌面设置页 + 手机（`host.event.connection.changed`）。
   *
   * 为什么两处都要喂：
   *  - **桌面设置页**：用户在那台电脑前就能看到「这次是直连还是走中继」；
   *  - **手机**：协议事件让手机**拿电脑视角交叉校验**本端自己的判定 —— 两端口径已在共享包
   *    （`virlen-remote` 的 `classifyLinkKind`）收敛，对不上就说明有一端的 stats 读取出了问题。
   *
   * ⚠️ 事件的取值域只有 `direct` / `relay`（见协议表）：`unknown` = **没有结论**，
   * 此时**不发** —— 宁可让手机看不到电脑视角，也不发一个猜测。
   */
  private onLinkKind(kind: LinkKind): void {
    this.options.onLinkKindChange?.(kind)
    if (kind !== 'direct' && kind !== 'relay') return
    // 链路已拆时 `bridge` 为 `null`（`unknown` 也在此路径上）—— 不发是正确行为
    this.bridge?.emit('host.event.connection.changed', { path: kind })
  }

  /**
   * 开始「握手截止」计时：链路已 `open`，但还没收到 `host.hello`。
   *
   * 到点仍未收到 → 判定这不是一个合法会话（典型：被移除的旧客户端静默重连），踢掉这条链路 ——
   * 链路真正断开后，手机端才会走自己的重连并重新握手（届时会被 `rejectPeer` 拒掉）。
   */
  private armHandshakeDeadline(): void {
    this.clearHandshakeDeadline()
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      // 已授权 / 已停用都不该再踢（前者是正常通话，后者没有链路）
      if (this.authorized || this.status === 'disabled') return
      this.dropLink('handshake-timeout')
    }, HANDSHAKE_DEADLINE_MS)
  }

  /** 取消「握手截止」计时（收到 hello / 链路离开 open / 拆链 / 停用）。 */
  private clearHandshakeDeadline(): void {
    if (this.handshakeTimer == null) return
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  /** 待应答交互注册表（M4）；未启用时为 `null`。 */
  get interactions(): InteractionRegistry | null {
    return this.bridge?.interactions ?? null
  }

  /** 信令房间号 —— **由电脑设备 key 派生**（`roomFor`，与手机端同一份实现）。 */
  get room(): string {
    return roomFor(this.options.deviceKey)
  }

  /** 当前设备 key（手机端会记下它，下次不必扫码）。 */
  get deviceKey(): string {
    return this.options.deviceKey
  }

  /**
   * 当前二维码票据的**到期时刻**（毫秒）；尚未生成票据时为 `null`。
   *
   * 设置页据此显示倒计时，并在到期瞬间重新生成 —— 用户反馈的「扫码后提示二维码失效」
   * 就是这么消掉的（而不是让用户自己发现并手点「刷新二维码」）。
   */
  get ticketDeadline(): number | null {
    return this.ticket ? this.ticketIssuedAt + PAIRING_TICKET_TTL_MS : null
  }

  /** 当前待用票据数（含即将过期的那张）。 */
  get pendingTickets(): number {
    return this.pairing.pendingTickets()
  }

  /**
   * 当前配对载荷（二维码内容）。未启用时也会生成票据。
   *
   * ⚠️ 缓存的票据**已失效就该换新**：票据是一次性的，扫过一次后屏幕上那张码就作废了 ——
   * 用户拿同一张旧码再扫会得到「二维码已过期」。这里顺手转一张，让界面上的码永远是活的。
   */
  pairingPayload(): PairingPayload {
    if (!this.ticket || !this.pairing.hasValidTicket(this.ticket)) this.issueTicket()
    return buildPairingPayload({
      host: this.options.deviceKey,
      name: this.options.deviceName,
      ticket: this.ticket as string,
      signal: this.base,
    })
  }

  /**
   * 刷新二维码：签发新票据并返回。
   *
   * ⚠️ **不再作废旧票据**（M6 修正）：自动刷新与用户扫码存在竞态 ——
   * 「扫码在途时刷新」会把手机手上那张票作废，真机表现就是「扫码后提示二维码失效」。
   * 旧票据只按 TTL 自然过期（见 `PairingStore.refreshTicket`）。
   */
  refreshTicket(): PairingPayload {
    this.issueTicket()
    return this.pairingPayload()
  }

  private issueTicket(): void {
    this.ticket = this.pairing.issueTicket()
    this.ticketIssuedAt = Date.now()
  }

  /**
   * 票据**不可用**时重新生成（设置页倒计时 1 秒一跳时调）—— 三种都算：
   *  - 还没生成过；
   *  - 过了 TTL（5 分钟）；
   *  - **已被扫走**（一次性票据在 `redeemTicket` 里被删）或随「移除设备」被清空。
   *
   * ⚠️ 只查 TTL 是不够的（真机缺陷）：兑换发生在用户点「允许」**之后**，比它早的任何一次刷新
   * 都会错过这次消费，于是屏幕上那张码会一直「看着有效」到 TTL 到期 —— 真机表现就是「第一台
   * 手机连上后，第二台手机再扫屏幕上那张码，得到『二维码已过期』」，而它的接入在 `hello` 授权
   * **之前**就已把第一台顶掉（顶号发生在传输层）。
   *
   * @returns 是否真的换了新票
   */
  rotateTicketIfStale(now: number = Date.now()): boolean {
    if (this.ticket && this.pairing.hasValidTicket(this.ticket, now)) return false
    this.issueTicket()
    return true
  }

  /** 启用：常驻信令房间并挂上接口层。重复调用无副作用。 */
  enable(): void {
    if (this.status !== 'disabled' && this.status !== 'error') return
    // 重新启用 = 从头开始：上一条链路留下的「已拒绝接入」不该跟到这次来
    this.clearRejectNotice()
    if (!this.ticket) this.issueTicket()
    // 每次启用（含重新启用）都用新票：旧票据靠 TTL 自然失效，不断别人的在途扫码
    this.rotateTicketIfStale()
    this.startLink()
  }

  /**
   * 断开当前连接并**原地重开**（服务保持启用、**二维码与票据不变**）。
   *
   * 用于「移除正在连接的那台手机」：光删配对记录不够 —— 链路不会自己断，那台手机在链路关闭
   * 之前**仍能继续操作本机**（它的凭证已经失效，但已经建好的 RPC 通道不看凭证）。
   * 与 `disable()` 的差别只有两点：不停服务（继续等下一台）、不换二维码。
   */
  dropLink(reason: string = 'peer-revoked'): void {
    if (this.status === 'disabled') return
    traceLinkDisable({ reason, uptimeMs: this.enabledAt ? Date.now() - this.enabledAt : 0 })
    this.teardownLink()
    this.startLink()
  }

  /** 建一条链路（传输 + 接口层 + 埋点）并开始等对端 —— `enable()` 与 `dropLink()` 共用。 */
  private startLink(): void {
    const transport =
      this.options.createTransport?.(this.room) ??
      (this.buildRtcTransport() as unknown as Transport)
    this.transport = transport
    this.endpoint = new Endpoint({ transport, defaultTimeoutMs: 15_000 })
    // 新链路 = 重新开始授权（闸门从未授权起算）
    this.authorized = false
    this.bridge = startPhoneBridge(this.endpoint, {
      deviceName: this.options.deviceName,
      deviceId: this.options.deviceKey,
      appVersion: this.options.appVersion,
      pairing: this.pairing,
      confirmPair: this.options.confirmPair,
      audit: this.options.audit,
      auditPersist: this.options.auditPersist,
      notify: this.options.notify,
      // ⚠️ 必须开这道闸门：房间号由设备 key 派生，「把它踢出房间」做不到 —— 被移除的手机随时
      //    能重连。只有它能让「移除」真的生效（详见 `PhoneBridgeOptions.requireAuthorization`）。
      requireAuthorization: true,
      onHelloResult: (outcome) => this.applyHelloOutcome(outcome),
      // 收到 hello 请求就取消兜底截止（早于确认弹窗的 await，见 `HANDSHAKE_DEADLINE_MS`）
      onHelloReceived: () => this.clearHandshakeDeadline(),
      /*
       * §33：传输档位策略 —— 「直连发完整，中继 / 类型未知发精简」。
       *
       * 口径不在这里现算，而是读共享包的 `transferTierOf(kindWatch.kind)` —— 手机端也读同一份，
       * 两边不会「一个说精简、一个说完整」。
       *
       * ⚠️ 巡检起点是**握手成功之后**（见 `applyHelloOutcome`），所以链路刚建成那几毫秒里
       * `kindWatch.kind` 还是 `unknown` → 按拍板结果走**精简**（宁可把其实是直连的链路先按精简发，
       * 也不要在开局那一屏——手机一连上就拉的整个消息窗口，恰好是全量最大的一笔——自走完整）。
       */
      transferTier: () => transferTierOf(this.kindWatch.kind),
    })

    transport.onStateChange((state) => {
      /*
       * 旧链路的迟到事件不得改新链路的状态。
       *
       * `dropLink` 正是「先关旧的、再开新的」，而关旧链路会同步回一个 `closed` —— 不挡住它，
       * 新链路刚摆好的「等待手机连接…」会被旧链路的遗言顶成「出错（链路已关闭）」。
       */
      if (this.transport !== transport) return
      if (state === 'open') {
        /*
         * ⚠️ 链路通 ≠ 手机已连上，**这里只到 `verifying`**。
         *
         * 真机反馈就是在这里出的错：被移除的那台手机重连上来、链路再次建好，界面于是显示
         * 「已连接」。而它手上那张票／凭证早已作废 —— 真正的「这是谁、准不准」只发生在 `hello` 里，
         * 所以这里只承认「有人接入了，正在验证」，等 `applyHelloOutcome` 出结论。
         */
        this.setLinkStatus('verifying')
        // 兜底：open 之后迟迟不握手（典型：被移除的旧客户端静默重连）→ 限期踢掉
        this.armHandshakeDeadline()
      } else if (state === 'connecting') {
        // 断了 / 等重连：巡检停、结论作废，别把上一次的「直连」糊在界面上
        this.kindWatch.stop()
        this.authorized = false
        this.clearHandshakeDeadline()
        /*
         * 链路不再 `open` = 那台手机此刻不连着 →「已连接」高亮跟着熄掉。
         *
         * ⚠️ 真机缺陷：手机**主动断开**时，RTC 链路回到的是 `connecting`（见 `rtc.ts` 的状态映射：
         * `disconnected` 与 `dc.onclose` 都映射到它），**不是** `closed`。旧实现只在 `closed` 分支
         * 清在线标记，于是「状态已是『等待手机连接…』、列表里那一行却还高亮着已连接」。
         */
        this.pairing.setActive(null)
        // 传 `''` 而不是省略：省略时 `setStatus` 会因为「状态没变」提前返回，
        // 上一条拒绝原因会赖在胶囊里（`''` 在界面上就是不显示括号）
        this.setLinkStatus('waiting', '')
      } else if (state === 'closed') {
        this.kindWatch.stop()
        this.authorized = false
        this.clearHandshakeDeadline()
        // 链路关了 = 那台手机不再连着 →「已连接」高亮跟着熄掉
        this.pairing.setActive(null)
        this.setLinkStatus('error', '链路已关闭')
      }
    })

    // ── 通讯层埋点：链路状态 / 传输错误 ──
    // 注意要在上面的状态回调**之外**独立挂：这里关心的是时序与缓冲量，不参与状态机
    this.enabledAt = Date.now()
    this.traces.push(instrumentTransport(transport))
    if (transport instanceof RtcTransport) {
      // `onError` 不在 `Transport` 接口上（内存 / Broadcast 实现没有），故按实现类型挂
      const offError = transport.onError((err) => traceLinkError(err, { source: 'transport' }))
      this.traces.push({ dispose: offError, flushStats: () => {} })
    }
    traceLinkEnable({
      roomHash: hashText(this.room),
      signalHost: urlHost(this.base),
      iceCount: (this.options.iceServers ?? []).length,
      iceSource: this.options.iceSource ?? 'none',
      mode: this.options.createTransport ? 'injected' : 'rtc',
    })

    void Promise.resolve(transport.start?.()).catch((err) => this.setStatus('error', String(err)))
    this.setLinkStatus('waiting')
  }

  /**
   * 拆掉「这一次连接」：接口层 / 端点 / 传输 / 埋点 / 在线标记 / 通讯类型。
   * **不**碰票据、状态机与 `enabledAt`（那些是「服务级」的，见 `disable`）。
   */
  private teardownLink(): void {
    const bridge = this.bridge
    const endpoint = this.endpoint
    const transport = this.transport
    /*
     * ⚠️ **先摘引用，再关链路**。
     *
     * `transport.close()` 会同步回调状态监听器（`closed`）。若此刻 `this.transport` 还是它，
     * 那条回调就会把「这条链路是我们自己关的」当成故障写进状态（`error` / 链路已关闭）——
     * 紧接着 `startLink()` 再把它盖回「等待」，白抖动一次、多发两次状态变更通知。
     * 摘掉引用后，`startLink` 里那道身份校验（`this.transport !== transport`）会直接滤掉旧链路的遗言。
     */
    this.bridge = null
    this.endpoint = null
    this.transport = null
    this.peerConnection = null
    for (const trace of this.traces) trace.dispose()
    this.traces = []
    bridge?.dispose()
    endpoint?.dispose()
    transport?.close()
    // 授权随链路一起消失：下一条链路要重新走 hello
    this.authorized = false
    // 链路都没了，谈不上「直连还是中继」（`stop` 内部会归零并广播 `unknown`）
    this.kindWatch.stop()
    this.clearHandshakeDeadline()
    // 停了就不该再有「哪台手机连着」的说法
    this.pairing.setActive(null)
  }

  /**
   * 一次 `hello` 的结论 → 状态 / 通讯类型。
   *
   * `ok` 是**授权事实**：只有它能让界面显示「已连接」、并开始问「直连还是中继」。
   * 被拒则是另一件事 —— 状态进 `rejected`（不是「继续等」），并把这条链路踢掉（见 `rejectPeer`）。
   */
  private applyHelloOutcome(outcome: HelloOutcome): void {
    // 握手已出结论：无论成败，兜底截止都不该再留着（成败各走各的收尾）
    this.clearHandshakeDeadline()
    // ⚠️ 用 `=== false` 而不是 `if (!outcome.ok)`：本工程 tsconfig 关了 `strictNullChecks`，
    //    真值判断**收窄不了**联合类型（同一约定见 `host-source.ts` 的 hello）
    if (outcome.ok === false) {
      this.authorized = false
      // 没授权的链路谈不上「直连 / 中继」；结论一并作废
      this.kindWatch.stop()
      this.rejectPeer(describeHelloReject(outcome.reason))
      return
    }
    // 有人真的通过了握手 → 上一条「已拒绝接入（…）」的结论到此为止，别再赖在胶囊里
    this.clearRejectNotice()
    this.authorized = true
    this.setStatus('connected')
    // 授权确认之后才问「直连还是过中继」（打洞完成前后可能从 relay 换成 direct）
    const pc = this.peerConnection
    if (pc) this.kindWatch.watch(pc)
  }

  /**
   * 握手被拒 → **直接拒绝**：状态立刻变成「已拒绝接入（原因）」，并把这条链路踢掉重开。
   *
   * 为什么连链路一起踢（而不是留着链路、只把它挡在 `host.*` 外面）：链路是**共享房间号**给的
   *（房间号由本机设备 key 派生，被移除的那台也算得出来），所以我们没法阻止它接进来；
   * 但「接进来之后还留着一条已建好的通道」就是我们自己的选择了。留着它的唯一效果，是让那台手机
   * 的界面继续显示「已连接」、只能在真正调用时报错 —— 用户看到的正是那个暧昧的就绪态。
   * 踢掉之后它的链路当场断开，它唯一回来的方式只剩「重新扫屏上那张新码 + 本机确认」。
   */
  private rejectPeer(reason: string): void {
    this.rejectReason = reason
    this.setStatus('rejected', reason)
    // 已经停用就没有链路可踢（迟到的 hello 只可能来自正在拆的链路）
    if (this.status === 'disabled') return
    if (this.kickTimer != null) return
    // 延迟踢链的唯一理由：让「你已被移除」那帧先发出去（见 `REJECT_KICK_DELAY_MS`）
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null
      this.dropLink('peer-rejected')
    }, REJECT_KICK_DELAY_MS)
  }

  /** 清掉「已拒绝接入」这条结论（成功握手 / 停用 / 重新启用时）。 */
  private clearRejectNotice(): void {
    this.rejectReason = null
    if (this.kickTimer == null) return
    clearTimeout(this.kickTimer)
    this.kickTimer = null
  }

  /**
   * 链路状态变化引起的那几个状态写入 —— 拒绝结论生效期间**一律不写**。
   *
   * 为什么需要这道闸：被拒的那台手机会一直重连，每次重连都带来 `open`（→「正在验证」）与
   * `connecting`（→「等待手机连接…」）两条事件。照写的话，用户看到的就是这两个状态来回闪，
   * 而真正的事实（这台手机已被拒绝）一秒后就被刷掉。真正的事实优先。
   */
  private setLinkStatus(status: PhoneControlStatus, detail?: string): void {
    if (this.rejectReason != null) return
    this.setStatus(status, detail)
  }

  /** 停用：断开链路并释放接口层。 */
  disable(): void {
    traceLinkDisable({ reason: 'disable', uptimeMs: this.enabledAt ? Date.now() - this.enabledAt : 0 })
    // 停用是「从头再来」：拒绝结论与待踢的定时器都到此为止（否则它们会打在重新启用后的新链路上）
    this.clearRejectNotice()
    this.teardownLink()
    this.enabledAt = 0
    this.setStatus('disabled')
  }

  private buildRtcTransport(): RtcTransport {
    const signaling: SignalingChannel = new SseSignalingClient({
      baseUrl: this.base,
      room: this.room,
      role: 'host',
      deviceKey: this.options.deviceKey,
      clientName: this.options.deviceName,
    })
    const transport = new RtcTransport({
      role: 'host',
      signaling,
      iceServers: this.options.iceServers ?? [],
      // 借这个注入口拿到本机 PC：判定「直连 / 中继」只能问 PC 的 stats，而 `RtcTransport`
      // 把 `pc` 藏成私有字段 —— 用共享包公开的缝，比摸私有字段稳（升级不会断）。
      createPeerConnection: (config) => this.createPeerConnection(config),
    })
    // ⚠️ 必须在 `RtcTransport` 构造**之后**挂信令埋点：它构造时已接管 `onPeer` / `onData`，
    //    `instrumentSignaling` 是链式包裹（保留原 handler），抢在前面挂会被它顶掉。
    this.traces.push(instrumentSignaling(signaling))
    return transport
  }

  /**
   * 建本机 PC，并**顺手盯住它**：所选 ICE 候选对决定「P2P 直连 / TURN 中继」。
   *
   * 为什么不直接读 `transport.pc`：那是私有字段（将来把 RTC 挪到 Rust 就更没有它），
   * 而 `createPeerConnection` 是共享包**公开**留给注入的缝 —— 同一个目的，代价小得多。
   */
  private createPeerConnection(config: RTCConfiguration): RTCPeerConnection {
    const Ctor = (globalThis as { RTCPeerConnection?: new (cfg: RTCConfiguration) => RTCPeerConnection })
      .RTCPeerConnection
    if (!Ctor) throw new Error('当前环境没有 RTCPeerConnection')
    const pc = new Ctor(config)
    this.peerConnection = pc
    // 用 `addEventListener` 而不是赋 `oniceconnectionstatechange`：赋值会被别的实现顶掉
    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState
      // ICE 状态变化是「即时复探」的机会（巡检是 3s 一跳）：变网重协商完成能立刻反映出来
      if (state === 'connected' || state === 'completed') void this.kindWatch.poll()
    })
    return pc
  }

  private setStatus(status: PhoneControlStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return
    this.status = status
    this.options.onStatusChange?.(status, detail)
  }
}

/**
 * 握手被拒 → 设置页那行小字（状态胶囊里跟在「等待手机连接…」后面的括号内容）。
 *
 * 刻意写短：它挤在胶囊里。四类是「这台手机已被移除 / 凭证或二维码过期 / 用户自己点了拒绝 /
 * 伪造的串」。
 *
 * 前缀「已拒绝接入」由状态胶囊给（`PhoneControlStatus.rejected`），这里只给原因。
 */
function describeHelloReject(reason: string): string {
  switch (reason) {
    case 'revoked':
      return '该手机已被移除'
    case 'expired':
      return '该手机凭证已过期'
    case 'denied':
      return '已拒绝本次配对'
    case 'ticket-expired':
      return '二维码已过期'
    default:
      return '该设备未获授权'
  }
}
