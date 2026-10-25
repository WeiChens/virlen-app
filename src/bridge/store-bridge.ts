/**
 * 用 mobx reaction 旁路订阅本机 store，把变化推给手机。
 *
 * 不在 flow / event-handler 逐点上报：变更点太多必漏，在 store 侧 diff 才不漏。
 * 三条通道：会话列表恒推；消息与运行时仅推已订阅会话（未订阅不外发一个字节）。
 * 流式：生成中只走 message.stream，定稿后再作为 message.added 补发完整消息。
 *
 * ⚠️ 流式数据源是 store 里 streaming===true 的那条消息，不是 sessionRuntimeState.streamingMessageId
 * （Rust stream_event 不带 messageId，据此取值会导致一帧都发不出去）。
 */
import { reaction, type IReactionDisposer } from 'mobx'
import type { HostEmit, StreamMode, TransferTier } from 'virlen-remote'
import type { Message } from '@/types'
import { sessionRuntimeState, sessionStore, settingsState } from '@/ui/store'
import { contextWindowOf, pickContextTokens, toContextInfo } from '@/domain/usage/context-occupancy'
import {
  buildToolCallIndex,
  isTransferableMessage,
  projectContentToText,
  toMessageDTO,
  toRuntimeDTO,
  toSessionSummaryDTO,
} from './dto'
import type { SubscriptionRegistry } from './subscription'

/**
 * 会话列表指纹：直接用投影后的 DTO（手写字段列表新增字段时必漏）。
 */
function listFingerprint(): string {
  return sessionStore.value.sessions.map((s) => JSON.stringify(toSessionSummaryDTO(s))).join('\u0002')
}

/**
 * ⚠️ 所有指纹函数都必须无条件读取底层 observable（即使未订阅），只把订阅中的纳入输出。
 * MobX 只跟踪推导函数实际读到的 observable，跳过读取会导致之后的变化收不到推送。
 */

/** 消息指纹（用剥离后的纯文本，避免 base64 把指纹撑爆）。 */
function messageFingerprint(subscriptions: SubscriptionRegistry): string {
  const parts: string[] = []
  for (const s of sessionStore.value.sessions) {
    const subscribed = subscriptions.has(s.id)
    const messages = s.messages // 始终读取（建立跟踪）
    for (const m of messages) {
      // 未订阅也要轻触消息字段以保持跟踪；toolCalls / toolCallId / isError 必须一起读，
      // 否则工具名与入参回填、错误标记变化都收不到
      const meta = `${s.id}\u0001${m.id}\u0001${m.streaming ? 1 : 0}\u0001${m.toolCalls?.length ?? 0}\u0001${m.toolCallId ?? ''}\u0001${m.isError ? 1 : 0}`
      if (!subscribed) continue
      /*
       * 流式正文不进指纹：它是每秒几十次变化的正文，而 `diffMessages` 本来就跳过它
       *（正文增量由 `pushStream` 单独推）。拼进去就是每个 token 重建一份「全会话正文」——
       * 开销与会话总字数成正比。`streaming` 标志本身仍在 meta 里：定稿那一刻指纹必变，
       * 定稿后的全文会在下一轮被读到并下发。
       */
      if (m.streaming) {
        parts.push(`${meta}\u0001${m.role}\u0001-`)
        continue
      }
      parts.push(`${meta}\u0001${m.role}\u0001${projectContentToText(m.content)}`)
    }
  }
  return parts.join('\u0003')
}

/**
 * 运行时指纹。执行中的工具是派生投影，所以直接拿即将推送的 DTO 当指纹（推什么就看什么）。
 * 它只读 role / toolCallId / toolCalls，不读正文 —— 否则每个流式 token 都会唤起它。
 */
function runtimeFingerprint(subscriptions: SubscriptionRegistry): string {
  const parts: string[] = []
  const sessions = sessionRuntimeState.value.sessions
  for (const id of Object.keys(sessions)) {
    const rt = sessions[id]
    if (!rt) continue
    // 始终读取字段（建立跟踪），仅订阅者纳入输出
    const sig = `${id}\u0001${rt.working ? 1 : 0}\u0001${rt.paused ? 1 : 0}\u0001${rt.error ?? ''}\u0001${rt.compacting ? 1 : 0}\u0001${rt.toolProgress ? `${rt.toolProgress.name}:${rt.toolProgress.chars}` : '-'}\u0001${runningToolsSignature(id)}`
    if (subscriptions.has(id)) parts.push(sig)
  }
  return parts.join('\u0002')
}

/** 「执行中的工具」指纹串（直接取即将下发的投影）。 */
function runningToolsSignature(sessionId: string): string {
  const tools = toRuntimeDTO(sessionId).runningTools
  if (!tools || tools.length === 0) return '-'
  return tools.map((t) => `${t.toolCallId}\u0001${t.name}\u0001${t.args ?? ''}`).join('\u0003')
}

/**
 * 正在生成的那条消息（store 里 streaming===true 的最后一条）。从尾部扫：通常一次命中。
 */
function streamingOf(messages: readonly Message[]): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].streaming) {
      return { id: messages[i].id, text: projectContentToText(messages[i].content) }
    }
  }
  return null
}

/**
 * 流式指纹：无条件读取以建立跟踪，只把订阅中的纳入，否则中途订阅会丢帧。
 */
function streamFingerprint(subscriptions: SubscriptionRegistry): string {
  const parts: string[] = []
  for (const s of sessionStore.value.sessions) {
    const messages = s.messages // 始终读取（建立跟踪）
    const live = streamingOf(messages) // 无条件计算（建立内容跟踪）
    if (!subscriptions.has(s.id)) continue
    parts.push(live ? `${s.id}\u0001${live.id}\u0001${live.text}` : `${s.id}\u0001-`)
  }
  return parts.join('\u0002')
}

/** 上下文占用指纹；窗口大小也进指纹（改设置后比例要跟着变）。 */
function contextFingerprint(subscriptions: SubscriptionRegistry): string {
  const windowTokens = contextWindowOf(settingsState.value.contextWindowTokens)
  const parts: string[] = []
  for (const s of sessionStore.value.sessions) {
    const messages = s.messages // 始终读取（建立跟踪）
    const tokens = pickContextTokens(messages) // 无条件计算（建立跟踪）
    if (!subscriptions.has(s.id)) continue
    parts.push(`${s.id}\u0001${tokens ?? '-'}`)
  }
  return `${windowTokens}\u0003${parts.join('\u0002')}`
}

export interface StoreBridge {
  dispose(): void
  /**
   * 清空流式基准（不传 = 全部）。新客户端接入 / 重新订阅时必须调，否则增量 offset 对不上。
   */
  resetStreams(sessionId?: string): void
  /**
   * 补推一次运行时快照（订阅 / 重订阅时）。订阅表是普通 Set，订阅本身不触发 reaction，
   * 不补发的话订阅那一刻的 error / paused / working 永远不会到达手机。
   * 报文与变化推送完全一致，手机端无需区分。
   */
  pushRuntime(sessionId?: string): void
}

export interface StoreBridgeOptions {
  /**
   * 手机声明的流式偏好（hello.streamMode）。默认 full —— 服务端不猜：旧客户端会把增量当全文。
   * 传函数因为顶号后声明会变。
   */
  streamMode?: () => StreamMode
  /**
   * 当前生效的传输档位；传函数因为链路类型会变。调用方已把「对端能否渲染省略」合进来。
   */
  transferTier?: () => TransferTier
}

export function createStoreBridge(
  emit: HostEmit,
  subscriptions: SubscriptionRegistry,
  options: StoreBridgeOptions = {},
): StoreBridge {
  /** 已发出的消息快照：sessionId → (messageId → DTO 序列化) */
  const emitted = new Map<string, Map<string, string>>()
  /** 流式进度：sent = 已下发的正文（增量基准） */
  const streaming = new Map<string, { messageId: string; seq: number; sent: string }>()
  const streamMode = options.streamMode ?? ((): StreamMode => 'full')
  const transferTier = options.transferTier ?? ((): TransferTier => 'full')

  function diffMessages(): void {
    /*
     * 一次 diff 只读一次档位：批内不许出现一半精简一半完整。
     */
    const tier = transferTier()
    for (const s of sessionStore.value.sessions) {
      if (!subscriptions.has(s.id)) continue
      let map = emitted.get(s.id)
      if (!map) {
        map = new Map()
        emitted.set(s.id, map)
      }
      const seen = new Set<string>()
      // 工具名 / 入参索引：每会话整窗构建一次
      const toolCalls = buildToolCallIndex(s.messages)
      for (const m of s.messages) {
        // 流式中的消息内容走 stream 通道，定稿后再走消息通道
        if (m.streaming) continue
        // 工具注入的图片消息（vision_image）不发手机：电脑端自己都不渲染它
        if (!isTransferableMessage(m)) continue
        seen.add(m.id)
        /*
         * 变更检测用完整投影，发送用档位投影：若把档位投影存进快照，切到精简档时
         * 「别的消息变化引起的整会话 diff」会抹掉已收到的正文。快照永远存与档位无关的完整投影。
         */
        const full = toMessageDTO(m, toolCalls, 'full', { sessionId: s.id })
        const json = JSON.stringify(full)
        const payload = tier === 'lean' ? toMessageDTO(m, toolCalls, 'lean', { sessionId: s.id }) : full
        const prev = map.get(m.id)
        if (prev === undefined) {
          map.set(m.id, json)
          emit('host.event.message.added', { sessionId: s.id, message: payload })
        } else if (prev !== json) {
          map.set(m.id, json)
          emit('host.event.message.updated', { sessionId: s.id, message: payload })
        }
      }
      /**
       * 被删除 / 替换的消息：清出快照并让手机重拉窗口（压缩会把整段历史换成一条 summary，
       * 逐条 diff 已无法表达；重拉天然幂等）。
       */
      let removed = false
      for (const id of [...map.keys()]) {
        if (!seen.has(id)) {
          map.delete(id)
          removed = true
        }
      }
      if (removed) emit('host.event.session.messages.reset', { sessionId: s.id })
    }
  }

  function pushStream(): void {
    // 每次推送都读最新声明：顶号后新手机可能把偏好改成 full
    const deltaEnabled = streamMode() === 'delta'
    for (const id of subscriptions.snapshot()) {
      const messages = sessionStore.getSession(id)?.messages ?? []
      const live = streamingOf(messages)
      const prev = streaming.get(id)
      if (live) {
        // 只有同一 messageId 的上一次才谈得上增量（换消息 = 新基准）
        const prevSent = prev && prev.messageId === live.id ? prev.sent : null
        const sameMessage = prevSent !== null
        if (sameMessage && prevSent === live.text) continue
        const seq = prev && sameMessage ? prev.seq + 1 : 1
        /**
         * 增量只在「新正文以已发出的正文为前缀」时成立；定稿回填 / 修复会改写正文，
         * 此时后缀是错的，必须发整段。
         */
        const appendOnly = deltaEnabled && prevSent !== null && live.text.startsWith(prevSent)
        emit('host.event.message.stream', {
          sessionId: id,
          messageId: live.id,
          seq,
          mode: appendOnly ? 'delta' : 'full',
          text: appendOnly ? live.text.slice(prevSent.length) : live.text,
          // 偏移 = 本段之前的长度（客户端据此剪重复 / 补尾巴 / 发现缺口）
          ...(appendOnly ? { offset: prevSent.length } : {}),
          final: false,
        })
        streaming.set(id, { messageId: live.id, seq, sent: live.text })
      } else if (prev) {
        streaming.delete(id)
        // 收尾帧发定稿全文：最后一次增量可能未成帧，定稿也可能被回填改写
        const settled = messages.find((m) => m.id === prev.messageId)
        emit('host.event.message.stream', {
          sessionId: id,
          messageId: prev.messageId,
          seq: prev.seq + 1,
          mode: 'full',
          text: settled ? projectContentToText(settled.content) : prev.sent,
          final: true,
        })
      }
    }
  }

  const disposeList = reaction(
    () => listFingerprint(),
    () => {
      emit('host.event.session.list.changed', {
        sessions: sessionStore.listSessions().map(toSessionSummaryDTO),
      })
    },
  )

  const disposeMessages = reaction(
    () => messageFingerprint(subscriptions),
    () => diffMessages(),
  )

  /**
   * 推一次运行时快照（订阅 / 重订阅时补发）。报文形状必须与变化推送一致。
   */
  function pushRuntime(sessionId?: string): void {
    const ids = sessionId ? [sessionId] : subscriptions.snapshot()
    for (const id of ids) {
      // 与其它通道同一道订阅门：未订阅的会话不外发
      if (!subscriptions.has(id)) continue
      emit('host.event.session.runtime.changed', { sessionId: id, runtime: toRuntimeDTO(id) })
    }
  }

  const disposeRuntime = reaction(
    () => runtimeFingerprint(subscriptions),
    () => pushRuntime(),
  )

  const disposeStream = reaction(
    () => streamFingerprint(subscriptions),
    () => pushStream(),
  )

  /** 上下文占用变化：按订阅集合推送，由定稿消息的 usage 驱动，不是高频通道。 */
  const disposeContext = reaction(
    () => contextFingerprint(subscriptions),
    () => {
      const windowTokens = settingsState.value.contextWindowTokens
      for (const id of subscriptions.snapshot()) {
        emit('host.event.session.context.changed', {
          sessionId: id,
          context: toContextInfo(sessionStore.getSession(id)?.messages ?? [], windowTokens),
        })
      }
    },
  )

  const disposers: IReactionDisposer[] = [
    disposeList,
    disposeMessages,
    disposeRuntime,
    disposeStream,
    disposeContext,
  ]
  return {
    dispose() {
      for (const d of disposers) d()
      emitted.clear()
      streaming.clear()
    },
    resetStreams(sessionId) {
      if (sessionId) streaming.delete(sessionId)
      else streaming.clear()
    },
    pushRuntime,
  }
}
