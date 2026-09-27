/**
 * 电脑端「手机控制」服务 —— 设置页 QR 入口背后的常驻服务。
 *
 * 职责：启用后**常驻信令房间**（角色 host），等手机扫码加入 → 建 RTC 链路 →
 * 挂上 `startPhoneBridge`（复用 M2 的 host.* 接口层 / ACL / 审计 / store 推送）。
 *
 * 角色（§8 拍板）：**电脑发起 offer**；手机加入后由电脑发 offer。
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
import { PairingStore, type PairingSnapshot } from './pairing'
import { startPhoneBridge, type PhoneBridge } from './index'
import {
  instrumentSignaling,
  instrumentTransport,
  traceLinkDisable,
  traceLinkEnable,
  traceLinkError,
  type PhoneInstrument,
} from './telemetry'

export type PhoneControlStatus = 'disabled' | 'waiting' | 'connected' | 'error'

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
  /** 测试注入：按房间建传输（默认建 host 角色的 RtcTransport）。 */
  createTransport?: (room: string) => Transport
  /**
   * 配对表持久化（M3-5：Tauri 下由 Rust 命令写 `<data_dir>/phone-pairing.json`）。
   * 不传则仅内存保存（浏览器 harness / 单测）。
   */
  persistence?: PhonePairingPersistence
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

export class PhoneControlService {
  /** 配对表（票据 / 已绑定设备）。M3-5 将持久化到 Rust。 */
  readonly pairing = new PairingStore()

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

  constructor(private readonly options: PhoneControlOptions) {
    this.base = normalizeBase(options.signalUrl)
    const persistence = options.persistence
    if (persistence) {
      // 变更即落盘（fire-and-forget）；启动时恢复
      this.pairing.onChange = (snap: PairingSnapshot) => persistence.save(JSON.stringify(snap))
      void persistence
        .load()
        .then((raw) => {
          if (!raw) return
          this.pairing.restore(JSON.parse(raw) as PairingSnapshot)
        })
        .catch(() => {
          /* 坏数据 / 读取失败：保持空配对表 */
        })
    }
  }

  getStatus(): PhoneControlStatus {
    return this.status
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
   * 票据到期时重新生成（设置页倒计时归零时调）。
   * @returns 是否真的换了新票
   */
  rotateTicketIfExpired(now: number = Date.now()): boolean {
    if (this.ticket && now < this.ticketIssuedAt + PAIRING_TICKET_TTL_MS) return false
    this.issueTicket()
    return true
  }

  /** 启用：常驻信令房间并挂上接口层。重复调用无副作用。 */
  enable(): void {
    if (this.status !== 'disabled' && this.status !== 'error') return
    if (!this.ticket) this.issueTicket()
    // 每次启用（含重新启用）都用新票：旧票据靠 TTL 自然失效，不断别人的在途扫码
    this.rotateTicketIfExpired()

    const transport =
      this.options.createTransport?.(this.room) ??
      (this.buildRtcTransport() as unknown as Transport)
    this.transport = transport
    this.endpoint = new Endpoint({ transport, defaultTimeoutMs: 15_000 })
    this.bridge = startPhoneBridge(this.endpoint, {
      deviceName: this.options.deviceName,
      deviceId: this.options.deviceKey,
      appVersion: this.options.appVersion,
      pairing: this.pairing,
      confirmPair: this.options.confirmPair,
      audit: this.options.audit,
      auditPersist: this.options.auditPersist,
      notify: this.options.notify,
    })

    transport.onStateChange((state) => {
      if (state === 'open') this.setStatus('connected')
      else if (state === 'connecting') this.setStatus('waiting')
      else if (state === 'closed') this.setStatus('error', '链路已关闭')
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
    this.setStatus('waiting')
  }

  /** 停用：断开链路并释放接口层。 */
  disable(): void {
    traceLinkDisable({ reason: 'disable', uptimeMs: this.enabledAt ? Date.now() - this.enabledAt : 0 })
    for (const trace of this.traces) trace.dispose()
    this.traces = []
    this.bridge?.dispose()
    this.endpoint?.dispose()
    this.transport?.close()
    this.bridge = null
    this.endpoint = null
    this.transport = null
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
    })
    // ⚠️ 必须在 `RtcTransport` 构造**之后**挂信令埋点：它构造时已接管 `onPeer` / `onData`，
    //    `instrumentSignaling` 是链式包裹（保留原 handler），抢在前面挂会被它顶掉。
    this.traces.push(instrumentSignaling(signaling))
    return transport
  }

  private setStatus(status: PhoneControlStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return
    this.status = status
    this.options.onStatusChange?.(status, detail)
  }
}
