/**
 * phoneControlStore — 「手机控制」设置页的状态与**单例服务持有者**。
 *
 * 持有 `PhoneControlService`（常驻信令房间 + host 接口层），并把「首次绑定确认」
 * 桥接为 UI 交互：`confirmPair` 挂起一个 Promise，同时弹出设置页让用户点「允许/拒绝」。
 *
 * M6 起还有两件事（见 docs/phone-control-bridge.md §30.2）：
 *  - **设备身份**：首次运行生成并持久化（`loadHostIdentity`），之后永远是同一个 key；
 *  - **二维码自动轮换**：切进本菜单即换新码 + 到期前 1 秒级倒计时 + 到期瞬间自动重生成 ——
 *    用户反馈的「扫码后提示二维码失效」就此消掉（不再依赖用户手点「刷新二维码」）。
 *
 * 不并入 `ui/store/index` barrel —— 它 import `@/bridge`，而 `@/bridge` 又依赖 `@/ui/store`，
 * 走 barrel 会形成环。按具体路径引用即可。
 */
import { action, computed, makeObservable, observable, runInAction } from 'mobx'
import { invoke } from '@tauri-apps/api/core'
import {
  ICE_CUSTOM_STORAGE_KEY,
  readCustomIceText,
  resolveIceServers,
  writeCustomIceText,
  type IceServerInit,
  type IceSource,
  type IceStoragePort,
} from 'virlen-remote'
import {
  AuditLog,
  PhoneControlService,
  type AuditEntry,
  type PairedDevice,
  type PairingPayload,
  type PhoneControlStatus,
  type PhonePairingPersistence,
} from '@/bridge'
import { loadHostIdentity, type HostIdentity, type IdentityPersistence } from '@/bridge/device-identity'
import { showToast } from '@/ui/components/shared/Toast'
import settingsEvent from '@/events/settingsEvent'

interface PendingPair {
  token: string
  deviceName: string
  resolve: (ok: boolean) => void
}

const SIGNAL_STORAGE_KEY = 'virlen.phone.signal'
const DEFAULT_SIGNAL_URL = 'https://virlen.cn/api/rtc/'
const DEVICE_NAME = 'Virlen 电脑'

/**
 * ICE 自定义配置的存储端口。
 *
 * 用 localStorage 而不是 Tauri 文件：与同页的 `virlen.phone.signal` 同口径（都是「本机偏好」），
 * 且共享包的 `resolveIceServers()` 就要一个 `IceStoragePort`。清掉应用数据会丢自定义 → 回服务端默认，
 * 不丢功能。
 */
function iceStorage(): IceStoragePort | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function readSignalUrl(): string {
  return readStorage(SIGNAL_STORAGE_KEY) || DEFAULT_SIGNAL_URL
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Tauri 环境：把配对表落盘到 `<data_dir>/phone-pairing.json`（Rust 命令）。 */
function buildPersistence(): PhonePairingPersistence | undefined {
  if (!inTauri()) return undefined
  return {
    load: () => invoke<string>('cmd_phone_pairing_load'),
    save: (json: string) => {
      void invoke('cmd_phone_pairing_save', { json }).catch(() => {
        /* 落盘失败不影响本次会话 */
      })
    },
  }
}

/** Tauri 环境：把设备身份落盘到 `<data_dir>/phone-identity.json`（Rust 命令）。 */
function buildIdentityPersistence(): IdentityPersistence | undefined {
  if (!inTauri()) return undefined
  return {
    load: () => invoke<string>('cmd_phone_identity_load'),
    save: (json: string) => {
      void invoke('cmd_phone_identity_save', { json }).catch(() => {
        /* 落盘失败：本次会话内仍用内存里的 key，下次再写 */
      })
    },
  }
}

/** 设置页「操作记录」保留的条数上限（再多也没人看，且要控渲染成本）。 */
const AUDIT_VIEW_LIMIT = 100
/** 二维码倒计时刷新间隔（毫秒）—— 只驱动一个文本，1 秒足够且不肉。 */
const TICKET_TICK_MS = 1000

/** 合并视图去重键（磁盘历史与内存条目的同一事件只出现一次）。 */
function auditKey(e: AuditEntry): string {
  return `${e.at}|${e.method}|${e.interactionId ?? ''}|${e.detail ?? ''}|${e.allowed ? 1 : 0}`
}

class PhoneControlStore {
  enabled = false
  status: PhoneControlStatus = 'disabled'
  payload: PairingPayload | null = null
  devices: PairedDevice[] = []
  pendingPair: PendingPair | null = null
  error: string | null = null
  /** 本机设备身份（异步就绪；就绪前不允许启用服务，否则会用一个临时 key 建房间）。 */
  identity: HostIdentity | null = null
  /**
   * 本次连接实际使用的 ICE 服务器（`自定义 > 服务端下发 > 缓存 > 空`）。
   * 解析逻辑在共享包 `resolveIceServers()`（与手机端同一份，见 §31）。
   */
  iceServers: IceServerInit[] = []
  /** ICE 来源（设置页文案 + 埋点 `ice_source`）。 */
  iceSource: IceSource = 'none'
  /** 来源的中文描述（由共享包给出，避免两端各说各话）。 */
  iceDetail = '尚未解析'
  /** 降级 / 异常时的补充说明（如「信令服务暂不可达」）。 */
  iceWarning: string | null = null
  /** 自定义配置写了但非法时的原因（标红提示，**不阻断**连接）。 */
  iceCustomError: string | null = null
  /** ICE 配置文本框的内容（展开折叠区时回填）。 */
  iceText = ''
  iceLoading = false
  /** 是否已解析过 ICE（首次启用时解析一次；之后只在用户改动 / 手动刷新时重解析）。 */
  private iceResolved = false
  /** 当前二维码剩余秒数（`null` = 未生成）。到期那一刻自动换新码。 */
  ticketLeftSec: number | null = null
  /** 本次会话发生的审计条目（倒序，最新在前）—— 浏览器 harness 下它就是唯一读取面。 */
  liveEntries: AuditEntry[] = []
  /** 从磁盘读回的历史审计（倒序）—— 仅 Tauri。 */
  diskEntries: AuditEntry[] = []
  auditLoaded = false

  /** 审计日志（与 bridge **同一实例**，否则设置页读不到 bridge 写下的记录）。 */
  readonly audit: AuditLog

  private service: PhoneControlService | null = null
  private ticketTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.audit = new AuditLog(undefined, (entry) => this.onAudit(entry))
    makeObservable(this, {
      enabled: observable,
      status: observable,
      payload: observable.ref,
      devices: observable,
      pendingPair: observable.ref,
      error: observable,
      identity: observable.ref,
      ticketLeftSec: observable,
      iceServers: observable.ref,
      iceSource: observable,
      iceDetail: observable,
      iceWarning: observable,
      iceCustomError: observable,
      iceText: observable,
      iceLoading: observable,
      liveEntries: observable,
      diskEntries: observable,
      auditLoaded: observable,
      auditView: computed,
      setEnabled: action,
      onPanelOpen: action,
      refreshTicket: action,
      answerPair: action,
      revokeDevice: action,
      loadAuditHistory: action,
      clearAudit: action,
      loadIceText: action,
      setIceText: action,
      saveIceConfig: action,
      resetIceConfig: action,
      refreshIce: action,
    })
    void this.initIdentity()
  }

  /** 设备 key 必须在**任何**房间/二维码之前就绪 —— 它是房间号的来源。 */
  private async initIdentity(): Promise<void> {
    const identity = await loadHostIdentity(buildIdentityPersistence())
    runInAction(() => {
      this.identity = identity
    })
  }

  /** 审计写入时更新内存镜像 + 旁路落盘（写盘失败只影响「重启后可回溯」）。 */
  private onAudit(entry: AuditEntry): void {
    runInAction(() => {
      this.liveEntries = [entry, ...this.liveEntries].slice(0, AUDIT_VIEW_LIMIT)
    })
    if (!inTauri()) return
    void invoke('cmd_phone_audit_append', { line: JSON.stringify(entry) }).catch(() => {
      /* 旁路：不打断功能 */
    })
  }

  /** 合并视图（内存 + 磁盘，去重、倒序、限长）—— 设置页直接读它。 */
  get auditView(): AuditEntry[] {
    const seen = new Set<string>()
    const out: AuditEntry[] = []
    for (const e of [...this.liveEntries, ...this.diskEntries]) {
      const key = auditKey(e)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
    }
    return out.sort((a, b) => b.at - a.at).slice(0, AUDIT_VIEW_LIMIT)
  }

  /** 读回磁盘历史（设置页打开时调一次即可）。浏览器 harness 下是空操作。 */
  async loadAuditHistory(): Promise<void> {
    if (!inTauri() || this.auditLoaded) return
    try {
      const lines = await invoke<string[]>('cmd_phone_audit_list', { limit: AUDIT_VIEW_LIMIT })
      const parsed: AuditEntry[] = []
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as AuditEntry)
        } catch {
          /* 单行损坏不影响其它条目 */
        }
      }
      runInAction(() => {
        this.diskEntries = parsed
        this.auditLoaded = true
      })
    } catch {
      /* 读不回不影响本次会话（内存镜像仍在） */
    }
  }

  /** 清空操作记录（磁盘 + 内存）。 */
  async clearAudit(): Promise<void> {
    this.audit.clear()
    runInAction(() => {
      this.liveEntries = []
      this.diskEntries = []
    })
    if (!inTauri()) return
    try {
      await invoke('cmd_phone_audit_clear')
    } catch (err) {
      runInAction(() => {
        this.error = `清空操作记录失败：${String(err)}`
      })
    }
  }

  setEnabled(next: boolean): void {
    if (next === this.enabled) return
    if (next) {
      void this.enableAsync()
    } else {
      this.service?.disable()
      this.stopTicketTimer()
      this.enabled = false
      this.status = 'disabled'
      this.payload = null
      this.ticketLeftSec = null
      this.error = null
    }
  }

  private async enableAsync(): Promise<void> {
    if (!this.identity) await this.initIdentity()
    // ICE 默认值要在建链路**之前**拿到（`RTCPeerConnection` 构造后就改不了）；
    // 解析过一次就不再每次都问服务端（缓存策略在共享包里，见 §31）
    if (!this.iceResolved) await this.resolveIce()
    const service = this.ensureService()
    if (!service) return
    runInAction(() => {
      service.enable()
      this.enabled = true
      this.sync()
      this.startTicketTimer()
    })
  }

  /* ------------------------------ ICE（§31） ------------------------------ */

  /**
   * 解析本次要用的 ICE（`自定义 > 服务端下发 > 缓存 > 空`）。
   *
   * 永不抛错：拿不到配置就退化成「仅本机候选」，而不是让「启用手机控制」失败；
   * 但来源与降级原因会**如实**写进状态（设置页可见 + 埋点 `ice_source`）。
   */
  async resolveIce(): Promise<void> {
    runInAction(() => {
      this.iceLoading = true
    })
    const next = await resolveIceServers({
      baseUrl: readSignalUrl(),
      customText: readStorage(ICE_CUSTOM_STORAGE_KEY),
      storage: iceStorage(),
    })
    runInAction(() => {
      this.iceServers = next.servers
      this.iceSource = next.source
      this.iceDetail = next.detail
      this.iceWarning = next.warning ?? null
      this.iceCustomError = next.customError ?? null
      this.iceLoading = false
      this.iceResolved = true
    })
  }

  /** 展开「ICE 服务器」折叠区时回填文本框（坏数据按「没填」处理，不让用户看到乱码）。 */
  loadIceText(): void {
    this.iceText = readCustomIceText(iceStorage())
  }

  setIceText(text: string): void {
    this.iceText = text
  }

  /**
   * 保存自定义 ICE（留空 = 恢复服务端默认）。
   *
   * 先校验再落盘：错误在保存那一刻暴露，而不是等某次真机连接失败才发现少了个引号。
   */
  async saveIceConfig(): Promise<boolean> {
    const result = writeCustomIceText(iceStorage(), this.iceText)
    // ⚠️ `=== false` 而非 `!result.ok`：本 tsconfig 关了 strictNullChecks，真值判断不收敛联合类型
    if (result.ok === false) {
      runInAction(() => {
        this.iceCustomError = result.error
      })
      return false
    }
    runInAction(() => {
      this.iceText = readCustomIceText(iceStorage())
      this.iceCustomError = null
    })
    await this.applyIceChange()
    return true
  }

  /** 恢复服务端默认（清掉本机自定义）。 */
  async resetIceConfig(): Promise<void> {
    writeCustomIceText(iceStorage(), '')
    runInAction(() => {
      this.iceText = ''
      this.iceCustomError = null
    })
    await this.applyIceChange()
  }

  /** 重新解析一次（用户点「重新获取」/ 排查连通性时用）。 */
  async refreshIce(): Promise<void> {
    await this.applyIceChange()
  }

  private async applyIceChange(): Promise<void> {
    await this.resolveIce()
    if (this.enabled) this.rebuildService()
  }

  /**
   * 换 ICE = 必须重建链路。
   *
   * `RTCPeerConnection` 的 `iceServers` 只在构造时生效（改不了），而链路的生命周期归
   * `PhoneControlService` 管 —— 做法就是「停掉旧服务 + 丢引用 + 重新启用」。
   * 副作用：二维码会换一张（与「重新启用」同一语义，用户看得见）。
   */
  private rebuildService(): void {
    this.service?.disable()
    this.service = null
    void this.enableAsync()
  }

  /**
   * 设置页打开时调用：**换一张新码**并开始倒计时。
   *
   * 用户拍板的做法（2026-09-27）：每次切到「手机控制」菜单就重新生成一遍二维码 ——
   * 面板上那张码可能已经放了几分钟，而用户此刻才举起手机去扫。
   */
  onPanelOpen(): void {
    if (!this.enabled) return
    const service = this.service
    if (!service) return
    this.payload = service.refreshTicket()
    this.ticketLeftSec = remainingSec(service.ticketDeadline)
    this.startTicketTimer()
  }

  refreshTicket(): void {
    const service = this.service
    if (!service) return
    this.payload = service.refreshTicket()
    this.ticketLeftSec = remainingSec(service.ticketDeadline)
  }

  answerPair(ok: boolean): void {
    const pending = this.pendingPair
    this.pendingPair = null
    pending?.resolve(ok)
    this.sync()
  }

  revokeDevice(deviceId: string): void {
    this.service?.pairing.revoke(deviceId)
    this.sync()
  }

  /** 二维码倒计时（1 秒一跳）；到期那一刻**立刻换新码**，屏幕上永远是可用的。 */
  private startTicketTimer(): void {
    if (this.ticketTimer) return
    this.ticketTimer = setInterval(() => this.tickTicket(), TICKET_TICK_MS)
    this.tickTicket()
  }

  private stopTicketTimer(): void {
    if (!this.ticketTimer) return
    clearInterval(this.ticketTimer)
    this.ticketTimer = null
  }

  private tickTicket(): void {
    const service = this.service
    if (!service || !this.enabled) {
      this.stopTicketTimer()
      return
    }
    const rotated = service.rotateTicketIfExpired()
    runInAction(() => {
      if (rotated) this.payload = service.pairingPayload()
      this.ticketLeftSec = remainingSec(service.ticketDeadline)
    })
  }

  private ensureService(): PhoneControlService | null {
    if (this.service) return this.service
    const identity = this.identity
    if (!identity) return null
    const service = new PhoneControlService({
      signalUrl: readSignalUrl(),
      deviceName: DEVICE_NAME,
      deviceKey: identity.deviceKey,
      // ICE 由本 store 解析后传入（默认值来自信令服务下发；源码里不再有任何 TURN 凭证）
      iceServers: this.iceServers,
      iceSource: this.iceSource,
      persistence: buildPersistence(),
      // 与设置页共用同一份审计（否则「操作记录」看不到 bridge 写下的条目）
      audit: this.audit,
      // 手机批准高风险操作时提醒电脑前的人（§16.3-2）
      notify: (text) => showToast(text, 6000),
      confirmPair: (ctx) =>
        new Promise<boolean>((resolve) => {
          runInAction(() => {
            this.pendingPair = { token: ctx.token, deviceName: ctx.deviceName, resolve }
          })
          // 弹设置页「手机控制」，让用户当面确认
          settingsEvent.emit('openSettings', 'phone-control')
        }),
      onStatusChange: (status, detail) => {
        runInAction(() => {
          this.status = status
          this.error = detail ?? null
        })
      },
    })
    this.service = service
    return service
  }

  private sync(): void {
    const service = this.service
    if (!service) return
    runInAction(() => {
      this.payload = service.pairingPayload()
      this.devices = service.pairing.list()
    })
  }
}

/** 剩余秒数（`null` = 没有票据）。 */
function remainingSec(deadline: number | null, now: number = Date.now()): number | null {
  if (deadline == null) return null
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export const phoneControlStore = new PhoneControlStore()
