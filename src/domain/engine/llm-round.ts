/**
 * LLM 调用处理 — 流式/非流式请求、tool_use 收集
 *
 * 从 engine/index.ts 拆分，所有函数为无状态纯函数，不依赖 class this。
 */
import { v4 } from '@/utils/uuid'
import { track, getSessionTrace } from '@/utils/telemetry'
import type {
  Message,
  ToolUseContent,
  StreamEvent,
  AgentEventCallback,
  Session,
} from '@/types'
import type { ToolCallContext } from './types'
import { ChatRequest, IProvider } from '@/infrastructure/provider/types'
import { ToolDefinition } from '../tools/types'

/** 粗估请求 token（字符数/4），仅用于埋点趋势，非精确计费 */
function estimateReqTokens(messages: Message[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b === 'object' && 'text' in b) {
          const t = (b as { text?: unknown }).text
          if (typeof t === 'string') chars += t.length
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}

// ==================== 导出函数 ====================

/**
 * 执行一轮 LLM 调用（流式 / 非流式），收集 text + tool_calls
 * 返回 null 表示没有 tool calls，结束循环
 */
export async function doLLMRound(
  session: Session,
  provider: IProvider,
  toolDefs: ToolDefinition[],
  currentMessages: Message[],
  abortSignal: AbortSignal,
  onEvent?: AgentEventCallback,
  overrideMaxTokens?: number,
  reasoningEffort?: string,
  round?: number,
): Promise<ToolCallContext | null> {
  const model = session.modelId
  const systemPrompt = session.systemPrompt || '你是一个有用的 AI 助手。'

  const assistantMessage: Message = {
    id: v4(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    streaming: true,
  }
  onEvent?.({
    type: 'assistant_message_created',
    data: { message: assistantMessage },
  })

  const ctx: ToolCallContext = {
    assistantMessage,
    toolUses: [],
    roundContent: '',
    reasoningContent: '',
  }

  const messages = currentMessages.filter((m) => m.id !== assistantMessage.id)

  const request: ChatRequest = {
    model,
    messages,
    systemPrompt,
    tools: toolDefs,
    temperature: session.params.temperature,
    topP: session.params.topP,
    maxTokens: overrideMaxTokens ?? session.params.maxTokens,
    stream: session.params.stream,
    tool_choice: 'auto',
  }

  if (reasoningEffort) {
    request.reasoningEffort = reasoningEffort
  }

  // 将会话链路 ID 透传给 provider 层（provider.* / sse.interrupt 埋点关联）
  const traceId = getSessionTrace(session.id)
  request.traceId = traceId

  const syncAssistant = () => {
    onEvent?.({
      type: 'assistant_message_updated',
      data: {
        messageId: assistantMessage.id,
        patch: {
          content: assistantMessage.content,
          streaming: true,
          toolCalls: assistantMessage.toolCalls,
          reasoningContent: assistantMessage.reasoningContent,
          reasoningElapsedMs: assistantMessage.reasoningElapsedMs,
          usage: assistantMessage.usage,
          model,
        },
      },
    })
  }

  const roundStart = Date.now()
  track('engine.round.start', {
    trace_id: traceId,
    round,
    msg_count: messages.length,
    req_tokens_est: estimateReqTokens(messages),
  })

  // 记录本轮是否出错：流式路径不抛错（仅回调 error），故需拦截 onEvent 捕获；
  // 非流式路径 provider.chat 会抛错，由下方 catch 捕获。用于 engine.round.end.status。
  let roundErrored = false
  let roundThrown: unknown = null
  const watchError: AgentEventCallback = (ev) => {
    if (ev.type === 'error') roundErrored = true
    onEvent?.(ev)
  }
  try {
    if (session.params.stream) {
      await handleStreaming(
        provider,
        request,
        ctx,
        syncAssistant,
        watchError,
        abortSignal,
      )
    } else {
      await handleNonStreaming(provider, request, ctx, abortSignal)
    }
  } catch (e) {
    roundErrored = true
    roundThrown = e
  }

  track('engine.round.end', {
    trace_id: traceId,
    round,
    duration_ms: Date.now() - roundStart,
    usage: ctx.assistantMessage.usage
      ? {
          prompt: ctx.assistantMessage.usage.promptTokens,
          completion: ctx.assistantMessage.usage.completionTokens,
          total: ctx.assistantMessage.usage.totalTokens,
        }
      : undefined,
    tool_uses_count: ctx.toolUses.length,
    status: abortSignal.aborted || roundErrored ? 'fail' : 'success',
  })

  // 非流式路径的异常在补发 round.end 后原样抛出，保持既有错误传播行为
  if (roundThrown) throw roundThrown

  // 没有 tool calls → 结束循环
  if (ctx.toolUses.length === 0) {
    finalizeAssistantMessage(ctx.assistantMessage, model, onEvent)
    return null
  }

  return ctx
}

/**
 * 流式 LLM 调用处理
 */
async function handleStreaming(
  provider: IProvider,
  request: ChatRequest,
  ctx: ToolCallContext,
  syncAssistant: () => void,
  onEvent?: AgentEventCallback,
  abortSignal?: AbortSignal,
): Promise<void> {
  /** 思考开始时间（毫秒），用于计算深度思考耗时 */
  let reasoningStartTime: number | null = null

  /** 结算思考耗时：思考开始 → 开始输出正文（或流结束） */
  const settleReasoningElapsed = () => {
    if (
      reasoningStartTime !== null &&
      ctx.assistantMessage.reasoningElapsedMs === undefined
    ) {
      ctx.assistantMessage.reasoningElapsedMs =
        Date.now() - reasoningStartTime
      reasoningStartTime = null
      syncAssistant()
    }
  }

  await provider.chatStream(
    request,
    (event: StreamEvent) => {
      switch (event.type) {
        case 'text_delta':
          // 首次输出正式内容 = 思考结束
          settleReasoningElapsed()
          ctx.roundContent += event.data || ''
          ctx.assistantMessage.content += event.data || ''
          syncAssistant()
          onEvent?.({
            type: 'stream_event',
            data: {
              delta: event.data,
              fullContent: ctx.assistantMessage.content,
            },
          })
          break
        case 'tool_use':
          if (event.toolUse) {
            collectToolUse(ctx, event.toolUse, syncAssistant, onEvent)
          }
          break
        case 'error':
          onEvent?.({ type: 'error', error: event.error })
          break
        case 'reasoning_content_change':
          if (event.data) {
            // 首次收到思考内容 = 思考开始
            if (reasoningStartTime === null) {
              reasoningStartTime = Date.now()
            }
            ctx.reasoningContent = event.data
            ctx.assistantMessage.reasoningContent = event.data
            syncAssistant()
            onEvent?.({
              type: 'stream_event',
              data: { reasoningContent: event.data },
            })
          }
          break
        case 'message_stop':
          // 流结束，若思考尚未结算则在此结算
          settleReasoningElapsed()
          if (event.reasoningContent) {
            ctx.reasoningContent = event.reasoningContent
            ctx.assistantMessage.reasoningContent = event.reasoningContent
            syncAssistant()
          }
          if (event.usage) {
            ctx.assistantMessage.usage = event.usage
            syncAssistant()
          }
          break
      }
    },
    abortSignal,
  )
}

/**
 * 非流式 LLM 调用处理
 */
async function handleNonStreaming(
  provider: IProvider,
  request: ChatRequest,
  ctx: ToolCallContext,
  abortSignal?: AbortSignal,
): Promise<void> {
  const response = await provider.chat(request, abortSignal)
  if (typeof response.content === 'string') {
    ctx.roundContent = response.content
    ctx.assistantMessage.content += response.content
  }
  if (response.toolCalls?.length) {
    ctx.toolUses.push(...response.toolCalls)
  }
}

/**
 * 收集 tool_use，去重并同步到 assistant 消息
 */
function collectToolUse(
  ctx: ToolCallContext,
  toolUse: ToolUseContent,
  syncAssistant: () => void,
  onEvent?: AgentEventCallback,
): void {
  const exists = ctx.toolUses.some((t) => t.id === toolUse.id)
  if (!exists) {
    ctx.toolUses.push(toolUse)
  }
  const alreadyInAssistant = ctx.assistantMessage.toolCalls?.some(
    (t) => t.id === toolUse.id,
  )
  if (!alreadyInAssistant) {
    ctx.assistantMessage.toolCalls = [
      ...(ctx.assistantMessage.toolCalls || []),
      toolUse,
    ]
    syncAssistant()
  }
  onEvent?.({ type: 'tool_call', data: toolUse })
}

/**
 * 收到 tool calls 后结束 assistant 消息的 streaming 状态（通过事件通知）
 */
export function finalizeAssistantMessage(
  assistantMessage: Message,
  model: string,
  onEvent?: AgentEventCallback,
): void {
  assistantMessage.streaming = false
  onEvent?.({
    type: 'assistant_message_updated',
    data: {
      messageId: assistantMessage.id,
      patch: {
        content: assistantMessage.content,
        streaming: false,
        toolCalls: assistantMessage.toolCalls,
        reasoningContent: assistantMessage.reasoningContent,
        reasoningElapsedMs: assistantMessage.reasoningElapsedMs,
        usage: assistantMessage.usage,
        model,
      },
    },
  })
}
