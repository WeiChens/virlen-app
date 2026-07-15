/**
 * LLM 调用处理 — 流式/非流式请求、tool_use 收集
 *
 * 从 engine/index.ts 拆分，所有函数为无状态纯函数，不依赖 class this。
 */
import { v4 } from '@/utils/uuid'
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
          usage: assistantMessage.usage,
          model,
        },
      },
    })
  }

  if (session.params.stream) {
    await handleStreaming(
      provider,
      request,
      ctx,
      syncAssistant,
      onEvent,
      abortSignal,
    )
  } else {
    await handleNonStreaming(provider, request, ctx, abortSignal)
  }

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
  await provider.chatStream(
    request,
    (event: StreamEvent) => {
      switch (event.type) {
        case 'text_delta':
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
function finalizeAssistantMessage(
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
        usage: assistantMessage.usage,
        model,
      },
    },
  })
}
