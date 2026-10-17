/**
 * 电脑侧通讯层埋点：事件名、载荷摘要、计数器都在这里唯一实现，避免六个调用方各自漂移。
 *
 * 走 utils/telemetry（默认关，自动 redact，本地环形缓冲，不上传）。
 * 载荷口径：元数据 + 路径 + 正文截断 80 字；不记 systemPrompt / apiKey / 令牌原文（只记 hash）。
 * 关闭时零开销：高频节点先 isTelemetryEnabled() 再构造载荷。
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

// 事件名（唯一真源）

/**
 * 通讯层事件名（域取 phone），与 virlen-trace 的 phone.ts 字典成对维护。
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

/** 全部事件名（用例 / 文档对齐用） */
export const PHONE_EVENT_NAMES: string[] = Object.values(PHONE_EVENTS)

// 载荷口径

/** 正文 / 命令 / 提问的预览长度 */
export const PREVIEW_LEN = 80

/** 慢 RPC 阈值（「手机上转圈很久」的第一定位点） */
export const SLOW_RPC_MS = 1000

/** 推送统计的汇总窗口 */
export const PUSH_STATS_INTERVAL_MS = 30_000

/**
 * 正文预览：单行化 + 截断 + 密钥 / 路径打码（用户可能把 sk-xxx 直接贴在消息里）。
 */
export function previewOf(value: unknown, max = PREVIEW_LEN): string | undefined {
  if (typeof value !== 'string') return undefined
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  return redactString(oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine)
}

/** 令牌等敏感短串只记哈希 */
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
 * RPC 参数摘要 —— 白名单而非 dump：dump 会把新增（可能敏感的）字段自动带进埋点。
 * 注意键名以 token 结尾会被脱敏，所以用 token_present。
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
        // 提问的选择 / 自定义回复：与正文同口径
        value: previewOf(
          typeof p.value === 'string' ? p.value : JSON.stringify(p.value ?? ''),
        ),
      }
    default:
      return {}
  }
}

// 计数器（跨节点共享）

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

/** 当前计数器快照 */
export function phoneCounters(): Readonly<PhoneCounters> {
  return { ...counters }
}

/** 订阅数由订阅表回填 */
export function setSubscribedCount(n: number): void {
  counters.subscribed = n
}

/** 清空计数器 */
export function resetPhoneCounters(): void {
  counters.rpcTotal = 0
  counters.rpcError = 0
  counters.pushEvents = 0
  counters.pushStreamFrames = 0
  counters.pushDropped = 0
}

// 节点①：RPC 入站

export interface PhoneInstrument {
  dispose(): void
  /** 把累计的推送统计冲出去，并开新窗口 */
  flushStats(): void
}

/**
 * 包装 endpoint.handle：入站调用统一埋点，失败按错误码分类。
 *
 * 包 handle 而非逐方法埋点：注册 19 个方法，逐个埋必漏，而这里是唯一的派发入口。
 * ⚠️ 必须先调用本函数再 registerHostHandlers；异常原样抛出，埋点不改变协议行为。
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

// 节点②：事件推送

/** 从事件载荷里取会话 id */
function sessionIdOf(payload: unknown): string | undefined {
  const p = payload as { sessionId?: string; interaction?: { sessionId?: string } } | undefined
  return p?.sessionId ?? p?.interaction?.sessionId ?? undefined
}

/** 载荷字节数估算 */
function bytesOf(payload: unknown): number {
  try {
    return JSON.stringify(payload ?? null)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * 包装出站事件 endpoint.emit。关键：emit 在链路非 open 时返回 false 并静默丢弃，
 * 单列为 phone.push.dropped 且不受采样影响（丢弃是异常）。
 *
 * message.stream 每帧采样 0.1；其余 topic 记 80 字预览；每 30s 汇总一条 stats。
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
        // 本帧是整段还是增量（text_len / text 只指本帧载荷）
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
      // 窗口重建（压缩 / 删除）——低频但语义重
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

/** 推送载荷摘要（白名单：不同 topic 各取自己的字段） */
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
        // 工具参数生成进度：name:chars 一行看完
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

// 节点③：链路 / 信令

/**
 * 链路状态与错误。buffered_amount 一并采：DataChannel 的 send 不阻塞，接收慢时缓冲会静默堆积，
 * 这是区分「电脑没推」与「链路堵了」的唯一字段。
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
 * ⚠️ 必须在 RtcTransport 构造之后：它构造时接管 onPeer / onData，本函数是链式包裹。
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
  /** 被顶号：必须链式包住，否则埋点会把它吃掉。同一设备 key 的新连接接管时，旧链路会收到 reason=takeover。 */
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

/** 链路启用（含信令 host，不记完整 URL） */
export function traceLinkEnable(props: {
  roomHash: string
  signalHost: string
  iceCount: number
  /** ICE 来源（custom / remote / cache / stale-cache / none）：真机「连不上」时先看这一项 */
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

/** 链路停用（带本段链路的累计量） */
export function traceLinkDisable(props: { reason: string; uptimeMs: number }): void {
  track(PHONE_EVENTS.linkDisable, {
    reason: props.reason,
    uptime_ms: props.uptimeMs,
    ...phoneCounters(),
  })
}

/** 传输层错误（RTC 的 onError 不在 Transport 接口上，按实现类型挂） */
export function traceLinkError(error: unknown, extra?: Record<string, unknown>): void {
  const info = toErrorInfo(error)
  track(PHONE_EVENTS.linkError, {
    error: info.message,
    stack: info.stack,
    ...(extra ?? {}),
  })
}
