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
 *
 * M8 起：本 store **持有配对表**（`pairing`）并自己管落盘与变更订阅。理由是真机缺陷
 * 「扫码配对通过后『已绑定的手机』不新增」：
 *  - 列表要**冒泡**：配对表一变就刷（靠 `pairing.onChange`），而不是只在 enable /
 *    点「允许」的瞬间拉一次 —— 那一刻手机还没兑换票据（hello 是异步的），拉到的必然是旧的；
 *  - 列表要**随时可见**：未启用时服务根本不存在，而磁盘里可能已经有几台手机。
 *
 * M9 起又两件（真机反馈）：
 *  - **移除正在连接的那台 = 立刻断它的链**：`revokeDevice` 发现目标是当前在线设备时，
 *    让服务把链路拆掉重开（`PhoneControlService.dropLink`）—— 否则它会继续操作到链路自己断为止；
 *  - **通讯类型可见**：`direct`（P2P 直连）/ `relay`（TURN 中继）由服务从 ICE 候选对判定后上报，
 *    本 store 只镜像（`linkKind`），设置页把它显在状态胶囊旁边。
 *
 * M10 起（真机反馈「移除后它又连回来」）—— 移除的语义补到完整：
 *  - 移除会**作废所有未使用的配对票**（`PairingStore.revoke`），所以那台手机上缓存的二维码
 *    不再有配对权；`revokeDevice` 随之**换一张新码**，屏上的码始终可用；
 *  - 链路的 **RPC 与推送都过握手闸门**（未通过 `hello` 一律不给），
 *    详见 `PhoneControlService` ← `PhoneBridgeOptions.requireAuthorization`。
 *
 * M12 起：「已绑定的手机」可以**改名**（`renameDevice`）。名字是本机给人看的标签，
 * 改它不碰凭证 / 不碰链路 —— 详见 `PairingStore.rename`。
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
  /**
   * 请求方（**手机**）的名字 —— 由 bridge 侧归一 + 兜底，界面直接显示。
   *
   * 别改回 `deviceName`：那是**本机（电脑）**的名字，本字段拿错一次就会让确认弹窗
   * 显示成「「Virlen 电脑」请求连接并操作本机」。
   */
  mobileName: string
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

/**
 * Tauri 环境：把配对表落盘到 `<data_dir>/phone-pairing.json`（Rust 命令）。
 *
 * 落盘由**本 store** 负责（配对表归它持有），服务不再重复管一份。
 */
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
  /** 现在**正连着**本机的那台手机（设备 id；没连接时为 `null`）—— 列表据此高亮。 */
  activeDeviceId: string | null = null
  /**
   * 当前链路的通讯类型（`direct` = P2P 直连 / `relay` = TURN 中继 / `unknown` = 没结论）。
   *
   * 与 `status` 正交：`status` 说「连没连上」，它说「怎么连上的」；链路一断就回到 `unknown`
   * （设置页据此决定收不收起那枚胶囊）。
   */
  linkKind: LinkKind = 'unknown'
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

  /**
   * 配对表（票据 / 已绑定设备）—— 与 `PhoneControlService` **同一实例**。
   *
   * 本 store 持有而不是让服务持有，是为了「未启用也能看到已绑定的手机」；
   * 服务启停 / 改 ICE 重建都换不掉这张表。落盘与变更订阅见 `restorePairing()`。
   */
  readonly pairing = new PairingStore()

  /**
   * 待应答交互注册表（提问 / 授权）—— 与配对表、审计同一套做法：**本 store 持有**。
   *
   * 为什么不能留在服务实例上（2026-10）：服务实例在「改 ICE」时会被换掉
   * （`RTCPeerConnection` 的 `iceServers` 只能构造时给，见 `rebuildService`），
   * 换一次就把排队中的交互连表一起丢掉 —— 手机上那张卡片变成点不动的僵尸
   *（点一下得 `not-found`），而电脑侧弹窗与引擎仍在等。
   *
   * **懒建**（首次建服务时）：未启用手机控制就不建表、不接线，也就不会有 `phone.interaction.*` 埋点。
   */
  private interactions: InteractionRegistry | null = null

  private service: PhoneControlService | null = null
  private ticketTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 测试注入：建服务时转交给 `PhoneControlOptions.createTransport`（默认建 host 角色的 `RtcTransport`）。
   *
   * 为何它必须在 **store 这一层**能注：jsdom 里没有 `RTCPeerConnection`，而「启用 → 手机连上 →
   * 改 ICE 重建服务 → 手机重连」这条整链路只有 store 能驱动。单测靠 memory transport 把它跑起来，
   * 从而验证 store 的胶水（见 `src/tests/ui/phone-control-relink.test.ts`）。
   * **生产路径不设置它。**
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
   *
   * 订阅必须在构造时就挂好（不能等启用服务）：手机兑换票据（`pairing.redeemTicket`）发生在
   * 用户点「允许」**之后**的异步链路里，设置页那一刻去拉列表只会拉到空 —— 这正是
   * 「扫码授权绑定通过连接后，已绑定的手机没有数据新增」的根因。
   */
  private async restorePairing(): Promise<void> {
    const persistence = buildPersistence()
    // 配对表一变：落盘（旁路，失败不影响本次会话）+ 刷界面
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
      this.linkKind = 'unknown'
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
   *
   * ⚠️ 这里是**唯一**换掉服务实例的路径（`setEnabled(false/true)` 复用同一个实例）。
   * 丢服务用 `dispose()`（= 「不再复用这个实例」；内部就是 `disable()` —— 停链路 + 解绑本机
   * 交互来源，那个全局监听器不会悬空）。
   * 三份「跨实例存活」的对象都归本 store：配对表、审计、**待应答交互注册表**
   *（`ensureInteractions`，表不随实例更替而丢）。
   * ⚠️ 这条路径**不存在「接线断着」的窗口**：`dispose()` 后紧接着 `enableAsync()`，而 identity /
   * ICE 都已解析时 `enableAsync` 整段**同步**执行（路径上没有 await 点），接线在同一个 tick 内重新挂好。
   */
  private rebuildService(): void {
    this.service?.dispose()
    this.service = null
    void this.enableAsync()
  }

  /**
   * 待应答交互注册表（懒建 + 跨服务实例复用）。
   *
   * ⚠️ **推送出口写成本 store 的方法引用，而不是某个服务实例的**：改 ICE 后服务实例会换，
   * 出口必须自动指到「现在那个」（`service?.emitToLink`；没有服务 / 没有链路时丢弃 ——
   * 条目仍在表里，手机连上后靠 `host.interaction.list` 快照补齐）。
   *
   * ⚠️ **接线（`toolInteractEvent` → 本表）不在本函数里**：它随**服务启停**走
   *（`PhoneControlService.enable()` 挂、`disable()` 解，见 `attachInteractions`）。
   * 于是「关掉手机控制」期间不会登记、也不会有 `phone.interaction.*` 埋点；
   * 而表本身**不清空** —— 本机弹窗与引擎还在等，重新启用后手机连上即可应答。
   * 本函数只管**懒建**：从未启用过手机控制就不建表、不接线。
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
   * 设置页打开时调用：**换一张新码**并开始倒计时。
   *
   * 用户拍板的做法（2026-09-27）：每次切到「手机控制」菜单就重新生成一遍二维码 ——
   * 面板上那张码可能已经放了几分钟，而用户此刻才举起手机去扫。
   *
   * 顺手对一次「房间在线」的账（`verifyRoomPresence`）：用户正盯着那颗胶囊，而它可能是
   * 一句假话（信令事件流静默死掉时，电脑端会停在「等待手机连接…」，手机上却已显示
   * 「电脑不在线」）。定时自检最长要等 `ROOM_PRESENCE_CHECK_MS`，打开面板这一刻不该再等。
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
   * ⚠️ 移除的若是**此刻正连着**的那台，光删记录不够：链路不会自己断，它会一直操作到链路
   * 关闭为止（凭证虽已失效，但已建好的 RPC 通道不看凭证）→ 让服务把这条链路拆掉重开。
   * 判断用 `pairing.activeDeviceId` 而不是本 store 的镜像字段：配对表才是唯一真源。
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
   * 给一台已配对手机**改名**（设置页行内编辑的唯一入口）。
   *
   * 与「移除」同一口径：**不依赖服务是否启用** —— 配对表归本 store 持有（见类注释 M8 段），
   * 未启用时也照样改得了名；改名也不碰链路（名字不进授权判定，不会让在连着的那台掉线）。
   * 变更经 `pairing.onChange` 回到 `syncDevices()`（列表镜像 + 落盘一起刷新），这里不再手动同步。
   *
   * @returns 真的改成了 `true`；设备已不在列表里（或名字非法）`false` —— 设置页据此提示，
   *          而不是静默地什么都不发生
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
    /*
     * 「不可用」的三种都要换新：还没票 / 到期 / **被扫走**（兑换即从票据表删除）。
     * 只等到期才换的话，屏幕上会留一张死码最长 5 分钟 —— 真机反馈是「第二台手机扫它只得
     * 『二维码已过期』」；兑换发生在用户点「允许」之后，屏上那张码必须跟着转，才始终可扫。
     */
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
      // 与设置页共用同一张配对表（表归本 store 持有 → 落盘与变更订阅也在本 store，见 restorePairing）
      pairing: this.pairing,
      // 与设置页共用同一份审计（否则「操作记录」看不到 bridge 写下的条目）
      audit: this.audit,
      // 待应答交互的表也归本 store 持有 —— 改 ICE 换服务实例时它必须活下来（见 ensureInteractions）
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
      // 通讯类型（P2P 直连 / TURN 中继）—— 独立于状态：状态说「连没连上」，它说「怎么连上的」
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
