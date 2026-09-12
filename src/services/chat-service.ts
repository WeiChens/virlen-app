/**
 * chat-service — 聊天数据服务层
 *
 * 职责：封装所有与 agentEngine + store 的数据交互，
 *       不依赖 React 组件，只通过回调通知 UI 层更新。
 *
 * 核心能力：
 * - sendMessage(): 正常发送消息，支持 tool call 暂停/恢复
 * - resumePausedRun(): 从暂停的 run 快照恢复执行（统一恢复入口）
 * - cancelMessage(): 取消正在处理的请求
 *
 * 注意：暂停/恢复机制基于 Run Snapshot 模型，旧版 shelvedChoiceState 已废弃。
 */
import { runInAction } from 'mobx'
import {
  getSessionRuntime,
  sessionStore,
  sessionRuntimeState,
  updateSessionRuntime,
} from '@/ui/store'
import { v4 } from '@/utils/uuid'
import type { AgentEventCallback, Message, MessageContent } from '@/types'
import { settingsState } from '@/ui/store'
import { toolService } from './tool-service'
import { showToast } from '@/ui/components/shared/Toast'
import type { Agent, Session } from '@/types'
import { DEFAULT_SESSION_PARAMS } from '@/types'
import { getDefaultAgent, assembleAgentPrompt } from '@/services/agent-service'
import { agentEngine } from '@/domain'
import { rustEngine, isRustEngineEnabled } from '@/services/rust-engine'
import { invoke } from '@tauri-apps/api/core'
import {
  track,
  trackError,
  trackPerf,
  newTraceId,
  hashText,
  setSessionTrace,
  clearSessionTrace,
  truncateText,
} from '@/utils/telemetry'

// ==================== 埋点辅助（§5.4 / §5.5） ====================

/** 当前活跃请求的链路上下文 */
const activeTraces = new Map<
  string,
  {
    traceId: string
    startTime: number
    firstTokenSeen: boolean
    /** 本轮是否发生过错误（供 engine.finish / chat.stream.end 推导 status） */
    errored: boolean
    /** 本轮 LLM 轮次计数（assistant_message_created 次数，供 engine.finish.rounds） */
    rounds: number
    /** 本轮去重后的工具调用 ID 集合（供 engine.finish.tool_calls_total） */
    toolCallIds: Set<string>
  }
>()

/** 标记本轮链路发生过错误 */
function markErrored(sessionId: string): void {
  const tr = activeTraces.get(sessionId)
  if (tr) tr.errored = true
}

function engineKind(): 'rust' | 'ts' {
  return isRustEngineEnabled() ? 'rust' : 'ts'
}

function providerTypeOf(session: Session): string {
  const p = settingsState.value.providers.find(
    (x) => x.id === session.providerConfigId,
  )
  return p?.type || 'unknown'
}

/** 解析消息内容用于埋点统计 */
function describeContent(content: MessageContent): {
  text: string
  textLen: number
  imageCount: number
  contentType: 'text' | 'image' | 'mixed'
} {
  let text = ''
  let imageCount = 0
  if (typeof content === 'string') {
    text = content
  } else {
    for (const block of content) {
      if (block.type === 'text') {
        text += ('text' in block ? block.text : '') || ''
      } else if (block.type === 'image_url') {
        imageCount++
      }
    }
  }
  return {
    text,
    textLen: text.length,
    imageCount,
    contentType: imageCount > 0 ? (text ? 'mixed' : 'image') : 'text',
  }
}

/**
 * 获取当前激活的 Agent 引擎
 * - useRustEngine=true 且 Tauri 可用 → Rust 原生引擎
 * - 否则 → TS 引擎（回退）
 */
export function getEngine(): typeof agentEngine {
  return isRustEngineEnabled() ? rustEngine : agentEngine
}

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
 * 匹配 API 错误信息中关于"模型不支持图片"的常见报错模式，
 * 转为用户友好的提示文本。不匹配则返回原始信息。
 */
function transformApiError(message: string): string {
  const imageNotSupportedPatterns = [
    /does\s+not\s+support\s+(image|multimodal)/i,
    /image\s+(input|upload|data|url)(s)?\s+(is\s+)?not\s+supported/i,
    /not\s+support\s+(image|multimodal)/i,
    /image\s+is\s+not\s+allowed/i,
    /multimodal\s+is\s+not\s+supported/i,
    /unsupported\s+(image|multimodal)/i,
    /currently\s+doesn'?t\s+support\s+(image|multimodal)/i,
    /this\s+model\s+does\s+not\s+support/i,
    /image_url.*(only|support)/i,
    // 序列化反序列化层面拒绝 image_url（如 DeepSeek）
    /unknown\s+variant\s+`?image_url`?/i,
    /expected\s+`?text`?\s*.+`?image_url`?/i,
  ]
  for (const pattern of imageNotSupportedPatterns) {
    if (pattern.test(message)) {
      return '当前模型不支持上传图片，请切换至支持视觉的模型'
    }
  }
  return message
}

/** 从 MessageContent 中提取纯文本（用于标题展示） */
function extractText(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join(' ')
}

export interface ChatServiceEvents {
  /** 会话工作状态变更 */
  onWorkingChange?: (sessionId: string, working: boolean) => void
  /** 迭代验证状态变更（开始/结束验证时触发） */
  onVerifyingChange?: (sessionId: string, verifying: boolean) => void
  /** 会话消息更新 */
  onMessagesUpdate?: (sessionId: string) => void
  /** 错误 */
  onError?: (sessionId: string, error: string) => void
  /** 流式内容累积 */
  onPendingContent?: (sessionId: string, delta: string) => void
  /** 流式结束 */
  onStreamEnd?: (sessionId: string) => void
}

/**
 * TS 引擎路径消息落库（Rust 引擎路径由引擎内部直落 SQLite，跳过）。
 * fire-and-forget：不 await，落库不阻塞 UI。
 */
function persistMessagesIfNeeded(
  sessionId: string,
  messages: Message[],
): void {
  if (isRustEngineEnabled()) return
  if (!messages.length) return
  try {
    invoke('cmd_append_messages', { sessionId, messages })
  } catch {
    // 非 Tauri 环境忽略
  }
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
  const session = sessionStore.getSession(sessionId)
  if (!session) {
    events?.onError?.(sessionId, '会话不存在')
    return
  }

  if (!session.modelId || !session.providerConfigId) {
    events?.onError?.(sessionId, '未选择模型')
    return
  }

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

  // 收集 engine 需要的入参：当前消息列表 + reasoningEffort
  const currentMessages = getSessionMessages(sessionId)
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  const reasoningEffort = providerCfg?.reasoningEffort

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

  // 收集 engine 需要的入参
  const currentMessages = getSessionMessages(sessionId)
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  const reasoningEffort = providerCfg?.reasoningEffort

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
  const session = sessionStore.getSession(sessionId)
  if (!session) {
    events?.onError?.(sessionId, '会话不存在')
    return
  }

  if (!session.modelId || !session.providerConfigId) {
    events?.onError?.(sessionId, '未选择模型')
    return
  }

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

  const currentMessages = getSessionMessages(sessionId)
  const providerCfg = settingsState.value.providers.find(
    (p) => p.id === session.providerConfigId,
  )
  const reasoningEffort = providerCfg?.reasoningEffort

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

// ==================== 内部工具函数 ====================
/** 创建通用事件处理器 */
function createEventHandler(
  sessionId: string,
  sessionRt: ReturnType<typeof getSessionRuntime>,
  events?: ChatServiceEvents,
  traceId?: string,
): AgentEventCallback {
  return (event) => {
    switch (event.type) {
      case 'stream_event': {
        const delta = event.data?.delta || ''
        const tr = activeTraces.get(sessionId)
        if (delta && tr && !tr.firstTokenSeen && traceId) {
          tr.firstTokenSeen = true
          const sess = sessionStore.getSession(sessionId)
          track('chat.stream.first_token', {
            trace_id: traceId,
            first_token_ms: Date.now() - tr.startTime,
            model_id: sess?.modelId,
            provider_type: sess ? providerTypeOf(sess) : undefined,
          })
        }
        updateSessionRuntime(sessionId, {
          pendingContent: (sessionRt.pendingContent || '') + delta,
          streamingMessageId: event.data?.messageId || null,
        })
        events?.onPendingContent?.(sessionId, delta)
        events?.onMessagesUpdate?.(sessionId)
        break
      }

      case 'assistant_message_created': {
        // engine 创建了 assistant 消息，需要持久化
        if (event.data?.message) {
          const trMsg = activeTraces.get(sessionId)
          // 仅把 LLM 产出的 assistant 消息计为一次轮次：迭代模式下的
          // 反馈消息（role=feedback）与失败报告无 streaming 标记，不计入 rounds。
          if (
            trMsg &&
            event.data.message.role === 'assistant' &&
            event.data.message.streaming
          ) {
            trMsg.rounds += 1
          }
          addSessionMessage(sessionId, event.data.message)
          events?.onMessagesUpdate?.(sessionId)
        }
        break
      }

      case 'assistant_message_updated':
        // engine 更新了 assistant 消息内容（流式增量 / 结束标记）
        if (event.data?.messageId && event.data?.patch) {
          updateSessionMessage(
            sessionId,
            event.data.messageId,
            event.data.patch,
          )
          events?.onMessagesUpdate?.(sessionId)
        }
        break

      case 'tool_result_created':
        // engine 创建了 tool_result 消息，需要持久化
        if (event.data?.message) {
          addSessionMessage(sessionId, event.data.message)
          events?.onMessagesUpdate?.(sessionId)
        }
        break

      case 'tool_call': {
        const trTc = activeTraces.get(sessionId)
        const toolCallId = event.data?.id
        if (trTc && typeof toolCallId === 'string') {
          trTc.toolCallIds.add(toolCallId)
        }
        events?.onMessagesUpdate?.(sessionId)
        break
      }

      case 'iteration_verify_start':
        events?.onVerifyingChange?.(sessionId, true)
        break

      case 'iteration_verify_end':
        events?.onVerifyingChange?.(sessionId, false)
        break

      case 'iteration_verify_pass':
      case 'iteration_verify_fail': {
        // §5.5 engine.iteration.verify / fix
        const v = event.data?.result
        const issues = Array.isArray(v?.issues) ? v.issues : []
        track('engine.iteration.verify', {
          trace_id: traceId,
          iteration: event.data?.iteration,
          passed: !!v?.passed,
          summary: v?.summary,
          issue_count: issues.length,
          severity_list: issues.map((it: any) => it?.severity).filter(Boolean),
        })
        if (!v?.passed) {
          track('engine.iteration.fix', {
            trace_id: traceId,
            iteration: event.data?.iteration,
            issue_count: issues.length,
          })
        }
        break
      }

      case 'iteration_max_exceeded':
        track('engine.iteration.max_exceeded', {
          trace_id: traceId,
          iteration: event.data?.iteration,
          max_iterations: event.data?.maxIterations,
        })
        break

      case 'stream_end': {
        const trEnd = activeTraces.get(sessionId)
        const totalMs = trEnd ? Date.now() - trEnd.startTime : undefined
        if (event.data?.paused) {
          const snap = event.data?.snapshot
          track('chat.stream.pause', {
            trace_id: traceId,
            total_ms: totalMs,
            round: snap?.round,
            pending_steps: Array.isArray(snap?.steps)
              ? snap.steps.filter((s: any) => s?.status !== 'completed').length
              : undefined,
          })
          updateSessionRuntime(sessionId, { paused: true })
          events?.onMessagesUpdate?.(sessionId)
        } else {
          const sessEnd = sessionStore.getSession(sessionId)
          const lastAssistant = sessEnd
            ? [...sessEnd.messages].reverse().find((m) => m.role === 'assistant')
            : undefined
          const replyText = lastAssistant
            ? extractText(lastAssistant.content)
            : ''
          track('chat.stream.end', {
            trace_id: traceId,
            status: trEnd?.errored ? 'fail' : 'success',
            total_ms: totalMs,
            text_len: replyText.length,
            reasoning_elapsed_ms: lastAssistant?.reasoningElapsedMs,
            usage: lastAssistant?.usage
              ? {
                  prompt: lastAssistant.usage.promptTokens,
                  completion: lastAssistant.usage.completionTokens,
                  total: lastAssistant.usage.totalTokens,
                }
              : undefined,
          })
          // perf.stream.tps（10% 采样）：仅非暂停的正常结束
          const tokens = lastAssistant?.usage?.completionTokens ?? 0
          if (totalMs && totalMs > 0 && tokens > 0) {
            trackPerf('perf.stream.tps', {
              trace_id: traceId,
              tokens,
              duration_ms: totalMs,
              tps: Math.round((tokens / (totalMs / 1000)) * 10) / 10,
            })
          }
          // 埋点：AI 回复正文（§5.4）— 每轮 assistant 结束时发一次
          if (lastAssistant) {
            const replyReasoning = lastAssistant.reasoningContent ?? ''
            track('chat.message.received', {
              trace_id: traceId,
              session_id: hashText(sessionId),
              text: truncateText(replyText, 16384),
              text_len: replyText.length,
              reasoning_text: replyReasoning
                ? truncateText(replyReasoning, 16384)
                : undefined,
              reasoning_len: replyReasoning.length,
              paused: false,
            })
          }
          updateSessionRuntime(sessionId, {
            paused: false,
            pendingContent: '',
            streamingMessageId: null,
          })
          events?.onStreamEnd?.(sessionId)
          events?.onMessagesUpdate?.(sessionId)
        }
        // TS 引擎路径兜底：整批落库当前消息（覆盖 assistant 流式最终内容）
        persistMessagesIfNeeded(sessionId, getSessionMessages(sessionId))
        break
      }

      case 'error': {
        markErrored(sessionId)
        const errSess = sessionStore.getSession(sessionId)
        const errMsg = event.error || '未知错误'
        const httpMatch = /API Error \((\d{3})\)/.exec(errMsg)
        trackError('chat.stream.error', errMsg, {
          traceId,
          props: {
            ...(errSess ? { provider_type: providerTypeOf(errSess) } : {}),
            partial_len: (sessionRt.pendingContent || '').length,
            paused: !!sessionRt.paused,
            http_status: httpMatch ? Number(httpMatch[1]) : undefined,
          },
        })
        events?.onError?.(
          sessionId,
          transformApiError(event.error || '未知错误'),
        )
        break
      }
    }
  }
}

/** 完成工作（清理 runtime state on non-pause） */
async function finishWorking(
  sessionId: string,
  sessionRt: ReturnType<typeof getSessionRuntime>,
  events?: ChatServiceEvents,
  content?: MessageContent,
  traceId?: string,
): Promise<void> {
  const snapshot = await getEngine().getRunSnapshot(sessionId)

  const isPaused = !!snapshot
  const tr = activeTraces.get(sessionId)
  if (traceId) {
    track('engine.finish', {
      trace_id: traceId,
      total_ms: tr ? Date.now() - tr.startTime : undefined,
      rounds: tr?.rounds,
      tool_calls_total: tr?.toolCallIds.size,
      status: tr?.errored ? 'fail' : 'success',
      paused: isPaused,
    })
  }
  // 无论是否带 traceId 都回收链路上下文：恢复暂停（resumePausedRun）等
  // 未传 traceId 的路径也必须清理，否则 activeTraces / sessionTraces 持续残留。
  activeTraces.delete(sessionId)
  clearSessionTrace(sessionId)
  updateSessionRuntime(sessionId, {
    working: isPaused,
    paused: isPaused,
  })

  if (!isPaused) {
    updateSessionRuntime(sessionId, {
      pendingContent: '',
      streamingMessageId: null,
    })
    events?.onWorkingChange?.(sessionId, false)
    events?.onMessagesUpdate?.(sessionId)
  }

  // 自动设置标题（仅 session 标题仍为默认值时触发一次）
  // 优先让 AI 生成标题，失败则回退到用户消息截取
  if (!isPaused && content) {
    const updatedSession = sessionStore.getSession(sessionId)
    if (updatedSession && updatedSession.title === '新对话') {
      const text = extractText(content)
      const fallbackTitle = text.slice(0, 30) + (text.length > 30 ? '...' : '')
      let title = fallbackTitle
      const titleStart = Date.now()
      let titleStatus: 'ai' | 'fallback' | 'fail' = 'fallback'
      let titleError: string | undefined
      try {
        const aiTitle = await getEngine().generateTitle(
          updatedSession,
          getSessionMessages(sessionId),
        )
        if (aiTitle) {
          title = aiTitle
          titleStatus = 'ai'
        }
      } catch (e: any) {
        titleStatus = 'fail'
        titleError = e?.message || String(e)
        console.warn('[chat-service] AI 生成标题失败，回退到用户消息截取:', e)
      }
      track('chat.title.generate', {
        status: titleStatus,
        duration_ms: Date.now() - titleStart,
        error: titleError,
      })
      // 二次检查：标题可能已被用户手动修改或并发设置
      const current = sessionStore.getSession(sessionId)
      if (current && current.title === '新对话') {
        sessionStore.updateSession(sessionId, { title })
      }
    }
  }
}

export async function getRunSnapshot(sessionId: string) {
  return await getEngine().getRunSnapshot(sessionId)
}

export async function compressContext(sessionId: string) {
  try {
    sessionRuntimeState.setCompacting(sessionId, true)
    const session = sessionStore.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
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
    const result = await getEngine().compressContext(session, allMessages)
    replaceSessionMessages(sessionId, result.messages)
    track('chat.context.compress', {
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
        messages: result.messages,
      })
    } catch {}
  } catch (e: any) {
    const errorMsg = e?.message || String(e)
    showToast('压缩失败：' + errorMsg, 2000)
  } finally {
    sessionRuntimeState.setCompacting(sessionId, false)
  }
}

/**
 * 修复会话消息异常（如未响应的 tool call）
 * 切换会话时由 UI 触发，由 Application 层执行业务规则
 */
export function repairSessionIfNeeded(
  sessionId: string,
  isWorking?: boolean,
): void {
  checkAndRepairMessageList(sessionId, isWorking)
}

// ==================== 消息 CRUD（原 messages.ts，合并至 Service 层） ====================

export function addSessionMessage(
  sessionId: string,
  message: Message,
): Message | null {
  let added: Message | null = null
  runInAction(() => {
    const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return
    const session = sessionStore.value.sessions[idx]
    const existing = message.toolCallId
      ? session.messages.find((m) => m.toolCallId === message.toolCallId)
      : undefined
    if (existing) {
      if (existing.role === 'tool' && message.role === 'tool') {
        const msgs = [...session.messages]
        const msgIdx = msgs.findIndex((m) => m.id === existing.id)
        msgs[msgIdx] = { ...message, id: existing.id }
        session.messages = msgs
        session.updatedAt = Date.now()
        sessionStore.messagesChanged(sessionId)
        added = msgs[msgIdx]
      }
      return
    }
    session.messages = [...session.messages, message]
    session.updatedAt = Date.now()
    sessionStore.messagesChanged(sessionId)
    added = message
  })
  // TS 引擎路径：新增/更新的消息立即落库（Rust 引擎路径由引擎内部直落）
  if (added) persistMessagesIfNeeded(sessionId, [added])
  return added
}

export function updateSessionMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<Message>,
): Message | null {
  return runInAction(() => {
    const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return null
    const session = sessionStore.value.sessions[idx]
    const msgIdx = session.messages.findIndex((m) => m.id === messageId)
    if (msgIdx === -1) return null
    const msgs = [...session.messages]
    msgs[msgIdx] = { ...msgs[msgIdx], ...patch }
    session.messages = msgs
    sessionStore.messagesChanged(sessionId)
    return msgs[msgIdx]
  })
}

export function getSessionMessages(sessionId: string): Message[] {
  const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
  return session ? [...session.messages] : []
}

/**
 * 删除指定消息及其之后的所有消息（不支持删除 tool 消息）
 */
export function deleteSessionMessage(
  sessionId: string,
  messageId: string,
): boolean {
  return runInAction(() => {
    const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
    if (!session) return false

    const msgIdx = session.messages.findIndex((m) => m.id === messageId)
    if (msgIdx === -1) return false

    // 不允许手动删除 tool 消息
    if (session.messages[msgIdx].role === 'tool') return false

    // 删除该消息及之后所有消息
    session.messages = session.messages.slice(0, msgIdx)
    session.updatedAt = Date.now()
    sessionStore.messagesChanged(sessionId)
    return true
  })
}

export function clearSessionMessages(sessionId: string): boolean {
  return runInAction(() => {
    const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
    if (idx === -1) return false
    const sessions = [...sessionStore.value.sessions]
    sessions[idx] = {
      ...sessions[idx],
      messages: [],
      updatedAt: Date.now(),
    }
    sessionStore.value.sessions = sessions
    sessionStore.messagesChanged(sessionId)
    return true
  })
}

/**
 * 原子替换整个会话的消息列表（用于上下文压缩等场景）
 */
export function replaceSessionMessages(
  sessionId: string,
  messages: Message[],
): boolean {
  return runInAction(() => {
    const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
    if (!session) return false
    session.messages = messages
    sessionStore.messagesChanged(sessionId)
    return true
  })
}

export function checkAndRepairMessageList(
  sessionId: string,
  isWorking?: boolean,
): void {
  if (isWorking) return

  let repairedCount = 0
  runInAction(() => {
    const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
    if (!session) return

    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]
      if (msg.role === 'assistant') {
        if (!msg.toolCalls || msg.toolCalls.length === 0) {
          break
        }
        const noRepMsg = msg.toolCalls.filter(
          (tc) => !session.messages.some((m) => m.toolCallId === tc.id),
        )
        if (noRepMsg.length === 0) break

        const repairMessages: Message[] = noRepMsg.map((tc) => ({
          id: v4(),
          role: 'tool' as const,
          content: 'abnormal termination',
          toolCallId: tc.id,
          timestamp: Date.now(),
          isError: true,
        }))
        repairedCount = noRepMsg.length
        session.messages = [...session.messages, ...repairMessages]
        session.updatedAt = Date.now()
        sessionStore.messagesChanged(sessionId)
        break
      }
    }
  })
  if (repairedCount > 0) {
    track('session.repair', {
      session_id: hashText(sessionId),
      repaired_count: repairedCount,
    })
  }
}
