/**
 * store-bridge —— 用 mobx `reaction` **旁路订阅**本机 store，把变化推给手机。
 *
 * ⚠️ **为什么不用「在 flow / event-handler 里逐点上报」**（见 docs/phone-control-bridge.md §4.1）：
 * `chat-service` 里「消息变化」有多个变更点（addSessionMessage / updateSessionMessage / 批量替换 /
 * 修复回填…），`working` 也有 5+ 处（发送 / 恢复 / 取消 / finishWorking…）——
 * **逐点上报必然漏**（tray-service.ts 的注释已经因此改用 reaction）。
 * 手机推送面更大，同样结论：**在 store 侧做 diff，是唯一不漏的姿势**。
 *
 * 三条推送通道：
 * 1. `session.list.changed` —— **恒推**（拍板：全部会话推手机）；
 * 2. `message.added/updated` + `message.stream` + `messages.reset` —— **仅推「已订阅」会话**（手机打开过的）；
 * 3. `session.runtime.changed` + `session.context.changed` —— 仅推「已订阅」会话。
 *
 * ⚠️ **变化之外还得有一次「现值」**：本模块全部靠 reaction 推变化，而订阅本身不触发 reaction
 * （`SubscriptionRegistry` 是普通 Set）—— 所以「订阅那一刻的运行时状态」必须由调用方
 * （`host-source` 的 subscribe / create 路径）显式补一次 `pushRuntime(sessionId)`。
 * 少了这一帧，手机打开一个「在它没看的时候出过错」的会话时，错误原因根本不会出现。
 *
 * 流式策略（§3.6 / §32）：正在生成的那条消息**只走 `message.stream`**，
 * 定稿后再作为 `message.added` 补发一条完整消息 —— 于是消息通道天然幂等，不必处理中间态。
 *
 * **一期每帧发整段正文（O(n²) 字节）；二期（2026-09-30）改为按客户端声明发增量。**
 * 何时发增量：客户端在 `hello` 里声明 `streamMode:'delta'`（`createStoreBridge` 的 `streamMode` 读它），
 * 且「新正文以**已发出的正文**为前缀」—— 首帧、正文被改写、`final` 收尾帧一律发整段。
 * 带宽差一个量级（一条 n 字回复：O(n²) → O(n)），而报文形状多了一个 `offset` 用于客户端对齐。
 *
 * **§33 传输档位**：精简档（TURN 中继 / 链路类型未判定）下，`role:'tool'` 的**输出正文**不下发
 * （带 `MessageDTO.detail='omitted'`），只保留工具名 —— 工具输出是手机上最大的一笔流量。
 * 档位从 `transferTier()` 读（调用方已把「对端能不能渲染省略标记」合进去了），
 * 且**只影响下一次发什么**：快照存的是与档位无关的完整投影，所以档位变化本身不发任何事件
 * （拍板的「不补发」，也让「切档位」不会把手机上已有的正文抹掉）。
 *
 * ⚠️ 流式的**数据源是 store 里那条 `streaming === true` 的消息**，不是
 * `sessionRuntimeState.streamingMessageId`（2026-09-28 真机缺陷根因，§22.4）：Rust 引擎的
 * `stream_event` 只带 `{delta}`（不带 `messageId`，见 `agent/llm_round.rs::flush_stream_state`），
 * 而 `event-handler` 过去会据此把 `streamingMessageId` 写成 `null` → 流式帧一帧都发不出去，
 * 手机端只剩「工作中…」的加载态。现在改读 store 里正在流式的那条消息
 * （与桌面 UI 同一个真相），谁忘了维护运行时字段都影响不到这条通道。
 */
import { reaction, type IReactionDisposer } from 'mobx'
import type { HostEmit, StreamMode, TransferTier } from 'virlen-remote'
import type { Message } from '@/types'
import { sessionRuntimeState, sessionStore, settingsState } from '@/ui/store'
import { contextWindowOf, pickContextTokens, toContextInfo } from '@/domain/usage/context-occupancy'
import {
  buildToolCallIndex,
  projectContentToText,
  toMessageDTO,
  toRuntimeDTO,
  toSessionSummaryDTO,
} from './dto'
import type { SubscriptionRegistry } from './subscription'

/**
 * 会话列表指纹 —— **直接用投影后的 DTO**（而不是手写字段列表）。
 *
 * 为什么改成这样：手写字段列表在新增字段时必然漏（§22 新加了 agent / workspace / model，
 * 漏一个就是「切换了模型但手机不刷新」），而 DTO 指纹天然「推什么就看什么」。
 */
function listFingerprint(): string {
  return sessionStore.value.sessions.map((s) => JSON.stringify(toSessionSummaryDTO(s))).join('\u0002')
}

/**
 * ⚠️ 所有指纹函数都必须**无条件读取底层 observable**（即使该会话未订阅），只把「订阅中的」纳入输出串。
 * 原因：MobX `reaction` 只跟踪「推导函数**实际读到**的 observable」。若在未订阅时 `continue` 跳过读取，
 * reaction 就从未跟踪到 `s.messages` / `rt.working` —— 之后这些值变化也不会触发推送。
 * 这类 bug 在单测里是「事件永远不来」，在生产里是「手机静默不同步」，务必保持该写法。
 */

/** 消息指纹（用剥离后的纯文本，避免 base64 图片把指纹撑爆）。 */
function messageFingerprint(subscriptions: SubscriptionRegistry): string {
  const parts: string[] = []
  for (const s of sessionStore.value.sessions) {
    const subscribed = subscriptions.has(s.id)
    const messages = s.messages // 始终读取（建立跟踪）
    for (const m of messages) {
      // 未订阅也要「轻触」消息字段，保证跟踪持续（内容读取较重，仅订阅时读）
      // ⚠️ `toolCalls` / `toolCallId` 必须一起读：工具名与入参摘要靠它们解析（`buildToolCallIndex`），
      // 两者都在调用后被回填（finalize 才带上 tool_calls），漏读就会出现「手机永远没有工具名 / 入参」。
      const meta = `${s.id}\u0001${m.id}\u0001${m.streaming ? 1 : 0}\u0001${m.toolCalls?.length ?? 0}\u0001${m.toolCallId ?? ''}`
      if (!subscribed) continue
      parts.push(`${meta}\u0001${m.role}\u0001${projectContentToText(m.content)}`)
    }
  }
  return parts.join('\u0003')
}

/**
 * 运行时指纹（working / paused / error / compacting / 工具进度 / 执行中的工具）。
 *
 * ⚠️ 「执行中的工具」不能只看 `sessionRuntimeState`：它不是某个字段，而是一个**派生投影**
 * （`toRuntimeDTO → runningToolsOf`，从消息里的声明与结果算出来）—— 所以这里直接拿
 * **即将推送的那份 DTO** 当指纹（与 `listFingerprint` 同一条做法：推什么就看什么，
 * 新增字段时不会漏）。
 *
 * ⚠️ 这一步在 reaction 推导里跑，而它现在会读到 `s.messages`：
 * `runningToolsOf` 只读 `role` / `toolCallId` / `toolCalls` 三个字段，**不读正文** ——
 * 这是故意的：读正文会让每一个流式 token 都把这个 reaction 唤起来（而它算出的结果一个字都不会变）。
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

/** 「执行中的工具」的指纹串 —— 直接取即将下发的那份投影（推什么就看什么）。 */
function runningToolsSignature(sessionId: string): string {
  const tools = toRuntimeDTO(sessionId).runningTools
  if (!tools || tools.length === 0) return '-'
  return tools.map((t) => `${t.toolCallId}\u0001${t.name}\u0001${t.args ?? ''}`).join('\u0003')
}

/**
 * 正在生成中的那条消息（store 里 `streaming === true` 的最后一条）。
 *
 * 从尾部往前扫：流式消息总是最后一条（多轮工具调用时是「本轮」那条），通常一次命中。
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
 * 流式指纹（正在流式的那条消息的 id + 当前全文）。
 *
 * ⚠️ 与其它指纹同样的写法：**无条件读取**（建立跟踪），只把「订阅中的」纳入输出串。
 * 否则「手机在流式中途才订阅」时，内容变化不会被跟踪 → 流式帧会一直静默到定稿。
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

/**
 * 上下文占用指纹（口径与桌面 token 环同源，`domain/usage/context-occupancy`）。
 *
 * 窗口大小也进指纹：改设置后手机端显示的比例要跟着变。
 */
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
   * 清空流式基准（不传 = 全部会话）。
   *
   * ⚠️ **必须在新客户端接入 / 重新订阅时调**：增量帧的基准（「已发到第几个字符」）是**针对某个
   * 客户端**的，而手机重连、切回会话都会让它手上的正文从头算。沿用旧基准的具体后果是
   * 客户端收到一个 `offset` 对不上的增量 —— 轻则触发一次冗余的拉全文，重则静默错位。
   */
  resetStreams(sessionId?: string): void
  /**
   * **补推一次运行时快照**（不传 = 全部已订阅会话）。
   *
   * 为什么必需：本模块的四条通道都靠 mobx `reaction` 推「变化」，而订阅登记表是**普通 Set
   * （非 observable）** —— 订阅本身不触发任何 reaction。于是「订阅那一刻的现值」永远不会到达
   * 手机：出错（`error`）、暂停（`paused`）、正在压缩（`compacting`）、甚至 `working` 的初值
   * 全部缺席，直到下一次运行时变化才补上。手机打开一个「在它没看的时候出过错 / 被暂存过」的
   * 会话时，看到的就是一个没有任何解释的空会话（2026-10 真机反馈：电脑端会话报错，
   * 手机端连错误原因都看不到）。
   *
   * ⚠️ 调用方必须确保该会话**已在订阅集合里**（本方法与其它通道走同一道门，未订阅的不外发）。
   * 报文形状与变化推送**完全一致**（同一个 `toRuntimeDTO`）：手机端不需要区分
   * 「这是快照还是变化」—— 缺字段即代表电脑侧那边已经没有这个状态（如错误已被清掉）。
   */
  pushRuntime(sessionId?: string): void
}

export interface StoreBridgeOptions {
  /**
   * 手机声明的流式偏好（`hello.streamMode`，§32）。默认 `'full'` —— **服务端不猜**：
   * 旧客户端会把一帧增量当成全文渲染，那就不是带宽问题而是正文错位。
   *
   * 传函数而不是值：同一条链路可能先后接入不同手机（顶号），读时取最新声明。
   */
  streamMode?: () => StreamMode
  /**
   * 当前**传输档位**（§33）—— 精简档下工具输出正文不下发。默认 `() => 'full'`（旧行为）。
   *
   * 传函数而不是值（与 `streamMode` 同理）：档位由**链路类型**决定，而链路类型是会变的
   * （刚打通时可能是中继，打洞成功后换成直连）—— 每次推送都重读，才能让档位立刻跟上。
   *
   * ⚠️ 调用方（`startPhoneBridge`）传进来的是**生效档位**：它已经把「对端是否声明了能渲染
   * 省略标记」合进去了（见 `MESSAGE_DETAIL_CAPABILITY`）。本模块不再自己判断 ——
   * 档位的唯一口径在共享包。
   */
  transferTier?: () => TransferTier
}

export function createStoreBridge(
  emit: HostEmit,
  subscriptions: SubscriptionRegistry,
  options: StoreBridgeOptions = {},
): StoreBridge {
  /** 已发出的消息快照：sessionId → (messageId → DTO 序列化)。 */
  const emitted = new Map<string, Map<string, string>>()
  /** 流式进度：sessionId → { messageId, seq, sent }（`sent` = 已下发的正文，即增量基准）。 */
  const streaming = new Map<string, { messageId: string; seq: number; sent: string }>()
  const streamMode = options.streamMode ?? ((): StreamMode => 'full')
  const transferTier = options.transferTier ?? ((): TransferTier => 'full')

  function diffMessages(): void {
    /*
     * 一次 diff 只读一次档位：批内不许出现「一半精简一半完整」
     * （档位会在两次 emit 之间被巡检改写，读两次就可能新旧混着发）。
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
      // 工具名 / 入参索引：每会话整窗构建一次（与手机端「拿不到名字就只显示工具」一致）
      const toolCalls = buildToolCallIndex(s.messages)
      for (const m of s.messages) {
        // 流式中的消息：内容走 stream 通道，定稿（streaming=false）后再走消息通道
        if (m.streaming) continue
        seen.add(m.id)
        /*
         * ⚠️ **变更检测用完整投影，发送用档位投影**：两件事必须分开。
         *
         * 若把档位投影的结果直接存进快照，就会有一个很难查的后果：「切到精简档」本身会把
         * 手机上**已经收到的正文**抹掉 —— 触发点还是**别的消息**变化引起的整会话 diff
         * （本函数每次都会跑过会话里全部消息）：用户读到一半的工具输出，会因为另一条消息
         * 定稿而静默变成「已省略」。档位变化只能影响「下一次发什么」，不能改写已发出的事实。
         *
         * 于是快照里永远是**与档位无关**的完整投影：档位变化本身一个事件都不发
         * （拍板的「不补发」就是这么落地的）。
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
       * 被删除 / 被替换的消息：清出快照，并让手机**重拉窗口**。
       *
       * 为什么不能继续「静默丢掉」：压缩（`compressContext`）会把整段历史换成一条 summary，
       * 此时逐条 diff 已无法表达（手机侧的旧消息全成了幽灵消息，用户看不到自己已经压缩过）。
       * 删除单条消息同理 —— 不发明 `message.removed` 的增量协议，重拉快照天然幂等（§3.5 同思路）。
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
    // 每次推送都读最新声明：顶号后新手机可能把偏好改成 `full`
    const deltaEnabled = streamMode() === 'delta'
    for (const id of subscriptions.snapshot()) {
      const messages = sessionStore.getSession(id)?.messages ?? []
      const live = streamingOf(messages)
      const prev = streaming.get(id)
      if (live) {
        // 与**同一个 messageId** 的上一次才谈得上增量（换消息 = 新基准）
        const prevSent = prev && prev.messageId === live.id ? prev.sent : null
        const sameMessage = prevSent !== null
        if (sameMessage && prevSent === live.text) continue
        const seq = prev && sameMessage ? prev.seq + 1 : 1
        /**
         * 增量只在「新正文以**已发出的正文**为前缀」时成立。
         * 不满足就必须发整段 —— 例如定稿回填 / 修复路径会**改写**正文，
         * 那时按增量算出来的「后缀」是错的（客户端会得到一段拼错位的正文）。
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
        // 收尾帧发**定稿全文**：最后一次增量可能未成帧，而定稿也可能被回填改写（增量已不可靠）
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
   * 推一次运行时快照 —— 「变化推送」之外的另一半（订阅 / 重订阅时补发）。
   *
   * 与指纹 reaction 共用同一个出口：报文形状必须一致，否则手机端要为「快照」再写一套解析。
   */
  function pushRuntime(sessionId?: string): void {
    const ids = sessionId ? [sessionId] : subscriptions.snapshot()
    for (const id of ids) {
      // 与其它通道同一道订阅门：未订阅的会话一个字节都不外发
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

  /**
   * 上下文占用变化（§22）。
   *
   * 与其它通道一样按「订阅集合」推送；占用变化在真实场景里由「消息带上了 usage」驱动，
   * 即每条定稿消息 / 每轮调用带一次，不会成为高频通道。
   */
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
