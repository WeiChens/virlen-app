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
import { registerHostHandlers, type Endpoint, type HostRegistration, type StreamMode } from 'virlen-remote'
import { Acl, DEFAULT_CAPABILITIES, type Capability } from './acl'
import { AuditLog, type AuditEntry, type AuditPersist } from './audit'
import { PairingStore } from './pairing'
import { SubscriptionRegistry } from './subscription'
import { attachInteractionSources } from './interaction-source'
import { InteractionRegistry } from './interaction-registry'
import { createDesktopHostSource } from './host-source'
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
export { PairingStore } from './pairing'
export type { PairedDevice, PairingSnapshot, AuthorizationResult } from './pairing'
export { SubscriptionRegistry } from './subscription'
export { createDesktopHostSource } from './host-source'
export { createStoreBridge } from './store-bridge'
export { PhoneControlService } from './phone-control'
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
  })

  const registration: HostRegistration = registerHostHandlers(endpoint, source, {
    hostInfo: { platform: 'desktop', appVersion },
    capabilities: acl.capabilities,
    deviceName,
  })

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
