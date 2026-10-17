/**
 * 电脑端「手机控制」常驻服务（设置页二维码入口），host 角色发起 offer。
 *
 * 状态机：waiting → verifying（链路通但未 hello）→ connected；被拒 → rejected 并踢链；
 * error（链路已关闭）不是终点，LINK_CLOSED_RECOVER_MS 后原地重开。
 * SSE 可能静默死掉，另按 ROOM_PRESENCE_CHECK_MS 用 verifyRoomPresence 反查房间在线。
 */
import {
  Endpoint,
  PAIRING_TICKET_TTL_MS,
  RtcTransport,
  SseSignalingClient,
  buildPairingPayload,
  fetchRoomStatus,
  roomFor,
  type GrantRecord,
  type HostEmit,
  type IceServerInit,
  type PairingPayload,
  type SignalingChannel,
  type Transport,
} from 'virlen-remote'
import { hashText, urlHost } from '@/utils/telemetry'
import { AuditLog, type AuditPersist } from './audit'
import { createInteractionRegistry, wireInteractionSources } from './interaction-source'
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
 * 服务状态（设置页胶囊直接读）。verifying = 有人接入但未证明身份，rejected = 接入被拒。
 * 「还没人来」和「来了但不是」必须分开显示。
 */
export type PhoneControlStatus =
  | 'disabled'
  | 'waiting'
  | 'verifying'
  | 'connected'
  | 'rejected'
  | 'error'

/** 载荷定义在 virlen-remote（与手机端同一份），这里只重导出。 */
export type { PairingPayload }

export interface PhoneControlOptions {
  /** 信令基址，如 `https://virlen.cn/api/rtc/` */
  signalUrl: string
  deviceName: string
  /** 电脑设备 key（dk-…），必须持久化：房间号由它派生。 */
  deviceKey: string
  appVersion?: string
  /** ICE 服务器（调用方解析后传入，含 TURN 凭证）；不传只用本机候选，跨网多半连不上。 */
  iceServers?: IceServerInit[]
  /** ICE 来源（custom / remote / cache / stale-cache / none），只进埋点。 */
  iceSource?: string
  /** 首次绑定确认（桌面弹窗）；返回 false 则拒绝。生产必须传。 */
  confirmPair?: (ctx: { token: string; mobileName: string }) => Promise<boolean>
  /** 审计日志；传入则与设置页共用同一份，不传则内部新建（仅内存）。 */
  audit?: AuditLog
  /**
   * 复用调用方持有的交互注册表（改 ICE 会换服务实例，表须跨实例存活）。
   * 注入时推送出口由调用方接到当前实例的 emitToLink；本类只负责接线，生命周期 = 启用。
   */
  interactions?: InteractionRegistry
  /** 审计落盘（旁路）。Tauri 下接 Rust JSONL 追加。 */
  auditPersist?: AuditPersist
  /** 桌面侧提示（手机批准高风险操作时）。 */
  notify?: (text: string) => void
  /** 状态变化回调（UI 订阅）。 */
  onStatusChange?: (status: PhoneControlStatus, detail?: string) => void
  /** 通讯类型变化（P2P / 中继），与 onStatusChange 正交；断开 / 停用时给 unknown。 */
  onLinkKindChange?: (kind: LinkKind) => void
  /** 测试注入：按房间建传输（默认建 host 角色的 RtcTransport）。 */
  createTransport?: (room: string) => Transport
  /** 配对表落盘（Tauri 下写 `<data_dir>/phone-pairing.json`）；仅未注入 pairing 时生效。 */
  persistence?: PhonePairingPersistence
  /**
   * 复用调用方持有的配对表：未启用时服务不存在，但「已绑定的手机」仍要能显示。
   * 注入后落盘与变更通知归调用方，本类不碰 onChange。
   */
  pairing?: PairingStore
  /**
   * 房间在线自检（默认 POST /status，不占房间）。
   * true = 在房间里；false = 明确不在（手机此刻看到的就是「电脑不在线」）；
   * null = 问不到，不动作 —— 不凭一次没答上来就拆链路。
   */
  probeRoom?: (room: string) => Promise<boolean | null>
  /** 配对表变更回调；仅未注入 pairing 时生效。 */
  onPairingChange?: (snapshot: PairingSnapshot) => void
}

/** 配对表持久化端口。 */
export interface PhonePairingPersistence {
  load(): Promise<string | null>
  save(json: string): void
}

/* 凭证不能进源码：默认 ICE 一律由信令服务下发，不要在此写任何服务器地址或口令。 */

function normalizeBase(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** 被拒后延迟踢链（ms）：拒绝原因要沿这条链路回给手机，当场 close 会丢帧。 */
export const REJECT_KICK_DELAY_MS = 500

/**
 * 链路 open 后等 hello 的截止（ms）。取值 > 手机端 HELLO_TIMEOUT_MS（4s），
 * 只对「开了链路却不说话」的对端生效；收到 hello 请求即取消。
 */
export const HANDSHAKE_DEADLINE_MS = 8000

/**
 * 「链路已关闭」停留多久后原地重开（ms）。closed 是终态、那条 PC 会被下次协商复用，
 * 不重开就永远连不回来；留这个窗口是为了让对端自己的重连（回到 connecting）先跑。
 */
export const LINK_CLOSED_RECOVER_MS = 3000

/** 房间在线自检间隔（ms），对齐信令心跳；只在启用且没有手机连着时真去问。 */
export const ROOM_PRESENCE_CHECK_MS = 20_000

/** 问信令服务本房间是否还有 host；问不到返回 null。 */
async function defaultProbeRoom(base: string, room: string): Promise<boolean | null> {
  const list = await fetchRoomStatus({ baseUrl: base, rooms: [room] })
  const found = list.find((status) => status.room === room)
  if (!found || typeof found.hostOnline !== 'boolean') return null
  return found.hostOnline
}

export class PhoneControlService {
  /** 配对表；可由调用方注入，不注入时自建并自管落盘与变更通知。 */
  readonly pairing: PairingStore
  /** 是否自持配对表：决定 onChange 与启动恢复归谁管。 */
  private readonly ownsPairing: boolean

  private status: PhoneControlStatus = 'disabled'
  private ticket: string | null = null
  /** 当前票据的签发时刻（倒计时与到期重生成据此判定）。 */
  private ticketIssuedAt = 0
  private transport: Transport | null = null
  private endpoint: Endpoint | null = null
  private bridge: PhoneBridge | null = null
  private readonly base: string
  /** 通讯层埋点包装器，停用时一并拆掉。 */
  private traces: PhoneInstrument[] = []
  /** 本次启用的时刻（算 `phone.link.disable` 的 uptime）。 */
  private enabledAt = 0
  /** 本机 PC（RtcTransport 不暴露），每次重连都会重建。 */
  private peerConnection: RTCPeerConnection | null = null
  /** 是否已通过 hello（链路通只说明有人进了房间，不代表已授权）。 */
  private authorized = false
  /**
   * 最近一次拒绝原因。粘住到下次成功握手或停用：被拒手机会不停重连，
   * 若跟随链路事件写状态，用户只会看到「等待 → 验证 → 等待」闪烁。
   */
  private rejectReason: string | null = null
  /** 待执行的踢链（见 REJECT_KICK_DELAY_MS）；连续被拒只留一个。 */
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  /** 握手截止计时（见 HANDSHAKE_DEADLINE_MS）；收到 hello 即取消。 */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  /** 「链路已关闭」的自动复位计时（见 LINK_CLOSED_RECOVER_MS）。 */
  private recoverTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 本链路是否已报过 closed。closed 之后还会来拆链余音（connecting），
   * 只有 open 能抹掉此标记；停在 connecting 不算恢复。
   */
  private linkClosed = false
  /** 房间在线自检计时（见 ROOM_PRESENCE_CHECK_MS），生命周期 = 启用期间。 */
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  /** 自检请求是否在途（避免上一次没返回就又发一次）。 */
  private presenceBusy = false
  /** 通讯类型巡检器：候选对会随打洞 / 变网变化而 ICE 状态仍停在 completed。 */
  private readonly kindWatch = new LinkKindWatcher((kind) => this.onLinkKind(kind))

  /** 服务级审计（与交互注册表同一份）—— 见构造器里的说明。 */
  private readonly auditLog: AuditLog
  /** 解绑本机交互来源；非 null 即在挂，生命周期 = 启用。 */
  private detachInteractionSources: (() => void) | null = null

  constructor(private readonly options: PhoneControlOptions) {
    this.base = normalizeBase(options.signalUrl)
    this.ownsPairing = options.pairing == null
    this.pairing = options.pairing ?? new PairingStore()
    /*
     * 审计与交互注册表是服务级的，必须在 ownsPairing 的提前 return 之前建，且两者共用同一份。
     */
    this.auditLog = options.audit ?? new AuditLog(undefined, options.auditPersist)
    /*
     * 注册表优先用调用方注入的那份（跨服务实例存活），不注入时自建。
     * 构造时不接线：表存在 ≠ 有远端在等应答，接线随启用走。
     */
    this.interactions =
      options.interactions ??
      createInteractionRegistry({
        /* 推到当前链路；无链路时丢弃，待应答条目靠 host.interaction.list 快照补回。 */
        emit: (topic, payload) => {
          this.emitToLink(topic, payload)
        },
        audit: this.auditLog,
        notify: options.notify,
      })
    // 注入的配对表：落盘与变更通知归调用方
    if (!this.ownsPairing) return
    const persistence = options.persistence
    // 变更即落盘（fire-and-forget）并通知 UI
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
        // restore 是一次性覆盖、不发通知，这里补一次，否则 UI 一直是 0 台
        options.onPairingChange?.(this.pairing.snapshot())
      })
      .catch(() => {
        /* 坏数据 / 读取失败：保持空配对表 */
      })
  }

  getStatus(): PhoneControlStatus {
    return this.status
  }

  /** 当前链路的通讯类型：direct / relay / unknown。 */
  getLinkKind(): LinkKind {
    return this.kindWatch.kind
  }

  /**
   * 通讯类型变化 → 设置页；已确定时另发 host.event.connection.changed 给手机交叉校验。
   * unknown 不发 —— 不发猜测。
   */
  private onLinkKind(kind: LinkKind): void {
    this.options.onLinkKindChange?.(kind)
    if (kind !== 'direct' && kind !== 'relay') return
    // 无链路时 bridge 为 null，不发即正确行为
    this.bridge?.emit('host.event.connection.changed', { path: kind })
  }

  /** 链路 open 却迟迟不 hello → 到点踢掉（典型：被移除的旧客户端静默重连）。 */
  private armHandshakeDeadline(): void {
    this.clearHandshakeDeadline()
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      // 已授权 / 已停用都不踢
      if (this.authorized || this.status === 'disabled') return
      this.dropLink('handshake-timeout')
    }, HANDSHAKE_DEADLINE_MS)
  }

  /** 取消握手截止（收到 hello / 离开 open / 拆链 / 停用）。 */
  private clearHandshakeDeadline(): void {
    if (this.handshakeTimer == null) return
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  /**
   * 安排「链路已关闭」自愈：到点仍是同一条、未被授权且未换过的链路才拆掉重开。
   * 观察窗的作用是把「真死了」与「对端正在自己重连」分开。
   * evenWhenRejected：房间自检专用，「被拒」与「还在不在房间里」是两件事。
   */
  private armLinkRecovery(
    transport: Transport,
    reason: string = 'link-closed',
    options: { evenWhenRejected?: boolean } = {},
  ): void {
    const rejectBlocks = options.evenWhenRejected !== true
    this.clearLinkRecovery()
    if (rejectBlocks && this.rejectReason != null) return
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null
      if (this.transport !== transport) return
      if (this.isDisabled()) return
      if (rejectBlocks && this.rejectReason != null) return
      if (!this.linkClosed) return
      this.dropLink(reason)
    }, LINK_CLOSED_RECOVER_MS)
  }

  /** 取消链路自愈（拆链 / 停用）。 */
  private clearLinkRecovery(): void {
    if (this.recoverTimer == null) return
    clearTimeout(this.recoverTimer)
    this.recoverTimer = null
  }

  /** 开房间在线自检（幂等，生命周期 = 一条链路）。 */
  private startPresenceWatch(): void {
    if (this.presenceTimer) return
    this.presenceTimer = setInterval(() => {
      void this.verifyRoomPresence()
    }, ROOM_PRESENCE_CHECK_MS)
  }

  private stopPresenceWatch(): void {
    if (!this.presenceTimer) return
    clearInterval(this.presenceTimer)
    this.presenceTimer = null
    this.presenceBusy = false
  }

  /**
   * 写成方法而非就地比较：属性收窄会跨 await 残留，导致后续判断报 TS2367。
   */
  private isDisabled(): boolean {
    return this.status === 'disabled'
  }

  /**
   * 用信令服务的事实反查本机是否还在房间（SSE 可能静默死掉）。
   * 跳过：未启用 / 无链路 / 手机正连着 / 上一次未回。
   */
  async verifyRoomPresence(): Promise<void> {
    const transport = this.transport
    if (!transport || this.status === 'disabled' || this.authorized || this.presenceBusy) return
    this.presenceBusy = true
    const probe = this.options.probeRoom ?? ((room: string) => defaultProbeRoom(this.base, room))
    let present: boolean | null = null
    try {
      present = await probe(this.room)
    } catch {
      // 自检出错 = 问不到，与 null 同路，绝不据此拆链路
      present = null
    } finally {
      this.presenceBusy = false
    }
    if (present !== false) return
    // 请求在途期间链路可能被换 / 服务已停 / 手机刚连上，任一则不再插手
    if (this.transport !== transport || this.authorized || this.isDisabled()) return
    this.onRoomLost(transport)
  }

  /**
   * 本机已不在房间里 → 先如实报状态，再走与「链路已关闭」同一套观察窗 + 原地重开。
   * 拒绝结论生效期间也照排（二维码还在等别的手机，房间不在就扫了也连不上）。
   */
  private onRoomLost(transport: Transport): void {
    this.linkClosed = true
    this.setLinkStatus('error', '信令连接已断开')
    this.armLinkRecovery(transport, 'not-in-room', { evenWhenRejected: true })
  }

  /** 待应答交互注册表：服务级、跨链路存活，未启用时也可能有待应答条目。 */
  readonly interactions: InteractionRegistry

  /**
   * 推事件给当前链路（无链路 / 未握手则丢弃，保留出站闸门与埋点）。
   * 对外暴露：注册表的推送出口要指向当前那个服务实例。
   */
  emitToLink: HostEmit = (topic, payload) => {
    this.bridge?.emit(topic, payload)
  }

  /** 信令房间号，由设备 key 派生（与手机端同一份实现）。 */
  get room(): string {
    return roomFor(this.options.deviceKey)
  }

  /** 当前设备 key（手机端会记下它，下次不必扫码）。 */
  get deviceKey(): string {
    return this.options.deviceKey
  }

  /** 票据到期时刻（ms），设置页据此倒计时并自动重生成。 */
  get ticketDeadline(): number | null {
    return this.ticket ? this.ticketIssuedAt + PAIRING_TICKET_TTL_MS : null
  }

  /** 当前待用票据数（含即将过期的那张）。 */
  get pendingTickets(): number {
    return this.pairing.pendingTickets()
  }

  /** 当前配对载荷（二维码内容）；缓存票据失效会自动换新。 */
  pairingPayload(): PairingPayload {
    if (!this.ticket || !this.pairing.hasValidTicket(this.ticket)) this.issueTicket()
    return buildPairingPayload({
      host: this.options.deviceKey,
      name: this.options.deviceName,
      ticket: this.ticket as string,
      signal: this.base,
    })
  }

  /** 刷新二维码。旧票据不作废，只按 TTL 过期，避免作废在途扫码。 */
  refreshTicket(): PairingPayload {
    this.issueTicket()
    return this.pairingPayload()
  }

  private issueTicket(): void {
    this.ticket = this.pairing.issueTicket()
    this.ticketIssuedAt = Date.now()
  }

  /**
   * 票据不可用时重新生成：未生成 / 过 TTL / 已被扫走。只查 TTL 不够 ——
   * 兑换发生在用户点「允许」之后，早于那次兑换的刷新会错过消费。
   */
  rotateTicketIfStale(now: number = Date.now()): boolean {
    if (this.ticket && this.pairing.hasValidTicket(this.ticket, now)) return false
    this.issueTicket()
    return true
  }

  /** 启用：常驻信令房间并挂上接口层，幂等。 */
  enable(): void {
    if (this.status !== 'disabled' && this.status !== 'error') return
    // 重新启用 = 从头开始，不继承上一条链路的拒绝结论
    this.clearRejectNotice()
    if (!this.ticket) this.issueTicket()
    // 每次启用都用新票；旧票据靠 TTL 自然失效，不断在途扫码
    this.rotateTicketIfStale()
    // 先接线再开链路
    this.attachInteractions()
    this.startLink()
  }

  /** 挂上本机交互来源（提问 / 授权 / 终端确认 → 注册表），同表只接一次。 */
  private attachInteractions(): void {
    if (this.detachInteractionSources) return
    this.detachInteractionSources = wireInteractionSources(this.interactions)
  }

  /** 解绑本机交互来源。表里的条目不清：它们代表电脑侧仍在等的交互。 */
  private detachInteractions(): void {
    this.detachInteractionSources?.()
    this.detachInteractionSources = null
  }

  /** 断开当前连接并原地重开：服务保持启用、二维码与票据不变。用于移除在线手机。 */
  dropLink(reason: string = 'peer-revoked'): void {
    if (this.status === 'disabled') return
    traceLinkDisable({ reason, uptimeMs: this.enabledAt ? Date.now() - this.enabledAt : 0 })
    this.teardownLink()
    this.startLink()
  }

  /** 建一条链路（传输 + 接口层 + 埋点）并开始等对端。 */
  private startLink(): void {
    const transport =
      this.options.createTransport?.(this.room) ??
      (this.buildRtcTransport() as unknown as Transport)
    this.transport = transport
    this.endpoint = new Endpoint({ transport, defaultTimeoutMs: 15_000 })
    // 新链路从「未授权」起算，并清掉上一条链路的「已关闭」标记
    this.authorized = false
    this.linkClosed = false
    this.bridge = startPhoneBridge(this.endpoint, {
      deviceName: this.options.deviceName,
      deviceId: this.options.deviceKey,
      appVersion: this.options.appVersion,
      pairing: this.pairing,
      confirmPair: this.options.confirmPair,
      // 服务级审计与注册表，不随链路销毁
      audit: this.auditLog,
      auditPersist: this.options.auditPersist,
      interactions: this.interactions,
      notify: this.options.notify,
      // 必须开：房间号由设备 key 派生，无法把手机踢出房间，只有授权闸门能让「移除」生效
      requireAuthorization: true,
      onHelloResult: (outcome) => this.applyHelloOutcome(outcome),
      // 收到 hello 即取消兜底截止（早于确认弹窗的 await）
      onHelloReceived: () => this.clearHandshakeDeadline(),
      /* 传输档位：直连发完整，中继 / 未知发精简。口径读共享包，手机上同一份。 */
      transferTier: () => transferTierOf(this.kindWatch.kind),
      /* 文件传输门槛：确认走 TURN 中继才拒（口径与 transferTier 有意不同，unknown 放行）。 */
      linkKind: () => this.kindWatch.kind,
    })

    transport.onStateChange((state) => {
      // 旧链路的迟到事件不得改新链路状态（dropLink 先关旧再开新）
      if (this.transport !== transport) return
      if (state === 'open') {
        // 链路通 ≠ 已授权，只到 verifying，等 hello 出结论
        this.setLinkStatus('verifying')
        // open 会重新握手，closed 标记到此为止
        this.linkClosed = false
        // 兜底：open 后迟迟不握手就限期踢掉
        this.armHandshakeDeadline()
      } else if (state === 'connecting') {
        // 断了 / 等重连：停巡检、作废授权
        this.kindWatch.stop()
        this.authorized = false
        this.clearHandshakeDeadline()
        // 不再 open = 手机此刻不连着，清在线高亮（主动断开也走 connecting）
        this.pairing.setActive(null)
        // closed 之后的 connecting 多半是拆链余音，不许写回「等待」，交给已排的重开处理
        if (this.linkClosed) return
        // 传 '' 而非省略：省略时 setStatus 因状态未变提前返回，旧拒绝原因会留在胶囊里
        this.setLinkStatus('waiting', '')
      } else if (state === 'closed') {
        this.kindWatch.stop()
        this.authorized = false
        this.clearHandshakeDeadline()
        // 链路关了 = 手机不再连着
        this.pairing.setActive(null)
        this.linkClosed = true
        this.setLinkStatus('error', '链路已关闭')
        // closed 是终态且 PC 会被下次协商复用，不重开就永远连不回来
        this.armLinkRecovery(transport)
      }
    })

    // 通讯层埋点：独立于状态机，关心时序与缓冲量
    this.enabledAt = Date.now()
    this.traces.push(instrumentTransport(transport))
    if (transport instanceof RtcTransport) {
      // onError 不在 Transport 接口上，按实现类型挂
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
    // 开始反查信令服务是否还认得本机
    this.startPresenceWatch()
  }

  /** 拆掉这一次连接，不碰票据 / 状态机 / enabledAt（那些是服务级的）。 */
  private teardownLink(): void {
    const bridge = this.bridge
    const endpoint = this.endpoint
    const transport = this.transport
    // 先摘引用再关链路：close 会同步回调 closed，否则会被当成故障写进状态
    this.bridge = null
    this.endpoint = null
    this.transport = null
    this.peerConnection = null
    for (const trace of this.traces) trace.dispose()
    this.traces = []
    bridge?.dispose()
    endpoint?.dispose()
    transport?.close()
    // 下一条链路要重新走 hello
    this.authorized = false
    // 新链路从 linkClosed = false 起算
    this.linkClosed = false
    // stop 内部会归零并广播 unknown
    this.kindWatch.stop()
    this.clearHandshakeDeadline()
    // 自愈即将发生，旧定时器不能再来拆新链路
    this.clearLinkRecovery()
    // 房间自检随链路走，否则会在换代空隙里拿旧链路问话
    this.stopPresenceWatch()
    // 停了就不该再有「哪台手机连着」的说法
    this.pairing.setActive(null)
  }

  /** 一次 hello 的结论 → 状态 / 通讯类型。 */
  private applyHelloOutcome(outcome: HelloOutcome): void {
    // 握手已出结论，兜底截止不再需要
    this.clearHandshakeDeadline()
    // 用 === false：tsconfig 关了 strictNullChecks，真值判断收窄不了联合类型
    if (outcome.ok === false) {
      this.authorized = false
      // 未授权就谈不上直连 / 中继
      this.kindWatch.stop()
      this.rejectPeer(describeHelloReject(outcome.reason))
      return
    }
    // 成功握手 → 清掉上一条拒绝结论
    this.clearRejectNotice()
    this.authorized = true
    this.setStatus('connected')
    // 授权后才问直连 / 中继（打洞完成前可能是 relay）
    const pc = this.peerConnection
    if (pc) this.kindWatch.watch(pc)
  }

  /** 握手被拒 → 进 rejected 并踢链。留着通道只会让手机显示「已连接」却在调用时报错。 */
  private rejectPeer(reason: string): void {
    this.rejectReason = reason
    this.setStatus('rejected', reason)
    // 已停用就没有链路可踢
    if (this.status === 'disabled') return
    if (this.kickTimer != null) return
    // 延迟只为让「你已被移除」那帧先发出去
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null
      this.dropLink('peer-rejected')
    }, REJECT_KICK_DELAY_MS)
  }

  /** 清掉拒绝结论（成功握手 / 停用 / 重新启用）。 */
  private clearRejectNotice(): void {
    this.rejectReason = null
    if (this.kickTimer == null) return
    clearTimeout(this.kickTimer)
    this.kickTimer = null
  }

  /** 链路事件引起的状态写入；拒绝结论生效期间一律不写，否则会被重连事件刷掉。 */
  private setLinkStatus(status: PhoneControlStatus, detail?: string): void {
    if (this.rejectReason != null) return
    this.setStatus(status, detail)
  }

  /** 停用：断链并解绑本机交互来源。 */
  disable(): void {
    traceLinkDisable({ reason: 'disable', uptimeMs: this.enabledAt ? Date.now() - this.enabledAt : 0 })
    // 远端下线，解绑本机交互来源，否则关闭期间仍在登记 + 上报
    this.detachInteractions()
    // 拒绝结论与待踢定时器到此为止，否则会打在重新启用后的新链路上
    this.clearRejectNotice()
    this.teardownLink()
    this.enabledAt = 0
    this.setStatus('disabled')
  }

  /** 释放服务级资源。等同于 disable()；注入的配对表 / 审计 / 注册表归调用方，不动。 */
  dispose(): void {
    this.disable()
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
      // 公开的注入口：判定直连 / 中继要问 PC 的 stats，不去摸私有字段
      createPeerConnection: (config) => this.createPeerConnection(config),
    })
    // 必须构造之后再挂：它构造时已接管 onPeer / onData，instrumentSignaling 是链式包裹
    this.traces.push(instrumentSignaling(signaling))
    return transport
  }

  /** 建本机 PC 并盯住它：候选对决定直连还是中继。 */
  private createPeerConnection(config: RTCConfiguration): RTCPeerConnection {
    const Ctor = (globalThis as { RTCPeerConnection?: new (cfg: RTCConfiguration) => RTCPeerConnection })
      .RTCPeerConnection
    if (!Ctor) throw new Error('当前环境没有 RTCPeerConnection')
    const pc = new Ctor(config)
    this.peerConnection = pc
    // 用 addEventListener 而非赋值：赋值会被别的实现顶掉
    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState
      // ICE 一变就即时复探（巡检是 3s 一跳）
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

/** 拒绝原因 → 胶囊里的短文案（前缀「已拒绝接入」由状态胶囊给）。 */
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
