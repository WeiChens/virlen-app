/**
 * 「手机控制」设置页的状态 + 单例服务持有者。
 * 配对表 / 审计 / 交互表三份跨服务实例的对象都归本 store（改 ICE 会重建服务，放服务里会连表一起丢）。
 * 配对变更由本 store 订阅并落盘 + 刷新列表。
 *
 * 不并入 ui/store barrel：它 import @/bridge，@/bridge 又依赖 @/ui/store，会成环。
 */
import { action, computed, makeObservable, observable, runInAction } from 'mobx'
import { invoke } from '@tauri-apps/api/core'
import {
  ICE_CUSTOM_STORAGE_KEY,
  readCustomIceText,
  resolveIceServers,
  writeCustomIceText,
  type HostEmit,
  type IceServerInit,
  type IceSource,
  type IceStoragePort,
  type Transport,
} from 'virlen-remote'
import {
  AuditLog,
  PairingStore,
  PhoneControlService,
  createInteractionRegistry,
  type AuditEntry,
  type InteractionRegistry,
  type LinkKind,
  type PairedDevice,
  type PairingPayload,
  type PairingSnapshot,
  type PhoneControlStatus,
  type PhonePairingPersistence,
} from '@/bridge'
import { loadHostIdentity, type HostIdentity, type IdentityPersistence } from '@/bridge/device-identity'
import { showToast } from '@/ui/components/shared/Toast'
import settingsEvent from '@/events/settingsEvent'

interface PendingPair {
  token: string
  /** 请求方（手机）的名字（已归一）；不是本机名。 */
  mobileName: string
  resolve: (ok: boolean) => void
}

const SIGNAL_STORAGE_KEY = 'virlen.phone.signal'
const DEFAULT_SIGNAL_URL = 'https://virlen.cn/api/rtc/'
const DEVICE_NAME = 'Virlen 电脑'

/** ICE 自定义配置的存储端口（共享包 resolveIceServers 需要它，用 localStorage 同口径） */
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

/** Tauri 环境：配对表落盘到 `<data_dir>/phone-pairing.json` */
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

/** Tauri 环境：设备身份落盘到 `<data_dir>/phone-identity.json` */
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

/** 「操作记录」保留条数上限 */
const AUDIT_VIEW_LIMIT = 100
/** 二维码倒计时刷新间隔 */
const TICKET_TICK_MS = 1000

/** 合并视图去重键 */
function auditKey(e: AuditEntry): string {
  return `${e.at}|${e.method}|${e.interactionId ?? ''}|${e.detail ?? ''}|${e.allowed ? 1 : 0}`
}

class PhoneControlStore {
  enabled = false
  status: PhoneControlStatus = 'disabled'
  payload: PairingPayload | null = null
  devices: PairedDevice[] = []
  /** 现在正连着本机的手机（设备 id）—— 列表据此高亮 */
  activeDeviceId: string | null = null
  /** 当前链路通讯类型，与 status 正交：一个说连没连上，一个说怎么连上的 */
  linkKind: LinkKind = 'unknown'
  pendingPair: PendingPair | null = null
  error: string | null = null
  /** 本机设备身份（异步就绪；就绪前不能启用服务，否则会用临时 key 建房间） */
  identity: HostIdentity | null = null
  /** 本次连接实际使用的 ICE 服务器（自定义 > 服务端下发 > 缓存 > 空） */
  iceServers: IceServerInit[] = []
  /** ICE 来源（设置页文案 + 埋点） */
  iceSource: IceSource = 'none'
  /** 来源的中文描述（由共享包给出） */
  iceDetail = '尚未解析'
  /** 降级 / 异常时的补充说明（如「信令服务暂不可达」）。 */
  iceWarning: string | null = null
  /** 自定义配置写了但非法时的原因（标红提示，不阻断连接） */
  iceCustomError: string | null = null
  /** ICE 配置文本框的内容（展开折叠区时回填）。 */
  iceText = ''
  iceLoading = false
  /** 是否已解析过 ICE（首次启用解析一次） */
  private iceResolved = false
  /** 当前二维码剩余秒数；到期自动换新码 */
  ticketLeftSec: number | null = null
  /** 本次会话的审计条目（倒序）—— 浏览器 harness 下是唯一读取面 */
  liveEntries: AuditEntry[] = []
  /** 从磁盘读回的历史审计（倒序，仅 Tauri） */
  diskEntries: AuditEntry[] = []
  auditLoaded = false

  /** 审计日志（与 bridge 同一实例，否则设置页读不到 bridge 写的记录） */
  readonly audit: AuditLog

  /** 配对表，与 PhoneControlService 同一实例（未启用也能看到已绑定的手机） */
  readonly pairing = new PairingStore()

  /**
   * 待应答交互注册表，同样归本 store 持有（改 ICE 重建会丢失排队中的交互）。
   * 懒建：从未启用就不建表、不接线。
   */
  private interactions: InteractionRegistry | null = null

  private service: PhoneControlService | null = null
  private ticketTimer: ReturnType<typeof setInterval> | null = null

  /** 测试注入（生产不设置）：把传输工厂转交给服务，jsdom 里用 memory transport 验证胶水 */
  createTransport?: (room: string) => Transport

  constructor() {
    this.audit = new AuditLog(undefined, (entry) => this.onAudit(entry))
    makeObservable(this, {
      enabled: observable,
      status: observable,
      payload: observable.ref,
      devices: observable,
      activeDeviceId: observable,
      linkKind: observable,
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
      renameDevice: action,
      loadAuditHistory: action,
      clearAudit: action,
      loadIceText: action,
      setIceText: action,
      saveIceConfig: action,
      resetIceConfig: action,
      refreshIce: action,
    })
    void this.initIdentity()
    void this.restorePairing()
  }

  /**
   * 启动即读回配对表并订阅后续变更。订阅必须在构造时挂好：兑换票据发生在点「允许」之后，
   * 那时再拉列表只会拉到空。
   */
  private async restorePairing(): Promise<void> {
    const persistence = buildPersistence()
    // 一变就落盘（旁路）+ 刷界面
    this.pairing.onChange = (snap) => {
      persistence?.save(JSON.stringify(snap))
      this.syncDevices()
    }
    if (!persistence) return
    try {
      const raw = await persistence.load()
      if (raw) {
        runInAction(() => {
          this.pairing.restore(JSON.parse(raw) as PairingSnapshot)
        })
      }
    } catch {
      /* 坏数据 / 读取失败：保持空配对表 */
    }
    this.syncDevices()
  }

  /** 把配对表最新状态搬进可观察字段 */
  private syncDevices(): void {
    const view = this.pairing.view()
    runInAction(() => {
      this.devices = view.devices
      this.activeDeviceId = view.activeDeviceId
    })
  }

  /** 设备 key 是房间号的来源，必须在任何房间 / 二维码之前就绪 */
  private async initIdentity(): Promise<void> {
    const identity = await loadHostIdentity(buildIdentityPersistence())
    runInAction(() => {
      this.identity = identity
    })
  }

  /** 审计写入时更新内存镜像 + 旁路落盘 */
  private onAudit(entry: AuditEntry): void {
    runInAction(() => {
      this.liveEntries = [entry, ...this.liveEntries].slice(0, AUDIT_VIEW_LIMIT)
    })
    if (!inTauri()) return
    void invoke('cmd_phone_audit_append', { line: JSON.stringify(entry) }).catch(() => {
      /* 旁路：不打断功能 */
    })
  }

  /** 合并视图（内存 + 磁盘，去重、倒序、限长） */
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

  /** 读回磁盘历史（设置页打开时调一次）；浏览器 harness 下是空操作 */
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
      this.linkKind = 'unknown'
      this.error = null
    }
  }

  private async enableAsync(): Promise<void> {
    if (!this.identity) await this.initIdentity()
    // ICE 必须在建链路之前拿到（RTCPeerConnection 构造后就改不了）
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

  /**
   * 解析本次要用的 ICE。永不抛错：拿不到就退化成「仅本机候选」，来源与降级原因如实写进状态。
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

  /** 展开 ICE 折叠区时回填文本框（坏数据按没填处理） */
  loadIceText(): void {
    this.iceText = readCustomIceText(iceStorage())
  }

  setIceText(text: string): void {
    this.iceText = text
  }

  /** 保存自定义 ICE（留空 = 恢复服务端默认）。先校验再落盘，错误当场暴露。 */
  async saveIceConfig(): Promise<boolean> {
    const result = writeCustomIceText(iceStorage(), this.iceText)
    // 用 === false 而非 !result.ok：tsconfig 关了 strictNullChecks，真值判断不收敛联合类型
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

  /** 恢复服务端默认（清掉本机自定义） */
  async resetIceConfig(): Promise<void> {
    writeCustomIceText(iceStorage(), '')
    runInAction(() => {
      this.iceText = ''
      this.iceCustomError = null
    })
    await this.applyIceChange()
  }

  /** 重新解析一次（排查连通性时用） */
  async refreshIce(): Promise<void> {
    await this.applyIceChange()
  }

  private async applyIceChange(): Promise<void> {
    await this.resolveIce()
    if (this.enabled) this.rebuildService()
  }

  /**
   * 换 ICE = 重建链路（iceServers 只在构造时生效）。副作用是二维码换一张。
   * 这里是唯一换掉服务实例的路径；identity / ICE 都已解析时 enableAsync 整段同步，
   * 故不存在接线断着的窗口。
   */
  private rebuildService(): void {
    this.service?.dispose()
    this.service = null
    void this.enableAsync()
  }

  /**
   * 懒建 + 跨服务实例复用交互注册表。推送出口必须指向本 store 的方法（service?.emitToLink），
   * 不能绑某个实例。接线随服务启停走，不在这里。
   */
  private ensureInteractions(): InteractionRegistry {
    if (this.interactions) return this.interactions
    // 显式标注 `HostEmit`：它是泛型签名，箭头函数直接传给工厂会丢掉类型参数
    const emit: HostEmit = (topic, payload) => this.service?.emitToLink(topic, payload)
    this.interactions = createInteractionRegistry({
      emit,
      // 与设置页共用同一份审计（否则手机侧的批准不进「操作记录」）
      audit: this.audit,
      // 手机批准高风险操作时提醒电脑前的人
      notify: (text) => showToast(text, 6000),
    })
    return this.interactions
  }

  /**
 * 设置页打开时：换一张新码 + 开始倒计时（屏上那张可能已放了几分钟）。
 * 顺手对一次房间在线的账（SSE 静默死掉时胶囊会说假话）。
 */
  onPanelOpen(): void {
    if (!this.enabled) return
    const service = this.service
    if (!service) return
    this.payload = service.refreshTicket()
    this.ticketLeftSec = remainingSec(service.ticketDeadline)
    this.startTicketTimer()
    void service.verifyRoomPresence()
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

  /**
   * 移除一台已配对手机（不依赖服务是否启用）。若移除的正是此刻连着的那台，
   * 光删记录不够（已建好的 RPC 通道不看凭证）→ 让服务拆掉重开。
   */
  revokeDevice(deviceId: string): void {
    const connected = this.pairing.activeDeviceId === deviceId
    // 变更会经 `pairing.onChange` 回到 `syncDevices()`，这里不必再手动同步
    this.pairing.revoke(deviceId)
    if (connected) this.service?.dropLink()
    /*
     * 票已随移除作废 → 屏上那张码已扫不动，立即换新；别的手机照常可扫。
     */
    if (this.enabled) this.refreshTicket()
  }

  /**
   * 给已配对手机改名（不依赖服务是否启用；名字不进授权判定，不掉线）。
   * @returns 设备不在列表 / 名字非法时为 false
   */
  renameDevice(deviceId: string, name: string): boolean {
    const updated = this.pairing.rename(deviceId, name)
    return updated !== null
  }

  /** 二维码倒计时；票据一失效（到期 / 被扫走）就换新码 */
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
    // 三种「不可用」都要换新：还没票 / 到期 / 被扫走（兑换即从票据表删除）
    const rotated = service.rotateTicketIfStale()
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
      // ICE 由本 store 解析后传入（源码里不再有任何 TURN 凭证）
      iceServers: this.iceServers,
      iceSource: this.iceSource,
      // 三份表都与设置页共用，且都归本 store 持有
      pairing: this.pairing,
      audit: this.audit,
      interactions: this.ensureInteractions(),
      // 测试注入（生产不设置）：把 store 收到的传输工厂转交给服务
      ...(this.createTransport ? { createTransport: this.createTransport } : {}),
      // 手机批准高风险操作时提醒电脑前的人（§16.3-2）
      notify: (text) => showToast(text, 6000),
      confirmPair: (ctx) =>
        new Promise<boolean>((resolve) => {
          runInAction(() => {
            this.pendingPair = { token: ctx.token, mobileName: ctx.mobileName, resolve }
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
      // 通讯类型与状态正交（见 linkKind 字段）
      onLinkKindChange: (kind) => {
        runInAction(() => {
          this.linkKind = kind
        })
      },
    })
    this.service = service
    return service
  }

  /** 刷新二维码载荷（服务启停 / 确认配对后） */
  private sync(): void {
    const service = this.service
    if (!service) return
    runInAction(() => {
      this.payload = service.pairingPayload()
    })
    this.syncDevices()
  }
}

/** 剩余秒数（null = 没有票据） */
function remainingSec(deadline: number | null, now: number = Date.now()): number | null {
  if (deadline == null) return null
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export const phoneControlStore = new PhoneControlStore()
