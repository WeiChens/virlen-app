/**
 * bridge/telemetry —— 电脑侧「通讯层」埋点（§25）。
 *
 * ## 为什么单独一个模块
 *
 * 通讯层的埋点散落在 6 个文件（`index.ts` / `phone-control.ts` / `subscription.ts` /
 * `pairing.ts` / `host-source.ts` / `interaction-registry.ts`）里，若各写各的，
 * **事件名、字段口径、正文截断长度**必然漂移 —— 而「漂移的事件名」等于没法聚合。
 * 所以：
 *   - 事件名只在 `PHONE_EVENTS` 里出现一次（26 条，与 trace 字典一一对应）；
 *   - 载荷摘要（参数白名单 / 正文预览 / 截断长度）只在本文件实现一次；
 *   - 计数器（RPC 次数 / 推送条数 / 丢弃数）也只在这里维护，供 `phone.link.disable`
 *     与 `phone.push.stats` 复用。
 *
 * ## 与既有设施的关系（不新造轮子）
 *
 * 全部走 `utils/telemetry` 的 `track` / `trackPerf`：
 *   - **默认关闭**（`settingsState.telemetryEnabled`），关闭时 `track` 直接 return；
 *   - 采集时自动 `redactDeep`（密钥模式 + `isSensitiveKey` + 用户名路径 → `~`）；
 *   - 本地环形缓冲（5000 条）→ 手动导出 zip，**不上传**。
 *
 * ## 载荷口径（用户 2026-09-29 拍板）
 *
 * **元数据 + 路径 + 正文截断 80 字**。即：正文/命令/提问**会**以 80 字预览进入本地埋点包
 * （便于排查「手机显示的和电脑上的不一致」这类问题），但：
 *   - 一律截断 + 单行化（`previewOf`）；
 *   - 一律经 `redactString`（密钥模式 + 路径脱敏），`track` 采集时还会再兜一层；
 *   - **绝不**记录 `systemPrompt` / `apiKey` / 令牌原文（令牌只记 `hashText`）。
 *
 * ## 关闭时的开销
 *
 * `track()` 本身在关闭时是一次函数调用即返回，但**构造 props 的成本仍在调用方**。
 * 故高频节点（流式帧、ICE 信令、消息推送）都先 `isTelemetryEnabled()` 判断再构造载荷 ——
 * 这是 AGENTS.md §5.8「关闭时零开销」的落地方式。
 */
import {
  BridgeError,
  type Endpoint,
  type HostEmit,
  type SignalingChannel,
  type Transport,
} from 'virlen-remote'
import {
  hashText,
  isTelemetryEnabled,
  redactString,
  toErrorInfo,
  track,
  trackPerf,
} from '@/utils/telemetry'

// ==================== 事件名（唯一真源） ====================

/**
 * 通讯层事件名 —— 命名遵循 AGENTS.md §5.8 的 `域.动作`，域取 `phone`（手机控制通道）。
 *
 * ⚠️ 与 `virlen-trace/src/core/eventDict/phone.ts` **成对维护**：改这里必须同步改字典，
 * 否则 trace 查看器里会退化成「未分类」的通用字段渲染。
 */
export const PHONE_EVENTS = {
  // ── 链路 / 信令（6）──
  linkEnable: 'phone.link.enable',
  linkState: 'phone.link.state',
  linkError: 'phone.link.error',
  linkDisable: 'phone.link.disable',
  signalingPeer: 'phone.signaling.peer',
  signalingData: 'phone.signaling.data',
  // ── RPC 入站（4）──
  rpcCall: 'phone.rpc.call',
  rpcError: 'phone.rpc.error',
  rpcDenied: 'phone.rpc.denied',
  rpcSlow: 'phone.rpc.slow',
  // ── 事件推送（5）──
  pushEvent: 'phone.push.event',
  pushStream: 'phone.push.stream',
  pushDropped: 'phone.push.dropped',
  pushReset: 'phone.push.reset',
  pushStats: 'phone.push.stats',
  // ── 订阅集合（3）──
  subAdd: 'phone.sub.add',
  subRemove: 'phone.sub.remove',
  subClear: 'phone.sub.clear',
  // ── 交互（4）──
  interactionRequested: 'phone.interaction.requested',
  interactionAnswer: 'phone.interaction.answer',
  interactionResolved: 'phone.interaction.resolved',
  interactionExpired: 'phone.interaction.expired',
  // ── 配对（4）──
  pairHello: 'phone.pair.hello',
  pairConfirm: 'phone.pair.confirm',
  pairTicket: 'phone.pair.ticket',
  pairRevoke: 'phone.pair.revoke',
} as const

/** 全部事件名（用例 / 文档对齐用）。 */
export const PHONE_EVENT_NAMES: string[] = Object.values(PHONE_EVENTS)

// ==================== 载荷口径 ====================

/** 正文 / 命令 / 提问的预览长度（用户拍板：80 字）。 */
export const PREVIEW_LEN = 80

/** 慢 RPC 阈值（`phone.rpc.slow`）——「手机上转圈很久」的第一定位点。 */
export const SLOW_RPC_MS = 1000

/** 推送统计的汇总窗口（`phone.push.stats`）。 */
export const PUSH_STATS_INTERVAL_MS = 30_000

/**
 * 正文预览：单行化 + 截断 + 密钥/路径打码。
 *
 * 与 `audit.previewOf` 同样式（单行 + 截断），但**多一道 `redactString`** ——
 * 用户可能把 `sk-xxx` 直接贴在消息里。
 */
export function previewOf(value: unknown, max = PREVIEW_LEN): string | undefined {
  if (typeof value !== 'string') return undefined
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  return redactString(oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine)
}

/** 令牌等敏感短串只记哈希（不可逆、不可回推）。 */
export function tokenHash(value: unknown): string | undefined {
  return typeof value === 'string' && value ? hashText(redactString(value)) : undefined
}

function lengthOf(value: unknown): number | undefined {
  return typeof value === 'string' ? value.length : undefined
}

function tokenPresent(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

/**
 * RPC 参数摘要 —— **白名单**，不是 dump。
 *
 * 为什么不 dump 整个 params：`host.session.create` 这类方法参数里有目录 / 模型 / 标题，
 * 而通用 dump 会随协议演进把新字段（将来可能是敏感字段）自动带进埋点。
 * 白名单让「新增字段」必须显式过一遍这里 —— 代价是多写一行，收益是口径可控。
 *
 * ⚠️ 字段命名需避开 `redact.ts` 的敏感键规则：**以 `token` 结尾的键会被整段打码成 `***`**
 * （如 `has_token`）—— 故这里叫 `token_present`。
 */
export function summarizeParams(method: string, params: unknown): Record<string, unknown> {
  const p = (params ?? {}) as Record<string, any>
  switch (method) {
    case 'host.hello':
      return {
        platform: p.client?.platform,
        client_version: p.client?.appVersion,
        protocol_version: p.protocolVersion,
        capabilities_count: Array.isArray(p.capabilities) ? p.capabilities.length : undefined,
        token_present: tokenPresent(p.token),
      }
    case 'host.session.messages':
      return {
        session_id: p.sessionId,
        from_rowid: p.fromRowid ?? null,
        limit: p.limit ?? null,
      }
    case 'host.session.message.get':
      return { session_id: p.sessionId, message_id: p.messageId }
    case 'host.session.send':
      return {
        session_id: p.sessionId,
        text_len: lengthOf(p.text),
        text: previewOf(p.text),
      }
    case 'host.session.cancel':
    case 'host.session.resume':
    case 'host.session.context':
      return { session_id: p.sessionId }
    case 'host.session.subscribe':
      return { session_id: p.sessionId, from_rowid: p.fromRowid ?? null }
    case 'host.session.create':
      return {
        title: previewOf(p.title),
        workspace: p.workspace ?? null,
        provider_config_id: p.providerConfigId ?? null,
        model_id: p.modelId ?? null,
      }
    case 'host.session.rename':
      return { session_id: p.sessionId, title: previewOf(p.title) }
    case 'host.session.pin':
      return { session_id: p.sessionId, pinned: p.pinned === true }
    case 'host.session.delete':
      return { session_id: p.sessionId, confirm: p.confirm === true }
    case 'host.session.setModel':
      return {
        session_id: p.sessionId,
        provider_config_id: p.providerConfigId,
        model_id: p.modelId,
      }
    case 'host.session.compress':
      return { session_id: p.sessionId, confirm: p.confirm === true }
    case 'host.interaction.answer':
      return {
        interaction_id: p.interactionId,
        action: p.action,
        confirmed: p.confirmed === true,
        // 提问的选择 / 自定义回复：与正文同口径（80 字预览）
        value: previewOf(
          typeof p.value === 'string' ? p.value : JSON.stringify(p.value ?? ''),
        ),
      }
    default:
      return {}
  }
}

// ==================== 计数器（跨节点共享） ====================

interface PhoneCounters {
  rpcTotal: number
  rpcError: number
  pushEvents: number
  pushStreamFrames: number
  pushDropped: number
  subscribed: number
}

const counters: PhoneCounters = {
  rpcTotal: 0,
  rpcError: 0,
  pushEvents: 0,
  pushStreamFrames: 0,
  pushDropped: 0,
  subscribed: 0,
}

/** 当前计数器快照（供 `phone.link.disable` / 用例断言）。 */
export function phoneCounters(): Readonly<PhoneCounters> {
  return { ...counters }
}

/** 订阅数由订阅表回填（它的真相在 `SubscriptionRegistry` 里）。 */
export function setSubscribedCount(n: number): void {
  counters.subscribed = n
}

/** 清空计数器（重新启用链路 / 用例之间）。 */
export function resetPhoneCounters(): void {
  counters.rpcTotal = 0
  counters.rpcError = 0
  counters.pushEvents = 0
  counters.pushStreamFrames = 0
  counters.pushDropped = 0
}

// ==================== 节点①：RPC 入站 ====================

export interface PhoneInstrument {
  dispose(): void
  /** 把累计的推送统计冲出去（`phone.push.stats`），并开新窗口。 */
  flushStats(): void
}

/**
 * 包装 `endpoint.handle`：每次**入站调用**记一条，失败按错误码分类。
 *
 * 为什么包 `handle` 而不是逐个方法埋点：`registerHostHandlers` 注册 19 个方法，
 * 逐个埋点必然漏（新增方法时没人记得加）—— 而这里是**唯一**的派发入口，
 * 且 `ctx` 带 `method` / `requestId`，方法与耗时天然齐全。
 *
 * ⚠️ 必须**先**调用本函数、再 `registerHostHandlers`（否则注册的是未包装的 handler）。
 * ⚠️ 异常**原样抛出**：埋点不得改变协议行为。
 */
export function instrumentPhoneRpc(endpoint: Endpoint): PhoneInstrument {
  const original = endpoint.handle.bind(endpoint)
  endpoint.handle = (method, fn) =>
    original(method, async (params, ctx) => {
      const startedAt = Date.now()
      counters.rpcTotal += 1
      try {
        const data = await fn(params, ctx)
        const durMs = Date.now() - startedAt
        track(PHONE_EVENTS.rpcCall, {
          method,
          status: 'ok',
          dur_ms: durMs,
          ...summarizeParams(method, params),
        })
        if (durMs >= SLOW_RPC_MS) {
          track(PHONE_EVENTS.rpcSlow, { method, dur_ms: durMs })
        }
        return data
      } catch (err) {
        const durMs = Date.now() - startedAt
        const code = err instanceof BridgeError ? err.code : 'E_UNKNOWN'
        counters.rpcError += 1
        track(PHONE_EVENTS.rpcCall, {
          method,
          status: 'error',
          error_code: code,
          dur_ms: durMs,
          ...summarizeParams(method, params),
        })
        if (code === 'E_DENIED') {
          // 能力不匹配（hello 协商与 ACL 不一致）—— 排查「手机点不动」的第一现场
          track(PHONE_EVENTS.rpcDenied, { method, error: toErrorInfo(err).message })
        } else {
          track(PHONE_EVENTS.rpcError, {
            method,
            error_code: code,
            error: toErrorInfo(err).message,
            stack: toErrorInfo(err).stack,
          })
        }
        throw err
      }
    })

  return {
    dispose() {
      // 还原为原型方法（避免实例上残留包装，链路重建时重复套娃）
      delete (endpoint as unknown as { handle?: unknown }).handle
    },
    flushStats() {
      /* RPC 侧没有窗口统计，占位保持接口一致 */
    },
  }
}

// ==================== 节点②：事件推送 ====================

/** 从事件载荷里取会话 id（各 topic 的形状不同，取不到就留空）。 */
function sessionIdOf(payload: unknown): string | undefined {
  const p = payload as { sessionId?: string; interaction?: { sessionId?: string } } | undefined
  return p?.sessionId ?? p?.interaction?.sessionId ?? undefined
}

/** 载荷字节数估算（只用于「推送量」口径，不需要精确）。 */
function bytesOf(payload: unknown): number {
  try {
    return JSON.stringify(payload ?? null)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * 包装出站事件（`endpoint.emit`）—— 通讯层里**最值得埋**的一条通道。
 *
 * 关键点：`Endpoint.emit()` 返回 `boolean`，链路非 `open` 时**返回 false 且静默丢弃**。
 * 这个「推了但没出去」过去在任何地方都看不见，而它正是「手机端界面停在旧状态」的典型成因 ——
 * 故单列 `phone.push.dropped`，并且**不受采样影响**（丢弃是异常，不该被采样掉）。
 *
 * 频率控制：
 *   - `message.stream`（每帧 token）→ `phone.push.stream`，采样 0.1（`trackPerf`）；
 *     §32 起 `text` 只是**本帧载荷**（整段或增量）的 80 字预览，`mode`/`offset` 一并采 ——
 *     「手机端正文错位」这类问题时，要先能看出那一帧到底是整段还是增量。
 *   - 其余 topic → `phone.push.event`（含正文 80 字预览）；
 *   - 每 30s 汇总一条 `phone.push.stats`（条数 / 丢弃数 / 字节），用于判断「手机没反应」
 *     是「电脑没推」还是「推了没渲染」。
 */
export function createTracedEmit(endpoint: Endpoint): HostEmit & PhoneInstrument {
  let windowEvents = 0
  let windowStreamFrames = 0
  let windowDropped = 0
  let windowBytes = 0
  let windowStartedAt = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null

  const flushStats = (): void => {
    if (!windowEvents && !windowStreamFrames && !windowDropped) return
    track(PHONE_EVENTS.pushStats, {
      events: windowEvents,
      stream_frames: windowStreamFrames,
      dropped: windowDropped,
      bytes: windowBytes,
      window_ms: Date.now() - windowStartedAt,
      subscribed: counters.subscribed,
    })
    windowEvents = 0
    windowStreamFrames = 0
    windowDropped = 0
    windowBytes = 0
    windowStartedAt = Date.now()
  }

  const traced = ((topic: string, payload: unknown) => {
    const sent = endpoint.emit(topic, payload)
    const sessionId = sessionIdOf(payload)

    if (!sent) {
      counters.pushDropped += 1
      windowDropped += 1
      // 不受采样影响：这是异常路径
      track(PHONE_EVENTS.pushDropped, {
        topic,
        session_id: sessionId,
        reason: endpoint.transportState === 'open' ? 'not-sent' : 'transport-not-open',
        transport_state: endpoint.transportState,
      })
      return
    }

    // 关闭时零开销：高频通道先判断再构造载荷
    if (!isTelemetryEnabled()) return

    if (topic === 'host.event.message.stream') {
      const e = payload as {
        messageId?: string
        seq?: number
        text?: string
        mode?: string
        offset?: number
        final?: boolean
      }
      counters.pushStreamFrames += 1
      windowStreamFrames += 1
      trackPerf(PHONE_EVENTS.pushStream, {
        session_id: sessionId,
        message_id: e.messageId,
        seq: e.seq,
        // §32：本帧是整段还是增量（`text_len` / `text` 随之只指**本帧**的载荷）
        mode: e.mode,
        offset: e.offset,
        final: e.final === true,
        text_len: lengthOf(e.text),
        text: previewOf(e.text),
      })
      return
    }

    const bytes = bytesOf(payload)
    counters.pushEvents += 1
    windowEvents += 1
    windowBytes += bytes

    if (topic === 'host.event.session.messages.reset') {
      // 窗口重建（压缩 / 删除）——低频但语义重，单列
      track(PHONE_EVENTS.pushReset, { session_id: sessionId })
      return
    }

    track(PHONE_EVENTS.pushEvent, {
      topic,
      session_id: sessionId,
      bytes,
      ...summarizePush(topic, payload),
    })
  }) as HostEmit & PhoneInstrument

  traced.dispose = () => {
    flushStats()
    if (timer) clearInterval(timer)
    timer = null
  }
  traced.flushStats = flushStats

  // 统计窗口只在真的有推送时启动（关闭埋点时绝不挂定时器）
  if (isTelemetryEnabled() && !timer) {
    timer = setInterval(flushStats, PUSH_STATS_INTERVAL_MS)
  }

  return traced
}

/** 推送载荷摘要（同样是白名单：不同 topic 各取自己那几个字段 + 正文预览）。 */
function summarizePush(topic: string, payload: unknown): Record<string, unknown> {
  const p = payload as Record<string, any>
  switch (topic) {
    case 'host.event.session.list.changed':
      return { count: Array.isArray(p?.sessions) ? p.sessions.length : undefined }
    case 'host.event.message.added':
    case 'host.event.message.updated': {
      const m = p?.message ?? {}
      return {
        message_id: m.id,
        role: m.role,
        streaming: m.streaming === true,
        text_len: lengthOf(m.text),
        text: previewOf(m.text),
        tool_name: m.toolName,
      }
    }
    case 'host.event.session.runtime.changed':
      return {
        working: p?.runtime?.working === true,
        paused: p?.runtime?.paused === true,
        compacting: p?.runtime?.compacting === true,
        error: previewOf(p?.runtime?.error),
        // 工具参数生成进度（§27）：`name:chars` 一行看完，便于对照「空窗期到底在干什么」
        tool_progress: p?.runtime?.toolProgress
          ? `${p.runtime.toolProgress.name}:${p.runtime.toolProgress.chars}`
          : undefined,
      }
    case 'host.event.session.context.changed':
      return { tokens: p?.context?.tokens ?? null, window_tokens: p?.context?.windowTokens }
    case 'host.event.interaction.requested':
      return {
        interaction_id: p?.interaction?.interactionId,
        kind: p?.interaction?.kind,
        tier: p?.interaction?.tier,
        presentation: p?.interaction?.presentation,
        question: previewOf(p?.interaction?.question),
        command: previewOf(p?.interaction?.command ?? p?.interaction?.desc),
      }
    case 'host.event.interaction.resolved':
      return { interaction_id: p?.interactionId, by: p?.by, outcome: p?.outcome }
    default:
      return {}
  }
}

// ==================== 节点③：链路 / 信令 ====================

/**
 * 链路状态与错误。
 *
 * `buffered_amount` 一并采：DataChannel 的 `send()` 不阻塞，接收慢时缓冲会静默堆积
 * （`transport/types.ts` 的注释就写了这一点）—— 手机端「消息来得越来越慢」时，
 * 这是唯一能区分「电脑没推」与「链路堵了」的字段。
 */
export function instrumentTransport(transport: Transport): PhoneInstrument {
  let lastState: string = transport.state
  let lastAt = Date.now()

  const offState = transport.onStateChange((state) => {
    const now = Date.now()
    track(PHONE_EVENTS.linkState, {
      from: lastState,
      to: state,
      dur_ms: now - lastAt,
      buffered_amount: transport.bufferedAmount,
    })
    lastState = state
    lastAt = now
  })

  return {
    dispose: offState,
    flushStats() {
      /* 无窗口统计 */
    },
  }
}

/**
 * 信令通道（SSE）埋点。
 *
 * ⚠️ 调用时机：**必须在 `RtcTransport` 构造之后** —— `RtcTransport` 会在构造时接管
 * `onPeer` / `onData`，本函数采用的是「链式包裹」（保留原 handler），抢在它前面挂会把它顶掉。
 *
 * `onData` 是 ICE 候选的必经之路，频率较高 → 采样 0.1，且字段只留类型与字节数。
 */
export function instrumentSignaling(signaling: SignalingChannel): PhoneInstrument {
  const prevPeer = signaling.onPeer
  const prevData = signaling.onData
  const prevError = signaling.onError
  const prevKicked = signaling.onKicked

  signaling.onPeer = (peerId) => {
    track(PHONE_EVENTS.signalingPeer, { event: peerId ? 'joined' : 'left' })
    prevPeer?.(peerId)
  }

  signaling.onData = (data) => {
    // 关闭时零开销：候选列表可能一秒几十条
    if (isTelemetryEnabled()) {
      trackPerf(PHONE_EVENTS.signalingData, {
        kind: (data as { type?: string; candidate?: unknown } | undefined)?.type ?? 'unknown',
        bytes: bytesOf(data),
      })
    }
    prevData?.(data)
  }

  signaling.onError = (error) => {
    // 信令异常（SSE 断开 / join 失败）：链路迟迟不 open 时的第一现场
    traceLinkError(error, { source: 'signaling' })
    prevError?.(error)
  }

  /**
   * 被顶号（M6）：**必须链式包住**，否则埋点会把它吃掉。
   *
   * 电脑端也会被顶 —— 同一设备 key 的新连接接管时（桌面重启/重启用），旧的那条会收到
   * `reason=takeover`。不记这一笔，日志上就只剩「链路莫名其炒 closed」，无从解释。
   */
  signaling.onKicked = (info) => {
    traceLinkError(new Error(`信令：本端被顶号（${info.reason}）`), {
      source: 'signaling',
      kicked: true,
      reason: info.reason,
    })
    prevKicked?.(info)
  }

  return {
    dispose() {
      signaling.onPeer = prevPeer
      signaling.onData = prevData
      signaling.onError = prevError
      signaling.onKicked = prevKicked
    },
    flushStats() {
      /* 无窗口统计 */
    },
  }
}

/** 链路启用（含信令基址 host，**不记完整 URL 的 query**）。 */
export function traceLinkEnable(props: {
  roomHash: string
  signalHost: string
  iceCount: number
  /**
   * ICE 来源（`custom` / `remote` / `cache` / `stale-cache` / `none`）——
   * 真机上「连不上」时先看这一项：是用户自己填的、服务端下发的，还是根本没有（§31）。
   */
  iceSource: string
  mode: string
}): void {
  resetPhoneCounters()
  track(PHONE_EVENTS.linkEnable, {
    room_hash: props.roomHash,
    signal_host: props.signalHost,
    ice_count: props.iceCount,
    ice_source: props.iceSource,
    mode: props.mode,
  })
}

/** 链路停用（带上本段链路的累计量，便于「这轮到底传了多少」）。 */
export function traceLinkDisable(props: { reason: string; uptimeMs: number }): void {
  track(PHONE_EVENTS.linkDisable, {
    reason: props.reason,
    uptime_ms: props.uptimeMs,
    ...phoneCounters(),
  })
}

/** 传输层错误（RTC 的 `onError` 不在 `Transport` 接口上，调用方按实现类型挂）。 */
export function traceLinkError(error: unknown, extra?: Record<string, unknown>): void {
  const info = toErrorInfo(error)
  track(PHONE_EVENTS.linkError, {
    error: info.message,
    stack: info.stack,
    ...(extra ?? {}),
  })
}
