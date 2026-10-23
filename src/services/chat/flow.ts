/**
 * chat-service 编排层：发消息、暂停恢复、取消、压缩、建会话。
 * 流程：校验入参 → 落用户消息 → 调引擎 → 事件处理器回写 store。引擎恒为 Rust。
 */
import {
  getSessionRuntime,
  sessionRuntimeState,
  sessionStore,
  updateSessionRuntime,
  dropSessionRuntime,
  dropPendingInteractions,
  agentStore,
} from '@/ui/store'
import { v4 } from '@/utils/uuid'
import type { Agent, Message, MessageContent, Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import type { CompressMode } from '@/domain/ports'
import { settingsState } from '@/ui/store'
import { toolService } from '@/services/tool-service'
import { showToast } from '@/ui/components/shared/Toast'
import { assembleAgentPrompt, getDefaultAgent } from '@/services/agent-service'
import { invoke } from '@tauri-apps/api/core'
import {
  describeContent,
  engineKind,
  getCompressEngine,
  getEngine,
  providerTypeOf,
  resolveReasoningEffort,
  transformApiError,
} from './common'
import { activeTraces, markErrored } from './trace'
import {
  addSessionMessage,
  getSessionMessages,
  replaceSessionMessages,
} from './messages'
import { prepareMessagesForSend } from './repair'
import { createEventHandler, finishWorking } from './event-handler'
import type { ChatServiceEvents } from './types'
import {
  track,
  trackError,
  newTraceId,
  hashText,
  setSessionTrace,
  truncateText,
} from '@/utils/telemetry'
import { sanitizeLoneSurrogates } from '@/utils/text'
import { flushTodoDraft, flushTodoDraftMessages } from '@/services/todo-service'
import { dropTodoDrafts } from '@/ui/store/todoDraftStore'
import { setRoundBoundaryHandler } from '@/services/rust-engine'

/**
 * 会话是否正在跑 run（并发保护的判据）：手机端是第二个操作源，没有这层会起两个 run 写同一份 messages。
 * 入口到 updateSessionRuntime 之间无 await，检查与占位是原子的。
 */
function isSessionBusy(sessionId: string): boolean {
  return sessionRuntimeState.value.sessions[sessionId]?.working === true
}

/**
 * 会话是否处于活跃执行（区别于忙）：暂停态 working && paused 是已挂起的 run，
 * resumePausedRun 恰在此状态下调用，用 isSessionBusy 会把「继续」拦死。
 */
function isSessionActivelyWorking(sessionId: string): boolean {
  const rt = sessionRuntimeState.value.sessions[sessionId]
  return rt?.working === true && rt.paused !== true
}

/** 会话忙时的统一提示 */
const MSG_SESSION_BUSY = '该会话正在回复中，请等待完成或先取消'

/**
 * 正在恢复中的会话（同步防重入闸）。resumePausedRun 与随后的 await 之间有窗口，
 * 重复触发会各拿同一份快照恢复一次（重复 tool 结果 / 交互 handler 被顶替）。
 */
const resumingSessions = new Set<string>()

/**
 * 轮次边界处理器：落地「AI 回复期间用户已应用」的清单变更并返回消息。
 * 注册在此（而非 rust-engine 直接 import todo-service）避免循环依赖。
 */
setRoundBoundaryHandler((sessionId) =>
  flushTodoDraftMessages(sessionId, 'round_boundary'),
)

/**
 * 创建新会话（systemPrompt / Agent 默认值在 Service 层组装，持久化委托 store）。
 */
export async function createSession(
  title: string,
  providerConfigId?: string,
  modelId?: string,
  agent?: Agent,
  workspace?: string,
): Promise<Session> {
  const targetAgent = agent ?? (await getDefaultAgent())

  const id = v4()
  const now = Date.now()

  const realWorkspace = workspace || targetAgent.defaultWorkspace || undefined
  const systemPrompt = await assembleAgentPrompt(targetAgent, realWorkspace)

  const effectiveProvider =
    providerConfigId || targetAgent.defaultModel?.providerConfigId
  const effectiveModel = modelId || targetAgent.defaultModel?.modelId

  const session: Session = {
    id,
    title: title || '新对话',
    messages: [],
    providerConfigId: effectiveProvider,
    modelId: effectiveModel,
    systemPrompt,
    params: { ...DEFAULT_SESSION_PARAMS, ...targetAgent.defaultParams },
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: [],
    agentId: targetAgent.id,
    allowedTools: [...targetAgent.allowTools],
    skills: [...(targetAgent.skills || [])],
    systemPromptManuallyEdited: false,
    workspace: realWorkspace,
  }
  sessionStore.saveSession(session)
  track('session.create', {
    agent_id: targetAgent.id,
    provider_type: providerTypeOf(session),
    model_id: session.modelId,
    has_workspace: !!realWorkspace,
    allowed_tools_count: session.allowedTools?.length ?? 0,
    skills_count: session.skills?.length ?? 0,
  })
  return session
}

/**
 * 把一条压缩摘要转移到新对话（按值拷贝成新会话第一条消息，不动源会话）。
 * 本路径不产生引擎 run，故不会由 Rust 落库，必须自己显式落库。
 * @returns 新会话 id；源会话 / 摘要不存在时 null
 */
export async function transferSummaryToNewSession(
  sourceSessionId: string,
  summaryMessageId: string,
): Promise<string | null> {
  const source = sessionStore.getSession(sourceSessionId)
  if (!source) return null

  // 尾部窗口可能未加载，先补齐再找
  await sessionStore.ensureMessagesLoaded(sourceSessionId)
  const summary = getSessionMessages(sourceSessionId).find(
    (m) => m.id === summaryMessageId && m.role === 'summary',
  )
  if (!summary) return null

  // 沿用源会话的 Agent（缺省则回退默认 Agent，由 createSession 兜底）
  const agent = source.agentId ? agentStore.getAgent(source.agentId) : undefined

  const session = await createSession(
    source.title,
    source.providerConfigId,
    source.modelId,
    agent,
    source.workspace,
  )

  // 摘要按值拷贝（重新分配 id，避免跨会话复用 id），保留 role / content / uiData / timestamp
  const copy: Message = { ...summary, id: v4(), streaming: false }
  addSessionMessage(session.id, copy)

  // 本路径无 run，必须显式落库
  try {
    await invoke('cmd_replace_session_messages', {
      sessionId: session.id,
      messages: sanitizeLoneSurrogates([copy]),
    })
  } catch (err) {
    console.error('[chat] 转移到新对话落库失败:', err)
    trackError('session.save.error', err, {
      props: { session_id: hashText(session.id), op: 'transfer.persist' },
    })
  }

  track('chat.summary.transfer', {
    from_session_id: hashText(sourceSessionId),
    to_session_id: hashText(session.id),
  })
  return session.id
}

/**
 * 删除会话（唯一入口）：先断流，再删库。顺序必须是取消 run → 清快照 → 删会话，
 * 否则 run 仍在跑的 append 会写出孤儿消息。
 * @returns 实际删除的会话数
 */
export async function deleteSessions(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  for (const id of ids) {
    // 对已结束的会话 cancel 是 no-op；宁可多调一次也不能漏
    try {
      await getEngine().cancel(id)
      await getEngine().clearRunSnapshot(id)
    } catch {
      // 非 Tauri 环境 / 引擎无该 run：忽略，删除照常执行
    }
  }
  const count = sessionStore.deleteSessions(ids)
  // 同步丢弃运行时状态与清单草稿，否则它们会永久挂在已不存在的会话 id 上
  dropSessionRuntime(ids)
  dropPendingInteractions(ids)
  dropTodoDrafts(ids)
  return count
}

/**
 * 发送消息：确保 session 存在 → 落用户消息 → 调引擎并处理事件 → 维护运行时状态与 UI 回调。
 */
export async function sendMessage(
  sessionId: string,
  content: MessageContent,
  events?: ChatServiceEvents,
  extraFields?: {
    imageVisionAnalyzeOptimize?: boolean
    imageVisionAnalyzeResult?: string
  },
  options?: { skipUserMessage?: boolean },
): Promise<void> {
  let session = sessionStore.getSession(sessionId)
  if (!session) {
    events?.onError?.(sessionId, '会话不存在')
    return
  }

  // 并发保护：同一会话同时只能有一个 run（手机端接入后的必备检查）
  if (isSessionBusy(sessionId)) {
    events?.onError?.(sessionId, MSG_SESSION_BUSY)
    return
  }

  if (!session.modelId || !session.providerConfigId) {
    events?.onError?.(sessionId, '未选择模型')
    return
  }

  // 会话时间 = 用户最后一次发言；touchSession 是整对象替换，故重新取引用
  sessionStore.touchSession(sessionId)
  session = sessionStore.getSession(sessionId) ?? session

  // 埋点：开启本轮链路
  const traceId = newTraceId()
  activeTraces.set(sessionId, {
    traceId,
    startTime: Date.now(),
    firstTokenSeen: false,
    errored: false,
    rounds: 0,
    toolCallIds: new Set(),
  })
  setSessionTrace(sessionId, traceId)
  const contentDesc = describeContent(content)
  track('chat.message.send', {
    trace_id: traceId,
    session_id: hashText(sessionId),
    content_type: contentDesc.contentType,
    text: truncateText(contentDesc.text, 16384),
    text_len: contentDesc.textLen,
    image_count: contentDesc.imageCount,
    has_skill: !!(session.skills && session.skills.length),
    use_goal: false,
    enable_tools:
      session.allowedTools === undefined || session.allowedTools.length > 0,
    model_id: session.modelId,
    provider_type: providerTypeOf(session),
  })

  // 服务层负责落用户消息；skipUserMessage 时调用方已提前加过（并做了视觉分析）
  if (!options?.skipUserMessage) {
    const userMessage: Message = {
      id: v4(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(extraFields?.imageVisionAnalyzeOptimize !== undefined && {
        imageVisionAnalyzeOptimize: extraFields.imageVisionAnalyzeOptimize,
      }),
      ...(extraFields?.imageVisionAnalyzeResult && {
        imageVisionAnalyzeResult: extraFields.imageVisionAnalyzeResult,
      }),
    }
    addSessionMessage(sessionId, userMessage)
    events?.onMessagesUpdate?.(sessionId)
  }

  const sessionRt = getSessionRuntime(sessionId)
  updateSessionRuntime(sessionId, {
    working: true,
    pendingContent: '',
    streamingMessageId: null,
  })
  events?.onWorkingChange?.(sessionId, true)

  const toolInteract = await toolService.createToolHandles(sessionId)

  // 发送前：全量加载历史 + 修复悬空 tool_calls
  const currentMessages = await prepareMessagesForSend(sessionId)
  // 收集引擎入参：消息列表 + reasoningEffort
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  const reasoningEffort = resolveReasoningEffort(session, providerCfg)

  track('engine.send.start', {
    engine: engineKind(),
    trace_id: traceId,
    session_id: hashText(sessionId),
    msg_count: currentMessages.length,
    tool_count: session.allowedTools?.length ?? 0,
    max_tool_rounds: settingsState.value.maxToolRounds,
  })
  try {
    await getEngine().sendMessage({
      maxTokens: settingsState.value.maxTokens,
      session,
      messages: currentMessages,
      reasoningEffort,
      onEvent: createEventHandler(sessionId, sessionRt, events, traceId),
      onUserInteraction: toolInteract.handler,
      maxToolRounds: settingsState.value.maxToolRounds,
      // 轮次边界：工具回复后、下一次 LLM 请求前注入用户已应用的清单变更
      onRoundBoundary: (sid) => flushTodoDraftMessages(sid, 'round_boundary'),
    })
  } catch (e: any) {
    markErrored(sessionId)
    events?.onError?.(sessionId, transformApiError(e.message || '错误'))
  } finally {
    toolInteract.cleanup()
  }

  finishWorking(sessionId, sessionRt, events, content, traceId)
}

/**
 * 恢复被暂停的 tool run（唯一恢复入口）。拆成薄封装只是为了让防重入在任何 await 之前生效。
 */
export async function resumePausedRun(
  sessionId: string,
  events?: ChatServiceEvents,
): Promise<void> {
  if (resumingSessions.has(sessionId)) {
    events?.onError?.(sessionId, MSG_SESSION_BUSY)
    return
  }
  resumingSessions.add(sessionId)
  try {
    await resumePausedRunImpl(sessionId, events)
  } finally {
    resumingSessions.delete(sessionId)
  }
}

/** resumePausedRun 的实现（不自带防重入） */
async function resumePausedRunImpl(
  sessionId: string,
  events?: ChatServiceEvents,
): Promise<void> {
  const session = sessionStore.getSession(sessionId)
  if (!session) {
    events?.onError?.(sessionId, '会话不存在')
    return
  }

  // 用「活跃执行」而非 isSessionBusy：暂停态的 working 仍为 true，但正是本函数的合法入口
  if (isSessionActivelyWorking(sessionId)) {
    events?.onError?.(sessionId, MSG_SESSION_BUSY)
    return
  }

  const snapshot = await getEngine().getRunSnapshot(sessionId)
  if (!snapshot) {
    events?.onError?.(sessionId, '没有可恢复的暂停任务')
    return
  }

  const sessionRt = getSessionRuntime(sessionId)
  // 立即清除暂停标记，UI 会立刻隐藏 paused banner
  updateSessionRuntime(sessionId, {
    paused: false,
    working: true,
    pendingContent: '',
    streamingMessageId: null,
  })
  events?.onWorkingChange?.(sessionId, true)

  const toolInteract = await toolService.createToolHandles(sessionId)

  // 恢复时不传整份历史：引擎以本地库为权威读回，省掉 O(历史) 的 IPC 开销
  const currentMessages: Message[] = []
  // 埋点用的消息条数：取内存条数（暂停发生在一次完整 run 内，此前已全量加载）
  const messageCount = sessionStore.getSession(sessionId)?.messages.length ?? 0
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  const reasoningEffort = resolveReasoningEffort(session, providerCfg)

  // 埋点：恢复暂停任务
  const traceId = newTraceId()
  activeTraces.set(sessionId, {
    traceId,
    startTime: Date.now(),
    firstTokenSeen: false,
    errored: false,
    rounds: 0,
    toolCallIds: new Set(),
  })
  setSessionTrace(sessionId, traceId)
  track('chat.stream.resume', {
    trace_id: traceId,
    round: snapshot.round,
    resumed_steps: snapshot.steps.filter((s) => s.status !== 'completed')
      .length,
  })
  track('engine.send.start', {
    engine: engineKind(),
    trace_id: traceId,
    session_id: hashText(sessionId),
    msg_count: messageCount,
    resumed: true,
  })

  try {
    await getEngine().sendMessage({
      maxTokens: settingsState.value.maxTokens,
      resumeFromSnapshot: snapshot,

      session,
      messages: currentMessages,
      reasoningEffort,
      onEvent: createEventHandler(sessionId, sessionRt, events, traceId),
      onUserInteraction: toolInteract.handler,
      maxToolRounds: settingsState.value.maxToolRounds,
      // 恢复后同样从轮次边界注入（草稿可能是暂停期间用户应用的）
      onRoundBoundary: (sid) => flushTodoDraftMessages(sid, 'round_boundary'),
    })
  } catch (e: any) {
    markErrored(sessionId)
    events?.onError?.(sessionId, e.message || '错误')
  } finally {
    toolInteract.cleanup()
  }

  // 恢复后若无待执行的工具步骤，主动清快照，避免 finishWorking 误判为暂停
  const remainingSnapshot = await getEngine().getRunSnapshot(sessionId)
  if (
    remainingSnapshot &&
    remainingSnapshot.steps.every((s) => s && s.status === 'completed')
  ) {
    await getEngine().clearRunSnapshot(sessionId)
  }

  // 传 traceId，保证 engine.finish 事件被记录且链路上下文被回收
  finishWorking(sessionId, sessionRt, events, undefined, traceId)
}

/**
 * 发送带迭代目标的消息：引擎每轮 tool 执行后自动验证 goal，未达标则注入反馈重试，
 * 直到达标或超出 maxIterations。
 */
export async function sendMessageWithGoal(
  sessionId: string,
  content: MessageContent,
  goal: string,
  events?: ChatServiceEvents,
  options?: {
    maxIterations?: number
    imageVisionAnalyzeOptimize?: boolean
    imageVisionAnalyzeResult?: string
    /** 跳过用户消息创建（调用方已提前添加） */
    skipUserMessage?: boolean
  },
): Promise<void> {
  let session = sessionStore.getSession(sessionId)
  if (!session) {
    events?.onError?.(sessionId, '会话不存在')
    return
  }

  // 并发保护：与 sendMessage 同一判据
  if (isSessionBusy(sessionId)) {
    events?.onError?.(sessionId, MSG_SESSION_BUSY)
    return
  }

  if (!session.modelId || !session.providerConfigId) {
    events?.onError?.(sessionId, '未选择模型')
    return
  }

  // 会话时间刷新：迭代模式也是「用户发出一条消息」，务必刷一次
  sessionStore.touchSession(sessionId)
  session = sessionStore.getSession(sessionId) ?? session

  // 埋点：开启本轮链路（迭代模式）
  const traceId = newTraceId()
  activeTraces.set(sessionId, {
    traceId,
    startTime: Date.now(),
    firstTokenSeen: false,
    errored: false,
    rounds: 0,
    toolCallIds: new Set(),
  })
  setSessionTrace(sessionId, traceId)
  const goalDesc = describeContent(content)
  track('chat.message.send', {
    trace_id: traceId,
    session_id: hashText(sessionId),
    content_type: goalDesc.contentType,
    text: truncateText(goalDesc.text, 16384),
    text_len: goalDesc.textLen,
    image_count: goalDesc.imageCount,
    has_skill: !!(session.skills && session.skills.length),
    use_goal: true,
    enable_tools:
      session.allowedTools === undefined || session.allowedTools.length > 0,
    model_id: session.modelId,
    provider_type: providerTypeOf(session),
    goal,
  })

  // 创建用户消息（除非调用方已提前添加）
  if (!options?.skipUserMessage) {
    const userMessage: Message = {
      id: v4(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(options?.imageVisionAnalyzeOptimize !== undefined && {
        imageVisionAnalyzeOptimize: options.imageVisionAnalyzeOptimize,
      }),
      ...(options?.imageVisionAnalyzeResult && {
        imageVisionAnalyzeResult: options.imageVisionAnalyzeResult,
      }),
    }
    addSessionMessage(sessionId, userMessage)
    events?.onMessagesUpdate?.(sessionId)
  }

  const sessionRt = getSessionRuntime(sessionId)
  updateSessionRuntime(sessionId, {
    working: true,
    pendingContent: '',
    streamingMessageId: null,
  })
  events?.onWorkingChange?.(sessionId, true)

  const toolInteract = await toolService.createToolHandles(sessionId)

  // 发送前：全量加载历史 + 修复悬空 tool_calls
  const currentMessages = await prepareMessagesForSend(sessionId)
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  const reasoningEffort = resolveReasoningEffort(session, providerCfg)

  track('engine.send.start', {
    engine: engineKind(),
    trace_id: traceId,
    session_id: hashText(sessionId),
    msg_count: currentMessages.length,
    tool_count: session.allowedTools?.length ?? 0,
    max_tool_rounds: settingsState.value.maxToolRounds,
    iteration_goal: goal,
  })
  try {
    await getEngine().sendMessage({
      maxTokens: settingsState.value.maxTokens,
      session,
      messages: currentMessages,
      reasoningEffort,
      iterationGoal: goal,
      maxIterations: options?.maxIterations ?? 5,
      onEvent: createEventHandler(sessionId, sessionRt, events, traceId),
      onUserInteraction: toolInteract.handler,
      maxToolRounds: settingsState.value.maxToolRounds,
      // 迭代模式：Verifier 反馈与工具轮次同样存在边界，同一时机注入
      onRoundBoundary: (sid) => flushTodoDraftMessages(sid, 'round_boundary'),
    })
  } catch (e: any) {
    markErrored(sessionId)
    events?.onError?.(sessionId, transformApiError(e.message || '错误'))
  } finally {
    toolInteract.cleanup()
  }

  finishWorking(sessionId, sessionRt, events, content, traceId)
}

/** 取消当前正在处理的请求（非暂停状态） */
export async function cancelMessage(sessionId: string): Promise<void> {
  if (sessionId) {
    track('chat.cancel', {
      trace_id: activeTraces.get(sessionId)?.traceId,
      phase: 'streaming',
    })
    await getEngine().cancel(sessionId)
    // 用户点「停止」= 本轮结束：落地清单草稿
    flushTodoDraft(sessionId, 'cancel')
  }
}

/**
 * 取消暂停态的 tool run：给未完成 step 注入空 tool_result（cancelled）并清快照。
 */
export async function cancelPausedRun(sessionId: string): Promise<void> {
  const snapshot = await getEngine().getRunSnapshot(sessionId)
  if (!snapshot) {
    await getEngine().cancel(sessionId)
    return
  }

  for (const step of snapshot.steps) {
    if (step.status !== 'completed') {
      const toolResultMessage: Message = {
        id: v4(),
        role: 'tool',
        content: 'cancelled',
        toolCallId: step.toolCallId,
        timestamp: Date.now(),
      }
      addSessionMessage(sessionId, toolResultMessage)
    }
  }
  await getEngine().clearRunSnapshot(sessionId)
  await getEngine().cancel(sessionId)
  // 暂停态下用户主动取消：同样视为本轮结束
  flushTodoDraft(sessionId, 'cancel')
}

export async function getRunSnapshot(sessionId: string) {
  return await getEngine().getRunSnapshot(sessionId)
}

/**
 * 压缩会话上下文。
 * @param modeOverride 本次压缩方式（token 环右键菜单）；不传则用设置。
 */
export async function compressContext(
  sessionId: string,
  events?: ChatServiceEvents,
  modeOverride?: CompressMode,
) {
  try {
    sessionRuntimeState.setCompacting(sessionId, true)
    const session = sessionStore.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    // 压缩需基于完整历史，先补齐分页未加载的部分
    await sessionStore.ensureAllMessagesLoaded(sessionId)
    const allMessages = getSessionMessages(sessionId)
    const beforeCount = allMessages.length
    const beforeTokens = allMessages.reduce(
      (sum, m) =>
        sum +
        (typeof m.content === 'string'
          ? m.content.length
          : JSON.stringify(m.content).length),
      0,
    )
    const compressStart = Date.now()
    // 压缩方式：调用方指定优先，否则用设置
    const mode =
      modeOverride ?? settingsState.value.contextCompressMode ?? 'ai'
    // Tauri 下走 Rust（与 CLI 同一份实现）；非 Tauri 回退 TS 实现
    const result = await getCompressEngine().compressContext(
      session,
      allMessages,
      mode,
    )
    // 兜底：孤立代理经 serde_json 会报 unexpected end of hex escape，先清洗
    const safeMessages = sanitizeLoneSurrogates(result.messages)
    replaceSessionMessages(sessionId, safeMessages)
    // 通知 UI 重新同步消息列表（含分页补齐的历史 + 新的 summary 消息）
    events?.onMessagesUpdate?.(sessionId)
    track('chat.context.compress', {
      mode,
      before_msg_count: beforeCount,
      after_msg_count: result.messages.length,
      before_tokens_est: beforeTokens,
      duration_ms: Date.now() - compressStart,
      status: 'success',
    })
    // 压缩会整体替换消息列表，需同步落库（Tauri 走 Rust SQLite；非 Tauri invoke 抛错，忽略）
    try {
      await invoke('cmd_replace_session_messages', {
        sessionId,
        messages: safeMessages,
      })
    } catch (err) {
      // 不能空 catch：内存已是压缩后而 DB 还是旧的，两边会不一致
      console.error('[chat] 压缩结果落库失败:', err)
      trackError('session.save.error', err, {
        props: { session_id: hashText(sessionId), op: 'compress.persist' },
      })
      showToast(
        '压缩结果保存失败：' + ((err as any)?.message || String(err)),
        3000,
      )
    }
  } catch (e: any) {
    const errorMsg = e?.message || String(e)
    showToast('压缩失败：' + errorMsg, 2000)
  } finally {
    sessionRuntimeState.setCompacting(sessionId, false)
  }
}
