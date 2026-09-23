/**
 * chat-service 编排层 — 消息发送、暂停恢复、取消、上下文压缩、会话创建
 *
 * 负责：校验入参 → 创建/持久化用户消息 → 调引擎 → 通过事件处理器回写 store。
 * 引擎通过 getEngine() 选择（Rust 原生 / TS 回退）。
 */
import {
  getSessionRuntime,
  sessionRuntimeState,
  sessionStore,
  updateSessionRuntime,
} from '@/ui/store'
import { v4 } from '@/utils/uuid'
import type { Agent, Message, MessageContent, Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import { settingsState } from '@/ui/store'
import { toolService } from '@/services/tool-service'
import { showToast } from '@/ui/components/shared/Toast'
import { assembleAgentPrompt, getDefaultAgent } from '@/services/agent-service'
import { invoke } from '@tauri-apps/api/core'
import {
  describeContent,
  engineKind,
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

/**
 * 创建新会话
 *
 * 业务逻辑（组装 systemPrompt、合并 Agent 默认值）在 Service 层完成，
 * 持久化委托给 Store 层的纯函数 saveSession()。
 *
 * @param title         会话标题
 * @param providerConfigId  provider 配置 ID（不传则使用 Agent 默认）
 * @param modelId       模型 ID（不传则使用 Agent 默认）
 * @param agent         关联的 Agent（不传则使用默认 Agent）
 * @param workspace     工作目录（不传则使用 Agent 的 defaultWorkspace）
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
 * 发送消息 — 纯数据层操作
 *
 * 会：
 * 1. 确保 session 存在
 * 2. **创建并持久化用户消息**（服务层职责，而非 engine 内部处理）
 * 3. 调用引擎 sendMessage（已跳过用户消息创建）并处理事件
 * 4. 维护 sessionRuntimeState 中的 working / pendingContent
 * 5. 通过 events 回调通知 UI
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

  if (!session.modelId || !session.providerConfigId) {
    events?.onError?.(sessionId, '未选择模型')
    return
  }

  // ===== 0. 会话时间刷新（唯一入口）=====
  // 会话时间 = 用户最后一次发言的时间：只在这里（用户发出消息的瞬间）刷新，
  // AI 回复 / 工具消息 / 改标题都不刷新（见 sessionStore.touchSession）。
  // 刷新后重新取一次会话对象：touchSession 是整对象替换，旧引用会拿不到新时间
  // （取新引用还保证传给引擎 / 落库的 session.updatedAt 是刷新后的值）。
  sessionStore.touchSession(sessionId)
  session = sessionStore.getSession(sessionId) ?? session

  // ===== 埋点：开启本轮链路（§5.4 / §5.5）=====
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

  // ===== 1. 服务层负责创建并持久化用户消息 =====
  // skipUserMessage=true 时，调用方（doSend）已提前添加了用户消息并做了视觉分析
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

  // 发送前：全量加载历史 + 检测并修复格式异常（悬空 tool_calls）
  const currentMessages = await prepareMessagesForSend(sessionId)
  // 收集 engine 需要的入参：当前消息列表 + reasoningEffort
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
 * 恢复被暂停的 tool run
 *
 * 当 tool 链中途被 shelve（用户暂存）后，用户可调用此函数恢复执行。
 * 引擎会读取保存的 run snapshot，从断点继续执行未完成的 tool steps。
 * 这是「暂停→恢复」唯一的恢复入口。
 */
export async function resumePausedRun(
  sessionId: string,
  events?: ChatServiceEvents,
): Promise<void> {
  const session = sessionStore.getSession(sessionId)
  if (!session) {
    events?.onError?.(sessionId, '会话不存在')
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

  // 分页加载下，恢复暂停任务同样需要完整历史；
  // 注意：此处**不能**补占位 tool 结果（悬空 tool_calls 正是本次要恢复执行的步骤）
  const currentMessages = await prepareMessagesForSend(sessionId, {
    repair: false,
  })
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  const reasoningEffort = resolveReasoningEffort(session, providerCfg)

  // ===== 埋点：恢复暂停任务 =====
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
    msg_count: currentMessages.length,
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
    })
  } catch (e: any) {
    markErrored(sessionId)
    events?.onError?.(sessionId, e.message || '错误')
  } finally {
    toolInteract.cleanup()
  }

  // 恢复完成后，检查是否仍有未清除的快照（engine 成功完成所有工具后可能未清理）
  // 若没有 pending 的工具步骤，则主动清除快照，避免 finishWorking 误判为暂停状态
  const remainingSnapshot = await getEngine().getRunSnapshot(sessionId)
  if (
    remainingSnapshot &&
    remainingSnapshot.steps.every((s) => s && s.status === 'completed')
  ) {
    await getEngine().clearRunSnapshot(sessionId)
  }

  // 传入 traceId，保证 engine.finish 事件被记录且链路上下文被回收
  finishWorking(sessionId, sessionRt, events, undefined, traceId)
}

/**
 * 发送带迭代目标的消息
 *
 * 启用「执行→验证→修复」自主迭代模式。
 * engine 会在每轮 tool 执行后自动验证结果是否达到 goal，
 * 未达标则注入反馈并重试，直到达标或超出 maxIterations。
 *
 * @param sessionId  会话 ID
 * @param content    用户消息内容
 * @param goal       迭代目标描述（明确、可验证的目标）
 * @param events     回调事件
 * @param options    可选配置
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

  if (!session.modelId || !session.providerConfigId) {
    events?.onError?.(sessionId, '未选择模型')
    return
  }

  // ===== 0. 会话时间刷新（唯一入口，与 sendMessage 同一语义）=====
  // 迭代模式也是「用户发出一条消息」，务必在这里刷一次；后续执行→验证→修复
  // 产生的反馈 / 失败报告落库都不刷新时间。
  sessionStore.touchSession(sessionId)
  session = sessionStore.getSession(sessionId) ?? session

  // ===== 埋点：开启本轮链路（迭代模式）=====
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

  // 发送前：全量加载历史 + 检测并修复格式异常（悬空 tool_calls）
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
 * 取消当前正在处理的请求（非暂停状态）
 */
export async function cancelMessage(sessionId: string): Promise<void> {
  if (sessionId) {
    track('chat.cancel', {
      trace_id: activeTraces.get(sessionId)?.traceId,
      phase: 'streaming',
    })
    await getEngine().cancel(sessionId)
  }
}

/**
 * 取消暂停状态的 tool run — 给所有未完成的 step 注入空 tool_result，清除快照
 *
 * 这是暂停状态下「取消」按钮的唯一入口。
 * UI 调完此方法后直接更新自己的 loading 状态即可。
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
}

export async function getRunSnapshot(sessionId: string) {
  return await getEngine().getRunSnapshot(sessionId)
}

/**
 * 压缩会话上下文
 *
 * @param events 事件回调。压缩会**整体替换**消息列表，而消息列表的数据源是
 *   `chat-view` 的本地 state（不是 store），因此必须通过 `onMessagesUpdate`
 *   通知它重新同步 —— 否则列表仍显示压缩前的消息，要切会话才刷新。
 */
export async function compressContext(
  sessionId: string,
  events?: ChatServiceEvents,
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
    // 压缩方式由设置决定：ai = LLM 摘要 / raw = 正文压缩（本地渲染，不发请求）
    const mode = settingsState.value.contextCompressMode ?? 'ai'
    const result = await getEngine().compressContext(session, allMessages, mode)
    // 兜底：summary / 历史里若含孤立代理（半个 emoji），先清洗再写内存 + 落库。
    // 孤立代理经 JSON.stringify → Rust serde_json 会直接报
    // "unexpected end of hex escape"（源头已用 utils/text 安全截断，这里再防第三方网关产出）
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
    // 压缩会整体替换消息列表，需同步落库（Rust SQLite 直落）
    // 非 Tauri 环境 invoke 抛错，忽略即可（引擎路径不受影响）
    try {
      await invoke('cmd_replace_session_messages', {
        sessionId,
        messages: safeMessages,
      })
    } catch (err) {
      // ⚠️ 绝不能空 catch：这边内存已是压缩后的消息、DB 还是旧的，两边不一致
      //    （曾出现问题：summary 里含孤立代理 → serde_json 报错 → 静默失败，
      //     用户看到「压缩成功」，下次发消息才炸在 agent_send_message 上）。
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
