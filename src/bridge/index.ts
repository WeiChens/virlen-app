/**
 * 电脑侧 bridge —— 手机控制的「接口层」装配入口（唯一）。
 *
 * 在一条已建立的 `Endpoint`（M2 用 BroadcastChannel / memory；M3 换 WebRTC）之上，
 * 装配出「真实数据源 + 分发胶水 + store 旁路推送」三件套：
 *
 *   Endpoint ── registerHostHandlers(source) ──▶ host.* RPC（ACL / 审计 / 白名单 DTO）
 *            └─ createStoreBridge(emit) ──────▶ host.event.* 推送（mobx reaction 旁路）
 *
 * 用法（M2 联调 / M3 桌面端）：
 * ```ts
 * const bridge = startPhoneBridge(endpoint, { deviceName: '我的电脑' })
 * // ... 结束时 bridge.dispose()
 * ```
 *
 * ⚠️ M2 尚未接入真实传输（WebRTC 属 M3），故本模块**不在 main.ts 里自启** ——
 * 只导出工厂，由 M3 的传输层在连接建立后调用；M2 通过 vitest（memory transport）验证。
 * 数据源与 mock（`virlen-remote/testing`）共用同一份分发胶水，故此处逻辑已被 mock 路径覆盖。
 */
import {
  BridgeError,
  registerHostHandlers,
  type Endpoint,
  type HostDataSource,
  type HostRegistration,
  type StreamMode,
} from 'virlen-remote'
import { Acl, DEFAULT_CAPABILITIES, type Capability } from './acl'
import { AuditLog, type AuditEntry, type AuditPersist } from './audit'
import { PairingStore } from './pairing'
import { SubscriptionRegistry } from './subscription'
import { attachInteractionSources } from './interaction-source'
import { InteractionRegistry } from './interaction-registry'
import { createDesktopHostSource, type HelloOutcome } from './host-source'
import { createStoreBridge, type StoreBridge } from './store-bridge'
import { createTracedEmit, instrumentPhoneRpc } from './telemetry'

export { Acl, DEFAULT_CAPABILITIES } from './acl'
export type { Capability } from './acl'
export { AuditLog, previewOf, AUDIT_PREVIEW_LEN } from './audit'
export type { AuditEntry, AuditKind, AuditPersist } from './audit'
export { classifyApproval, KNOWN_PERMS } from './approval-policy'
export type { ApprovalDescriptor, ApprovalPolicy } from './approval-policy'
export { InteractionRegistry, normalizeChoiceAnswer } from './interaction-registry'
export type { InteractionSink, InteractionRegistryDeps, ChoiceAnswer } from './interaction-registry'
export { attachInteractionSources } from './interaction-source'
export type { AttachInteractionOptions, InteractionHost } from './interaction-source'
export { PairingStore, DEFAULT_DEVICE_NAME, DEVICE_NAME_MAX, normalizeDeviceName } from './pairing'
export type { PairedDevice, PairingSnapshot, AuthorizationResult } from './pairing'
export { classifyLinkKind, probeLinkKind, LinkKindWatcher, LINK_KIND_POLL_MS } from './link-kind'
export type { LinkKind } from './link-kind'
export { SubscriptionRegistry } from './subscription'
export { createDesktopHostSource } from './host-source'
export type { HelloOutcome } from './host-source'
export { createStoreBridge } from './store-bridge'
export { PhoneControlService, REJECT_KICK_DELAY_MS } from './phone-control'
export type {
  PhoneControlOptions,
  PhoneControlStatus,
  PairingPayload,
  PhonePairingPersistence,
} from './phone-control'
export {
  toMessageDTO,
  toSessionSummaryDTO,
  toRuntimeDTO,
  projectContentToText,
  buildToolNameIndex,
  normalizeWorkspace,
} from './dto'
export { PHONE_EVENTS, PHONE_EVENT_NAMES } from './telemetry'

export interface PhoneBridgeOptions {
  /** 本机在手机端显示的名称（hello 应答）。 */
  deviceName?: string
  /** 本机标识（手机端据此保存设备记录）。 */
  deviceId?: string
  /** 覆盖 ACL 允许的能力集（默认 `DEFAULT_CAPABILITIES`）。 */
  capabilities?: Capability[]
  /** 本机应用版本号。 */
  appVersion?: string
  /** 复用既有配对表（如从设置页传入）；不传则新建。 */
  pairing?: PairingStore
  /** 首次绑定确认（电脑弹窗）；返回 false 则拒绝。不传默认放行（生产必须传）。 */
  confirmPair?: (ctx: { token: string; deviceName: string }) => Promise<boolean>
  /**
   * 审计落盘（旁路，fire-and-forget）。Tauri 下接 Rust `cmd_phone_audit_append`。
   * 不传则只保留内存缓冲（浏览器 harness / 单测）。
   */
  auditPersist?: AuditPersist
  /**
   * 桌面侧提示。仅用于「手机批准高风险操作」时提醒电脑前的人（§16.3-2）——
   * 手机批准会收掉桌面弹窗，若电脑前的人恰好在场，必须知道刚才那下不是自己点的。
   */
  notify?: (text: string) => void
  /** 复用既有审计日志（如设置页需要读同一份记录）；不传则新建。 */
  audit?: AuditLog
  /**
   * **握手闸门**（M10，真机缺陷「移除后手机又连回来」）。
   *
   * 开启后：这条链路上除 `host.hello` 以外的**所有** `host.*` 调用，都必须先有一次成功的
   * `hello`，否则一律 `E_DENIED`。
   *
   * 为什么必须有：房间号由电脑设备 key 派生（被移除的那台手机也拿得到），所以「把它踢出去」
   * 在信令层做不到 —— 它随时能重进房间、重新把 WebRTC 链路建起来。而**授权只发生在 hello 里**：
   * 不设这道闸门时，一台已被移除的手机只要把链路建起来，就能照常调 `host.session.list` /
   * `send` / `delete`（`acl.assert` 只看静态能力集，**不看**这条连接是谁），
   * 于是「移除」在用户看来等于没移除。
   *
   * 默认关：单测 / 联调里直接打 RPC 是既有约定（见 `phone-bridge.test.ts`）；
   * 生产路径（`PhoneControlService`）必须开。
   *
   * ⚠️ 开闸是**链路级**的一次性事实（`ok` 之后就开着），所以「拒绝」只能靠不开闸 ——
   * 而只靠不开闸还不够让用户看出「移除生效了」：链路还在、界面就没有一个否定结论可显示。
   * 那半边在 `PhoneControlService.rejectPeer()`：握手被拒 = 连链路一起踢。
   */
  requireAuthorization?: boolean
  /** 每次 `host.hello` 的结论 —— 服务据此决定「算不算已连接」（链路通 ≠ 授权通过）。 */
  onHelloResult?: (outcome: HelloOutcome) => void
}

export interface PhoneBridge {
  readonly deviceId: string
  readonly pairing: PairingStore
  readonly audit: AuditLog
  readonly interactions: InteractionRegistry
  dispose(): void
}

let bridgeSeq = 0

export function startPhoneBridge(endpoint: Endpoint, options: PhoneBridgeOptions = {}): PhoneBridge {
  const deviceName = options.deviceName ?? 'Virlen 电脑'
  const deviceId = options.deviceId ?? `host-${Date.now().toString(36)}-${++bridgeSeq}`
  const appVersion = options.appVersion ?? '0.1.0'
  const pairing = options.pairing ?? new PairingStore()
  const acl = new Acl(options.capabilities ?? DEFAULT_CAPABILITIES)
  const audit = options.audit ?? new AuditLog(undefined, options.auditPersist)
  const subscriptions = new SubscriptionRegistry()

  // ⚠️ 埋点包装必须在 `registerHostHandlers` **之前**（否则注册的是未包装的 handler，见 telemetry.ts）
  const rpcTrace = instrumentPhoneRpc(endpoint)
  /**
   * 本次链路是否已通过 `hello`（`requireAuthorization` 的判定依据；每条链路各自一份）。
   *
   * 两个出口都看它：入站 `host.*`（`gatedHostSource`）与**出站推送**（下面的 `endpoint.emit` 补丁）。
   */
  let authorized = false
  if (options.requireAuthorization) {
    /*
     * 出站闸门 —— 未授权的链路**连推送都不给**。
     *
     * 为什么只有入站闸门不够：`store-bridge` 与交互注册表走的是**旁路推送**（mobx reaction → emit），
     * 不经过 `endpoint.handle`。一条没握过手的链路虽然调不动 `host.*`，却仍会收到会话列表变更、
     * 消息正文流这些事件 —— 对一台已被移除的手机来说，那同样叫「连上了」。
     *
     * 补在 `endpoint.emit` 上而不是逐处包 emit：推的人有好几个（store-bridge / 交互 / 埋点包装），
     * 而 `emit` 只有一个出口；`createTracedEmit` 内部也是**动态**取 `endpoint.emit`，
     * 补在这里一并盖住。
     *
     * ⚠️ 代价：被拦掉的那几帧会被埋点包装记成 `phone.push.dropped reason=not-sent`
     *（它只看得见「没发出去」）。宁可这样，也不要在多个推入口各包一层 —— 漏掉的那个就是新的漏洞。
     */
    const rawEmit = endpoint.emit.bind(endpoint)
    endpoint.emit = (topic: string, payload?: unknown) => (authorized ? rawEmit(topic, payload) : false)
  }
  // 出站事件统一走包装后的 emit：既推给手机，也留下埋点（含 `emit` 返回 false 的「被静默丢弃」）
  const emit = createTracedEmit(endpoint)

  // 先建注册表（host-source 的 answer 要用它），再由 interaction-source 把真实事件接上去
  const interactionHost = attachInteractionSources(emit, {
    audit,
    notify: options.notify,
  })
  const interactions = interactionHost.registry

  /**
   * 手机声明的流式偏好（§32）：默认 `'full'`（每帧整段），声明 `delta` 才走增量。
   *
   * 为何放一个可变变量而不是放进 options：偏好是**每次 hello 重报**的合同，
   * 同一台电脑先后接入不同手机（顶号）时不能把上一台的声明漏给下一台。
   */
  let peerStreamMode: StreamMode = 'full'

  // store-bridge 先建：host-source 的 hello / subscribe 两条路径要回头调它（重置流式基准）
  const storeBridge: StoreBridge = createStoreBridge(emit, subscriptions, {
    streamMode: () => peerStreamMode,
  })

  const source = createDesktopHostSource({
    pairing,
    acl,
    audit,
    subscriptions,
    interactions,
    deviceName,
    deviceId,
    appVersion,
    confirmPair: options.confirmPair,
    /**
     * 手机在 hello 里声明的流式偏好（§32）：默认整帧，声明 `delta` 才走增量。
     *
     * ⚠️ 每次握手都**清空流式基准**：同一房间可能先后接入不同手机（顶号），
     * 而「已发到第几个字符」是**针对某个客户端**的，换人就得重算。
     */
    onStreamMode: (mode: StreamMode) => {
      peerStreamMode = mode
      storeBridge.resetStreams()
    },
    /** 重新订阅 = 手机侧正文从零开始（切回会话 / 重连）→ 重置该会话的增量基准 */
    onSubscribe: (sessionId: string) => storeBridge.resetStreams(sessionId),
    /**
     * 握手结论既开闸门，也上报给调用方。
     *
     * ⚠️ 只有 `ok` 能开闸：拒绝（已被移除 / 凭证过期 / 用户点了拒绝）之后**不能**再放行 ——
     * 那正是「移除一台手机后它重连回来还能操作本机」的漏洞所在。
     */
    onHelloResult: (outcome: HelloOutcome) => {
      if (outcome.ok) authorized = true
      options.onHelloResult?.(outcome)
    },
  })

  const registration: HostRegistration = registerHostHandlers(
    endpoint,
    options.requireAuthorization ? gatedHostSource(source, () => authorized) : source,
    {
      hostInfo: { platform: 'desktop', appVersion },
      capabilities: acl.capabilities,
      deviceName,
    },
  )

  return {
    deviceId,
    pairing,
    audit,
    interactions,
    dispose() {
      interactionHost.dispose()
      storeBridge.dispose()
      registration.dispose()
      // 埋点收尾：先把推送统计冲出去（`phone.push.stats`），再拆掉包装
      emit.dispose()
      rpcTrace.dispose()
      subscriptions.clear()
    },
  }
}

/**
 * 把「这条链路是否通过了 `hello`」变成硬闸门（`requireAuthorization`）。
 *
 * 用 `Proxy` 而不是逐个方法包一层：`registerHostHandlers` 注册的方法集随协议增长（现在 20 个），
 * 手写清单迟早漏一个 —— 而漏掉的那个就是一条不设防的后门。这里只豁免 `hello` 本身（它是开门的那把钥匙）。
 */
function gatedHostSource(source: HostDataSource, isAuthorized: () => boolean): HostDataSource {
  return new Proxy(source, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || prop === 'hello') return value
      return (...args: unknown[]) => {
        if (!isAuthorized()) {
          throw new BridgeError('E_DENIED', '尚未完成配对握手（host.hello）—— 本链路未获授权')
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as HostDataSource
}
