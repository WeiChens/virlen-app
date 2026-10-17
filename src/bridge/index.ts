/**
 * 手机控制的接口层装配入口：Endpoint + 真实数据源 + 分发胶水 + store 旁路推送。
 * 只导出工厂，由传输层在链路建立后调用。
 */
import {
  BridgeError,
  registerHostHandlers,
  type Endpoint,
  type HostDataSource,
  type HostEmit,
  type HostRegistration,
  type StreamMode,
  type TransferTier,
} from 'virlen-remote'
import { Acl, DEFAULT_CAPABILITIES, type Capability } from './acl'
import { AuditLog, type AuditEntry, type AuditPersist } from './audit'
import { PairingStore } from './pairing'
import { SubscriptionRegistry } from './subscription'
import { attachInteractionSources, type InteractionHost } from './interaction-source'
import { InteractionRegistry } from './interaction-registry'
import { createDesktopHostSource, sessionWorkspaceOf, type HelloOutcome } from './host-source'
import { createHostFiles, type FileSystemPort, type HostFiles } from './file-source'
import { createTauriFileSystem } from './file-tauri'
import { securityService } from '@/services/security-service'
import type { LinkKind } from './link-kind'
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
export { attachInteractionSources, createInteractionRegistry } from './interaction-source'
export type { AttachInteractionOptions, InteractionHost } from './interaction-source'
export { PairingStore, DEFAULT_DEVICE_NAME, DEVICE_NAME_MAX, normalizeDeviceName } from './pairing'
export type { PairedDevice, PairingSnapshot, AuthorizationResult } from './pairing'
export {
  classifyLinkKind,
  probeLinkKind,
  LinkKindWatcher,
  LINK_KIND_POLL_MS,
  /* 链路类型 → 传输档位（两端同一份口径） */
  transferTierOf,
  MESSAGE_DETAIL_CAPABILITY,
} from './link-kind'
export type { LinkKind, TransferTier } from './link-kind'
export { SubscriptionRegistry } from './subscription'
export { createDesktopHostSource, sessionWorkspaceOf } from './host-source'
export type { HelloOutcome } from './host-source'
/* 工作目录文件：接口层 + Tauri 端口 */
export { createHostFiles } from './file-source'
export type { FileSystemPort, FileSysEntry, HostFiles, HostFilesDeps } from './file-source'
export { createTauriFileSystem } from './file-tauri'
export { createStoreBridge } from './store-bridge'
export {
  PhoneControlService,
  REJECT_KICK_DELAY_MS,
  HANDSHAKE_DEADLINE_MS,
  LINK_CLOSED_RECOVER_MS,
  ROOM_PRESENCE_CHECK_MS,
} from './phone-control'
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
  collectQuotes,
  collectFiles,
  buildToolCallIndex,
  normalizeWorkspace,
} from './dto'
export { PHONE_EVENTS, PHONE_EVENT_NAMES } from './telemetry'

export interface PhoneBridgeOptions {
  /** 本机在手机端显示的名称（hello 应答）。 */
  deviceName?: string
  /** 本机标识（手机端据此保存设备记录）。 */
  deviceId?: string
  /** 覆盖 ACL 允许的能力集。 */
  capabilities?: Capability[]
  /** 本机应用版本号。 */
  appVersion?: string
  /** 复用既有配对表（如从设置页传入）；不传则新建。 */
  pairing?: PairingStore
  /**
   * 首次绑定确认（电脑弹窗）；返回 false 则拒绝。不传默认放行（生产必须传）。
   * mobileName 是请求方（手机）的名字；本机名是上面的 deviceName。
   */
  confirmPair?: (ctx: { token: string; mobileName: string }) => Promise<boolean>
  /** 审计落盘（旁路）；不传则只保留内存缓冲。 */
  auditPersist?: AuditPersist
  /** 桌面侧提示：手机批准高风险操作时提醒电脑前的人。 */
  notify?: (text: string) => void
  /** 复用现有审计日志；不传则新建。 */
  audit?: AuditLog
  /**
   * 握手闸门：开后才允许除 host.hello 以外的 host.* 调用。
   * 房间号由设备 key 派生，被移除的手机也能重进房间，而 acl.assert 不看连接是谁，
   * 没有这道闸门「移除」等于没移除。默认关（单测直接打 RPC），生产必须开。
   */
  requireAuthorization?: boolean
  /** 每次 hello 的结论：链路通 ≠ 授权通过。 */
  onHelloResult?: (outcome: HelloOutcome) => void
  /** 收到 hello 请求的那一刻回调，早于一切 await（用于取消握手截止计时）。 */
  onHelloReceived?: () => void
  /**
   * 传输档位的策略来源（由持有 PC 的服务注入）。本模块仍会叠上
   * 「对端是否支持省略标记」—— 旧手机端一律回到 full。不传 = 永远 full。
   */
  transferTier?: () => TransferTier
  /**
   * 当前链路通讯类型，非中继门槛的唯一来源。口径与 transferTier 有意不同：
   * 档位把 unknown 算精简，文件传输只在确认中继时拒。不传 = 不限制。
   */
  linkKind?: () => LinkKind
  /** 文件系统端口（不传 = Tauri 实现）；可注入是为了单测。 */
  fileSystem?: FileSystemPort
  /** 路径安全校验（不传 = securityService.resolveSafePath）。不要另写一份拼接 / 越权判断。 */
  resolvePath?: (input: string, mode: 'r' | 'w', sessionId: string) => Promise<string>
  /**
   * 复用服务级交互注册表（不传则自建、随链路销毁）。
   * 「谁在等应答」是电脑侧的事实：换链路时不应把排队中的交互一起丢掉。
   * 注入时本函数不接线、也不销毁它。
   */
  interactions?: InteractionRegistry
}

export interface PhoneBridge {
  readonly deviceId: string
  readonly pairing: PairingStore
  readonly audit: AuditLog
  readonly interactions: InteractionRegistry
  /** 推事件给手机（与 store / 交互推送同一条出口，含出站闸门与埋点）。 */
  readonly emit: HostEmit
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

  // 埋点包装必须在 registerHostHandlers 之前，否则注册的是未包装的 handler
  const rpcTrace = instrumentPhoneRpc(endpoint)
  /** 本次链路是否已通过 hello；入站 host.* 与出站推送都看它。 */
  let authorized = false
  if (options.requireAuthorization) {
    /*
     * 出站闸门：未授权的链路连推送都不给。旁路推送（mobx reaction → emit）不经
     * endpoint.handle，只挡入站的话，被移除的手机仍会收到会话列表与正文流。
     * 补在 emit 这一个出口上，而不是逐个推入口各包一层。
     */
    const rawEmit = endpoint.emit.bind(endpoint)
    endpoint.emit = (topic: string, payload?: unknown) => (authorized ? rawEmit(topic, payload) : false)
  }
  // 出站事件统一走包装后的 emit：既推给手机，也留下埋点（含 `emit` 返回 false 的「被静默丢弃」）
  const emit = createTracedEmit(endpoint)

  // 先建注册表（host-source 的 answer 要用它）；注入态归服务所有，自建态随链路销毁
  let interactionHost: InteractionHost | null = null
  let interactions: InteractionRegistry
  if (options.interactions) {
    interactions = options.interactions
  } else {
    interactionHost = attachInteractionSources(emit, {
      audit,
      notify: options.notify,
    })
    interactions = interactionHost.registry
  }

  /** 对端声明的流式偏好；每次 hello 重报，顶号时不能漏给下一台。 */
  let peerStreamMode: StreamMode = 'full'

  /** 对端是否能渲染「正文被省略」；默认 false，保守侧是全量发送。 */
  let peerSupportsDetail = false
  /** 档位策略（链路类型算出来的「想怎么发」）。 */
  const tierPolicy = options.transferTier ?? ((): TransferTier => 'full')
  /** 生效档位 = 策略档位 ∧ 对端够新；拿不准一律 full（裁剪是不可见的损失）。 */
  const effectiveTier = (): TransferTier => (peerSupportsDetail ? tierPolicy() : 'full')

  // store-bridge 先建：host-source 的 hello / subscribe 会回头调它（重置流式基准）
  const storeBridge: StoreBridge = createStoreBridge(emit, subscriptions, {
    streamMode: () => peerStreamMode,
    transferTier: effectiveTier,
  })

  const sessionSource = createDesktopHostSource({
    pairing,
    acl,
    audit,
    subscriptions,
    interactions,
    deviceName,
    deviceId,
    appVersion,
    confirmPair: options.confirmPair,
    /* 每次握手都清空流式基准：同一房间可能顶号，已发到第几个字符是针对某个客户端的。 */
    onStreamMode: (mode: StreamMode) => {
      peerStreamMode = mode
      storeBridge.resetStreams()
    },
    /*
     * 重新订阅要重置该会话的流式基准，并补推一次运行时快照：订阅表不是 observable，
     * 只推「变化」的话，订阅那一刻的 error / paused / working 会永远缺席。
     */
    onSubscribe: (sessionId: string) => {
      storeBridge.resetStreams(sessionId)
      storeBridge.pushRuntime(sessionId)
    },
    /** 传输档位：发送侧裁剪，拉取侧同档 */
    transferTier: effectiveTier,
    /* 对端能否渲染省略标记；只在握手成功时报。 */
    onDetailSupport: (supported: boolean) => {
      peerSupportsDetail = supported
    },
    /* 握手结论既开闸门也上报；只有 ok 能开闸，「移除」才真的生效。 */
    onHelloResult: (outcome: HelloOutcome) => {
      if (outcome.ok) authorized = true
      options.onHelloResult?.(outcome)
    },
    onHelloReceived: options.onHelloReceived,
  })

  /*
   * 会话数据源 + 文件接口层合成一份 HostDataSource。两者依赖完全不同，
   * 合成点放在装配层；linkKind 由调用方注入，非中继门槛要看当前链路事实。
   */
  const files: HostFiles = createHostFiles({
    acl,
    audit,
    files: options.fileSystem ?? createTauriFileSystem(),
    resolvePath:
      options.resolvePath ??
      ((input: string, mode: 'r' | 'w', sessionId: string) =>
        securityService.resolveSafePath(input, mode, sessionId)),
    workspaceOf: sessionWorkspaceOf,
    linkKind: options.linkKind,
  })

  const source: HostDataSource = { ...sessionSource, ...files }

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
    emit,
    dispose() {
      // 只拆自建的；注入的表由持有者管
      interactionHost?.dispose()
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
 * 把「链路是否通过 hello」变成硬闸门。用 Proxy 而非逐个方法包：方法集随协议增长，
 * 手写清单迟早漏一个，漏掉的即是不设防的后门。仅豁免 hello 本身。
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
