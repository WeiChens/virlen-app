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
 * 发送消息 — 纯数据层操作
 *
 * 会：
 * 1. 确保 session 存在
 * 2. **创建并持久化用户消息**（服务层职责，而非 engine 内部处理）
 * 3. 调用 agentEngine.sendMessage（已跳过用户消息创建）并处理事件
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

  try {
    await agentEngine.sendMessage({
      maxTokens: settingsState.value.maxTokens,
      session,
      messages: currentMessages,
      reasoningEffort,
      onEvent: createEventHandler(sessionId, sessionRt, events),
      onUserInteraction: toolInteract.handler,
      maxToolRounds: settingsState.value.maxToolRounds,
    })
  } catch (e: any) {
    events?.onError?.(sessionId, transformApiError(e.message || '错误'))
  } finally {
    toolInteract.cleanup()
  }

  finishWorking(sessionId, sessionRt, events, content)
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

  const snapshot = await agentEngine.getRunSnapshot(sessionId)
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

  try {
    await agentEngine.sendMessage({
      maxTokens: settingsState.value.maxTokens,
      resumeFromSnapshot: snapshot,

      session,
      messages: currentMessages,
      reasoningEffort,
      onEvent: createEventHandler(sessionId, sessionRt, events),
      onUserInteraction: toolInteract.handler,
      maxToolRounds: settingsState.value.maxToolRounds,
    })
  } catch (e: any) {
    events?.onError?.(sessionId, e.message || '错误')
  } finally {
    toolInteract.cleanup()
  }

  // 恢复完成后，检查是否仍有未清除的快照（engine 成功完成所有工具后可能未清理）
  // 若没有 pending 的工具步骤，则主动清除快照，避免 finishWorking 误判为暂停状态
  const remainingSnapshot = await agentEngine.getRunSnapshot(sessionId)
  if (
    remainingSnapshot &&
    remainingSnapshot.steps.every((s) => s && s.status === 'completed')
  ) {
    await agentEngine.clearRunSnapshot(sessionId)
  }

  finishWorking(sessionId, sessionRt, events)
}

/**
 * 取消当前正在处理的请求（非暂停状态）
 */
export async function cancelMessage(sessionId: string): Promise<void> {
  if (sessionId) {
    await agentEngine.cancel(sessionId)
  }
}

/**
 * 取消暂停状态的 tool run — 给所有未完成的 step 注入空 tool_result，清除快照
 *
 * 这是暂停状态下「取消」按钮的唯一入口。
 * UI 调完此方法后直接更新自己的 loading 状态即可。
 */
export async function cancelPausedRun(sessionId: string): Promise<void> {
  const snapshot = await agentEngine.getRunSnapshot(sessionId)
  if (!snapshot) {
    await agentEngine.cancel(sessionId)
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
  await agentEngine.clearRunSnapshot(sessionId)
  await agentEngine.cancel(sessionId)
}

// ==================== 内部工具函数 ====================
/** 创建通用事件处理器 */
function createEventHandler(
  sessionId: string,
  sessionRt: ReturnType<typeof getSessionRuntime>,
  events?: ChatServiceEvents,
): AgentEventCallback {
  return (event) => {
    switch (event.type) {
      case 'stream_event':
        updateSessionRuntime(sessionId, {
          pendingContent:
            (sessionRt.pendingContent || '') + (event.data?.delta || ''),
          streamingMessageId: event.data?.messageId || null,
        })
        events?.onPendingContent?.(sessionId, event.data?.delta || '')
        events?.onMessagesUpdate?.(sessionId)
        break

      case 'assistant_message_created':
        // engine 创建了 assistant 消息，需要持久化
        if (event.data?.message) {
          addSessionMessage(sessionId, event.data.message)
          events?.onMessagesUpdate?.(sessionId)
        }
        break

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

      case 'tool_call':
        events?.onMessagesUpdate?.(sessionId)
        break

      case 'stream_end':
        if (event.data?.paused) {
          updateSessionRuntime(sessionId, { paused: true })
          events?.onMessagesUpdate?.(sessionId)
        } else {
          updateSessionRuntime(sessionId, {
            paused: false,
            pendingContent: '',
            streamingMessageId: null,
          })
          events?.onStreamEnd?.(sessionId)
          events?.onMessagesUpdate?.(sessionId)
        }
        break

      case 'error':
        events?.onError?.(
          sessionId,
          transformApiError(event.error || '未知错误'),
        )
        break
    }
  }
}

/** 完成工作（清理 runtime state on non-pause） */
async function finishWorking(
  sessionId: string,
  sessionRt: ReturnType<typeof getSessionRuntime>,
  events?: ChatServiceEvents,
  content?: MessageContent,
): Promise<void> {
  const snapshot = await agentEngine.getRunSnapshot(sessionId)

  const isPaused = !!snapshot
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
  if (!isPaused && content) {
    const updatedSession = sessionStore.getSession(sessionId)
    if (updatedSession && updatedSession.title === '新对话') {
      const text = extractText(content)
      const title = text.slice(0, 30) + (text.length > 30 ? '...' : '')
      sessionStore.updateSession(sessionId, { title })
    }
  }
}

export async function getRunSnapshot(sessionId: string) {
  return await agentEngine.getRunSnapshot(sessionId)
}

export async function compressContext(sessionId: string) {
  try {
    sessionRuntimeState.setCompacting(sessionId, true)
    const session = sessionStore.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const allMessages = getSessionMessages(sessionId)
    const result = await agentEngine.compressContext(session, allMessages)
    replaceSessionMessages(sessionId, result.messages)
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
  const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) return null
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
      return msgs[msgIdx]
    }
    return null
  }
  session.messages = [...session.messages, message]
  session.updatedAt = Date.now()
  sessionStore.messagesChanged(sessionId)
  return message
}

export function updateSessionMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<Message>,
): Message | null {
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
}

export function clearSessionMessages(sessionId: string): boolean {
  const idx = sessionStore.value.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) return false
  const sessions = [...sessionStore.value.sessions]
  sessions[idx] = {
    ...sessions[idx],
    messages: [],
    updatedAt: Date.now(),
  }
  sessionStore.messagesChanged(sessionId)
  return true
}

/**
 * 原子替换整个会话的消息列表（用于上下文压缩等场景）
 */
export function replaceSessionMessages(
  sessionId: string,
  messages: Message[],
): boolean {
  const session = sessionStore.value.sessions.find((s) => s.id === sessionId)
  if (!session) return false
  session.messages = messages
  sessionStore.messagesChanged(sessionId)
  return true
}

export function checkAndRepairMessageList(
  sessionId: string,
  isWorking?: boolean,
): void {
  if (isWorking) return

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
      session.messages = [...session.messages, ...repairMessages]
      session.updatedAt = Date.now()
      sessionStore.messagesChanged(sessionId)
      break
    }
  }
}
