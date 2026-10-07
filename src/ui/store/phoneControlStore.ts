/**
 * 「手机控制」设置页的状态 + 单例服务持有者。
 *
 * 三份「跨服务实例存活」的对象都归本 store：`pairing`（配对表）、`audit`（审计）、
 * `interactions`（待应答交互表）。服务实例在改 ICE 时会被换掉（见 `rebuildService`），
 * 放服务里会连表一起丢 —— 手机上那张交互卡片变成点不动的僵尸。
 *
 * `confirmPair` 把「首次绑定确认」桥接成 UI：挂起 Promise + 打开设置页等用户点允许/拒绝。
 * 配对表变更由本 store 订阅（`pairing.onChange`）→ 冒泡刷列表 + 落盘；不能只在 enable /
 * 点允许那一刻拉一次，那时 hello 还没回来，必然是旧的。
 *
 * 不并入 `ui/store/index` barrel：它 import `@/bridge`，`@/bridge` 又依赖 `@/ui/store`，走 barrel 成环。
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
  /** 请求方（**手机**）的名字，bridge 侧已归一 + 兜底。别改回 `deviceName` —— 那是本机电脑的名字。 */
  mobileName: string
  resolve: (ok: boolean) => void
}

const SIGNAL_STORAGE_KEY = 'virlen.phone.signal'
const DEFAULT_SIGNAL_URL = 'https://virlen.cn/api/rtc/'
const DEVICE_NAME = 'Virlen 电脑'

/** ICE 自定义配置的存储端口（共享包 `resolveIceServers()` 要的就是它）。用 localStorage 与同页的 `virlen.phone.signal` 同口径；清掉只回服务端默认，不丢功能。 */
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

/** Tauri 环境：配对表落盘到 `<data_dir>/phone-pairing.json`（表归本 store 持有，落盘也归它，服务不再管一份）。 */
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

/** 「操作记录」保留条数上限（再多没人看，也要控渲染成本）。 */
const AUDIT_VIEW_LIMIT = 100
/** 二维码倒计时刷新间隔：只驱动一个文本，1 秒足够。 */
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
  /** 现在**正连着**本机的那台手机（设备 id；没连接时为 `null`）—— 列表据此高亮。 */
  activeDeviceId: string | null = null
  /** 当前链路通讯类型（`direct` = P2P 直连 / `relay` = TURN 中继 / `unknown` = 没结论）。与 `status` 正交：一个说「连没连上」，一个说「怎么连上的」；断链即回 `unknown`。 */
  linkKind: LinkKind = 'unknown'
  pendingPair: PendingPair | null = null
  error: string | null = null
  /** 本机设备身份（异步就绪；就绪前不允许启用服务，否则会用一个临时 key 建房间）。 */
  identity: HostIdentity | null = null
  /** 本次连接实际使用的 ICE 服务器（`自定义 > 服务端下发 > 缓存 > 空`），解析在共享包 `resolveIceServers()`（与手机端同一份）。 */
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

  /** 配对表（票据 / 已绑定设备），与 `PhoneControlService` **同一实例**。本 store 持有是为了「未启用也能看到已绑定的手机」；服务启停 / 重建都换不掉它（落盘与订阅见 `restorePairing()`）。 */
  readonly pairing = new PairingStore()

  /**
   * 待应答交互注册表（提问 / 授权），与配对表、审计同一套做法：**本 store 持有**。
   *
   * 留在服务实例上会被「改 ICE 重建」丢掉排队中的交互 —— 手机上的卡片变成点不动的僵尸
   * （点一下得 `not-found`），而电脑侧弹窗与引擎仍在等。
   * **懒建**：从未启用手机控制就不建表、不接线，也就没有 `phone.interaction.*` 埋点。
   */
  private interactions: InteractionRegistry | null = null

  private service: PhoneControlService | null = null
  private ticketTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 测试注入：建服务时转交 `PhoneControlOptions.createTransport`（默认建 host 角色的 `RtcTransport`）。
   * jsdom 没有 `RTCPeerConnection`，而「启用 → 连上 → 改 ICE 重建 → 重连」整条链路只有 store 能驱动，
   * 单测靠 memory transport 验证 store 的胶水（见 `src/tests/ui/phone-control-relink.test.ts`）。**生产不设置。**
   */
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
   * 启动即读回配对表，并**订阅后续变更**。
   * 订阅必须在构造时就挂好（不能等启用服务）：兑换票据发生在点「允许」**之后**的异步链路里，
   * 那一刻去拉列表只会拉到空 —— 这是「绑定了但列表不新增」的根因。
   */
  private async restorePairing(): Promise<void> {
    const persistence = buildPersistence()
    // 一变就落盘（旁路，失败不影响本次会话）+ 刷界面
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
      /* 坏数据 / 读取失败：保持空配对表（下一次变更会覆盖落盘） */
    }
    this.syncDevices()
  }

  /** 把配对表的最新状态搬进可观察字段（设备列表 + 在线标记）。 */
  private syncDevices(): void {
    const view = this.pairing.view()
    runInAction(() => {
      this.devices = view.devices
      this.activeDeviceId = view.activeDeviceId
    })
  }

  /** 设备 key 是房间号的来源，必须在任何房间 / 二维码之前就绪。 */
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
      this.linkKind = 'unknown'
      this.error = null
    }
  }

  private async enableAsync(): Promise<void> {
    if (!this.identity) await this.initIdentity()
    // ICE 必须在建链路**之前**拿到（`RTCPeerConnection` 构造后就改不了）；解析过一次就不再问服务端
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
   * 解析本次要用的 ICE。永不抛错：拿不到配置就退化成「仅本机候选」，而不是让「启用手机控制」失败；
   * 但来源与降级原因如实写进状态（设置页可见 + 埋点 `ice_source`）。
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

  /** 保存自定义 ICE（留空 = 恢复服务端默认）。先校验再落盘：错误在保存那一刻暴露，而不是等某次连接失败才发现少了个引号。 */
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
   * 换 ICE = 重建链路：`RTCPeerConnection.iceServers` 只在构造时生效，改不了。
   * 做法是「停旧服务 + 丢引用 + 重新启用」；副作用是二维码换一张（与「重新启用」同一语义，用户看得见）。
   *
   * ⚠️ 这里是**唯一**换掉服务实例的路径（`setEnabled(false/true)` 复用同一个）。
   * `dispose()` = 不再复用该实例（内部就是 `disable()`，全局监听器不会悬空）。
   * ⚠️ 这条路径**不存在「接线断着」的窗口**：`dispose()` 后紧接着 `enableAsync()`，而 identity / ICE
   * 都已解析时它整段**同步**执行（路径上没有 await 点），接线在同一个 tick 内挂回。
   */
  private rebuildService(): void {
    this.service?.dispose()
    this.service = null
    void this.enableAsync()
  }

  /**
   * 懒建 + 跨服务实例复用待应答交互注册表。
   *
   * ⚠️ 推送出口必须是**本 store 的方法引用**（`service?.emitToLink`），不能绑某个服务实例 ——
   * 改 ICE 后实例会换。没服务 / 没链路时直接丢弃：条目仍在表里，手机连上后靠
   * `host.interaction.list` 快照补齐。
   * ⚠️ 接线（`toolInteractEvent` → 本表）**不在这里**，它随服务启停走（`attachInteractions`）：
   * 关掉手机控制期间不登记、无埋点，但表本身**不清空** —— 本机弹窗与引擎还在等。
   */
  private ensureInteractions(): InteractionRegistry {
    if (this.interactions) return this.interactions
    // 显式标注 `HostEmit`：它是泛型签名，箭头函数直接传给工厂会丢掉类型参数
    const emit: HostEmit = (topic, payload) => this.service?.emitToLink(topic, payload)
    this.interactions = createInteractionRegistry({
      emit,
      // 与设置页共用同一份审计（否则手机侧的批准不进「操作记录」）
      audit: this.audit,
      // 手机批准高风险操作时提醒电脑前的人（§16.3-2）
      notify: (text) => showToast(text, 6000),
    })
    return this.interactions
  }

  /**
   * 设置页打开时调用：**换一张新码** + 开始倒计时（面板上那张码可能已放了几分钟，用户此刻才举起手机）。
   *
   * 顺手对一次「房间在线」的账：信令事件流静默死掉时那颗胶囊会说假话（电脑停在「等待手机连接…」，
   * 手机已显示「电脑不在线」），而定时自检最长要等 `ROOM_PRESENCE_CHECK_MS`。
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
   * 移除一台已配对手机（**不依赖服务是否启用**：配对表本来就归本 store 持有）。
   *
   * ⚠️ 移除的若是**此刻正连着**的那台，光删记录不够：已建好的 RPC 通道不看凭证，链路不会自己断
   * → 让服务拆掉重开。判断用 `pairing.activeDeviceId`（配对表才是唯一真源），不用本 store 的镜像字段。
   */
  revokeDevice(deviceId: string): void {
    const connected = this.pairing.activeDeviceId === deviceId
    // 变更会经 `pairing.onChange` 回到 `syncDevices()`，这里不必再手动同步
    this.pairing.revoke(deviceId)
    if (connected) this.service?.dropLink()
    /*
     * 票已随移除一并作废（`PairingStore.revoke`）→ 屏幕上那张码已经扫不动了，
     * 立即换一张新的：被移除的那台手机手上缓存的旧票不再有配对权，而别的手机照常可扫。
     */
    if (this.enabled) this.refreshTicket()
  }

  /**
   * 给一台已配对手机**改名**（设置页行内编辑的唯一入口）。与「移除」同口径：不依赖服务是否启用；
   * 名字不进授权判定，也不碰链路（在连着的那台不会掉线）。变更经 `pairing.onChange` 回到 `syncDevices()`。
   *
   * @returns 改成了 `true`；设备不在列表 / 名字非法 `false` —— 设置页据此提示，而不是静默无反应
   */
  renameDevice(deviceId: string, name: string): boolean {
    const updated = this.pairing.rename(deviceId, name)
    return updated !== null
  }

  /** 二维码倒计时（1 秒一跳）；票据一失效（到期 / **被扫走**）就立刻换新码，屏幕上永远是可用的。 */
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
    // 「不可用」三种都要换新：还没票 / 到期 / **被扫走**（兑换即从票据表删除）。只等到期才换会
    // 留一张死码最长 5 分钟；兑换发生在点「允许」之后，屏上那张码必须跟着转才始终可扫。
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
      // ICE 由本 store 解析后传入（默认值来自信令服务下发；源码里不再有任何 TURN 凭证）
      iceServers: this.iceServers,
      iceSource: this.iceSource,
      // 三份表（pairing / audit / interactions）都与设置页共用，且都归本 store 持有（见类注释）
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

  /** 刷新二维码载荷（服务启停 / 确认配对后调用）；设备列表由 `syncDevices` 负责。 */
  private sync(): void {
    const service = this.service
    if (!service) return
    runInAction(() => {
      this.payload = service.pairingPayload()
    })
    this.syncDevices()
  }
}

/** 剩余秒数（`null` = 没有票据）。 */
function remainingSec(deadline: number | null, now: number = Date.now()): number | null {
  if (deadline == null) return null
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export const phoneControlStore = new PhoneControlStore()
