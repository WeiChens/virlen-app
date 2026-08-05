/**
 * LLM 轮次编排 — 合并「LLM 调用 → 工具执行」为一个共享步骤
 *
 * 从 engine.ts / iteration-controller.ts 抽取，消除两处重复的工具循环编排逻辑。
 * 两处调用方只需要：
 *   - 把本轮返回的 assistantMessage / toolResultMessages 合并进自己的消息列表
 *   - 根据 paused 判断是否被暂停/取消（快照保留，供断点恢复）
 */
import type { Message, Session, AgentEventCallback } from '@/types'
import type { IProvider } from '@/infrastructure/provider/types'
import type { ToolDefinition, ToolExecutorResponse } from '../tools/types'
import type { Run, ToolCallContext } from './types'
import { doLLMRound, finalizeAssistantMessage } from './llm-round'
import { createRun, executeToolSteps } from './tool-executor'

export interface ExecuteLLMRoundParams {
  session: Session
  provider: IProvider
  toolDefs: ToolDefinition[]
  messages: Message[]
  sessionId: string
  abortSignal: AbortSignal
  onEvent?: AgentEventCallback
  onUserInteraction?: (
    type: string,
    data: Record<string, any>,
  ) => Promise<ToolExecutorResponse>
  skills?: string[]
  effectiveMaxTokens: number
  reasoningEffort?: string
  persistSnapshot?: (sessionId: string, run: Run) => void
  clearSnapshot?: (sessionId: string) => void
}

export interface ExecuteLLMRoundResult {
  /** 非 null 表示本轮有 tool calls（需要把 assistantMessage + toolResultMessages 合并进消息列表） */
  ctx: ToolCallContext | null
  /** 本轮 assistant 消息（无论是否有 tool calls，供验证器/后续轮次使用） */
  assistantMessage: Message
  /** tool 执行产生的 result 消息 */
  toolResultMessages: Message[]
  /** 是否被暂停（用户暂存）或取消 — 快照保留，供断点恢复 */
  paused: boolean
}

/**
 * 执行一轮「LLM 调用 →（如有 tool calls）执行工具」。
 *
 * 行为与旧版 #executeToolLoop / IterationController 内联逻辑完全一致：
 * - 没有 tool calls：doLLMRound 内部已 finalize，返回 ctx=null
 * - 有 tool calls：finalize → 创建 Run → 逐步执行工具 → 成功则清除快照
 * - 被暂停/取消：不清除快照，返回 paused=true
 */
export async function executeLLMRound(
  params: ExecuteLLMRoundParams,
): Promise<ExecuteLLMRoundResult> {
  const {
    session,
    provider,
    toolDefs,
    messages,
    sessionId,
    abortSignal,
    onEvent,
    onUserInteraction,
    skills,
    effectiveMaxTokens,
    reasoningEffort,
    persistSnapshot,
    clearSnapshot,
  } = params
  const model = session.modelId

  // 拦截事件以捕获 assistant 消息（ctx 为 null 时调用方仍需要拿到本轮消息）
  let capturedAssistant: Message | null = null
  const interceptOnEvent: AgentEventCallback = (event) => {
    if (event.type === 'assistant_message_created' && event.data?.message) {
      capturedAssistant = { ...event.data.message }
    }
    if (
      event.type === 'assistant_message_updated' &&
      event.data?.patch &&
      capturedAssistant
    ) {
      Object.assign(capturedAssistant, event.data.patch)
    }
    onEvent?.(event)
  }

  const ctx = await doLLMRound(
    session,
    provider,
    toolDefs,
    messages,
    abortSignal,
    interceptOnEvent,
    effectiveMaxTokens,
    reasoningEffort,
  )

  // 没有 tool calls：LLM 直接给出文字回答（doLLMRound 已内部 finalize）
  if (!ctx) {
    return {
      ctx: null,
      assistantMessage:
        capturedAssistant ??
        ({
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
        } satisfies Message),
      toolResultMessages: [],
      paused: false,
    }
  }

  // 有 tool calls：结束 streaming 标记
  finalizeAssistantMessage(ctx.assistantMessage, model, onEvent)

  const run = createRun(sessionId, ctx)
  persistSnapshot?.(sessionId, run)

  const { completed, toolResultMessages } = await executeToolSteps(
    run,
    abortSignal,
    onEvent,
    onUserInteraction,
    skills,
    (r) => persistSnapshot?.(sessionId, r),
  )

  if (!completed) {
    // 被暂停（用户暂存）或取消 — 快照保留，供断点恢复
    return {
      ctx,
      assistantMessage: ctx.assistantMessage,
      toolResultMessages,
      paused: true,
    }
  }

  clearSnapshot?.(sessionId)
  return {
    ctx,
    assistantMessage: ctx.assistantMessage,
    toolResultMessages,
    paused: false,
  }
}
