/**
 * Tool 执行器 — 逐步骤执行 tool calls、处理用户交互、管理 result 消息
 *
 * 从 engine/index.ts 拆分，所有函数为无状态纯函数。
 */
import { v4 } from '@/utils/uuid'
import { CmdError } from '@/infrastructure/tools/builtin/execute-command'
import { checkToolCallStorm } from './storm-breaker'
import type { Message, AgentEventCallback } from '@/types'
import type { Run, ToolStep } from './types'
import { findNextStep, runToSnapshot } from './run-state'
import {
  ToolContext,
  ToolExecutorResponse,
  UserInteractionRequired,
} from '../tools/types'
import { toolRegistry } from '../tools'
import { toolOutputStore } from '@/infrastructure/tools/output-store'

// ==================== 导出函数 ====================

/**
 * 从 tool call 上下文创建 Run
 */
export function createRun(
  sessionId: string,
  ctx: {
    assistantMessage: Message
    toolUses: { id: string; name: string; input: Record<string, any> }[]
  },
): Run {
  return {
    id: `run_${ctx.assistantMessage.id}`,
    sessionId,
    assistantMessageId: ctx.assistantMessage.id,
    steps: ctx.toolUses.map((tc) => ({
      toolCallId: tc.id,
      toolName: tc.name,
      input: tc.input,
      status: 'pending' as const,
    })),
    createdAt: Date.now(),
    paused: false,
    round: 0,
  }
}

/**
 * 逐步骤执行 run 中的工具调用。
 * 从第一个非 completed 的 step 开始，遇到暂停时保存进度并返回 false。
 * 全部执行完毕返回 true。
 *
 * ⚠️ 不再接收或修改 currentMessages — 调用方 engine.ts 负责整合返回的 toolResultMessages。
 *
 * 注意：tool executor 通过返回值而非异常来传递交互信号。
 *   - 返回 string → 正常结果
 *   - 返回 UserInteractionRequired → 需要用户交互，engine 调用 onUserInteraction 等待 UI
 *   - 返回 Error 实例 → 执行错误
 */
export async function executeToolSteps(
  run: Run,
  abortSignal: AbortSignal,
  onEvent?: AgentEventCallback,
  onUserInteraction?: (
    type: string,
    data: Record<string, any>,
  ) => Promise<ToolExecutorResponse>,
  skills?: string[],
  persistSnapshot?: (run: Run) => void,
): Promise<{ completed: boolean; toolResultMessages: Message[] }> {
  const sessionId = run.sessionId
  const startIndex = findNextStep(run)
  const toolResultMessages: Message[] = []

  for (let i = startIndex; i < run.steps.length; i++) {
    const step = run.steps[i]
    step.status = 'running'
    step.startedAt = Date.now()

    notifyStepStart(step, onEvent)
    const toolResult = await executeSingleStep(
      sessionId,
      step,
      abortSignal,
      onEvent,
      onUserInteraction,
      skills,
    )

    // 检查是否被暂停
    if (toolResult === '__SHELVED__') {
      run.paused = true
      persistSnapshot?.(run)
      onEvent?.({
        type: 'stream_end',
        data: { paused: true, snapshot: runToSnapshot(run) },
      })
      return { completed: false, toolResultMessages }
    }

    const toolResultMsg = handleToolResult(step, toolResult, onEvent)
    toolResultMessages.push(toolResultMsg)

    if (abortSignal.aborted) return { completed: false, toolResultMessages }
    persistSnapshot?.(run)
  }

  return { completed: true, toolResultMessages }
}

// ==================== 内部函数 ====================

/**
 * 通知 UI 当前步骤开始执行
 */
function notifyStepStart(step: ToolStep, onEvent?: AgentEventCallback): void {
  onEvent?.({
    type: 'tool_call',
    data: {
      type: 'tool_use',
      id: step.toolCallId,
      name: step.toolName,
      input: step.input,
    },
  })
}

/**
 * 执行单个 tool step，返回结果字符串或特殊标记
 */
async function executeSingleStep(
  sessionId: string,
  step: ToolStep,
  abortSignal: AbortSignal,
  onEvent?: AgentEventCallback,
  onUserInteraction?: (
    type: string,
    data: Record<string, any>,
  ) => Promise<ToolExecutorResponse>,
  skills?: string[],
): Promise<string> {
  const tool = await toolRegistry.get(step.toolName)

  if (!tool) {
    step.status = 'failed'
    step.error = 'tool not found'
    return `Tool "${step.toolName}" not found. Available tools: ${(
      await toolRegistry.listDefinitions()
    )
      .map((t) => t.name)
      .join(', ')}`
  }

  toolOutputStore.register(step.toolCallId, {
    toolName: step.toolName,
    output: '',
  })

  // StormBreaker: 检测工具调用循环
  if (checkToolCallStorm(sessionId, step.toolName, step.input)) {
    step.status = 'failed'
    step.error = '检测到工具调用循环，已自动拦截'
    return `[StormBreaker] 工具 "${step.toolName}" 在最近几次调用中重复出现，已自动拦截。请重新思考策略，尝试不同的方法或直接给出最终回答。`
  }

  const toolCtx: ToolContext = {
    sessionId,
    toolCallId: step.toolCallId,
    abortSignal,
    write: (chunk: string) => {
      toolOutputStore.append(step.toolCallId, chunk)
    },
    skills,
  }

  try {
    const execResult = await tool.executor(step.input, toolCtx)

    let rawResult: string
    let uiData: Record<string, any> | undefined

    if (execResult instanceof UserInteractionRequired && onUserInteraction) {
      return await handleUserInteraction(step, execResult, onUserInteraction)
    }

    if (execResult instanceof Error || execResult instanceof CmdError) {
      step.status = 'failed'
      step.error = execResult.message
      return execResult.message
    }

    // ToolResult 对象：拆出 content + uiData
    if (typeof execResult === 'object' && 'content' in execResult) {
      rawResult = execResult.content
      uiData = execResult.uiData
    } else {
      // 兼容旧格式：直接返回 string
      rawResult = String(execResult)
    }

    step.status = 'completed'
    step.result = rawResult
    step.uiData = uiData
    return rawResult
  } catch (e: any) {
    const msg = e.message || String(e)
    step.status = 'failed'
    step.error = msg
    return `error: ${msg}`
  }
}

/**
 * 处理用户交互（等待/暂存/取消）
 */
async function handleUserInteraction(
  step: ToolStep,
  execResult: UserInteractionRequired,
  onUserInteraction: (
    type: string,
    data: Record<string, any>,
  ) => Promise<ToolExecutorResponse>,
): Promise<string> {
  try {
    const result = await onUserInteraction(execResult.interactionType, {
      ...execResult.interactionData,
      toolCallId: step.toolCallId,
    })

    if (result instanceof Error || result instanceof CmdError) {
      step.status = 'failed'
      step.error = result.message
      return result.message
    }

    let rawResult: string
    let uiData: Record<string, any> | undefined

    // ToolResult 对象：拆出 content + uiData
    if (typeof result === 'object' && 'content' in result) {
      rawResult = result.content
      uiData = result.uiData
    } else {
      rawResult = String(result)
    }
    step.status = 'completed'
    step.result = rawResult
    step.uiData = uiData
    return rawResult
  } catch (userErr: any) {
    if (userErr?.name === 'InteractionShelved') {
      return '__SHELVED__'
    }
    // 用户取消
    const result = '[User cancelled]'
    step.status = 'failed'
    step.result = result
    return result
  }
}

/**
 * tool step 完成后，推送最终输出并插入 tool_result 消息
 * 返回创建的 Message 对象，调用方复用该对象推入 currentMessages
 */
function handleToolResult(
  step: ToolStep,
  toolResult: string,
  onEvent?: AgentEventCallback,
): Message {
  toolOutputStore.flush(step.toolCallId)

  const elapsedMs = step.startedAt ? Date.now() - step.startedAt : undefined
  const toolResultMessage: Message = {
    id: v4(),
    role: 'tool',
    content: toolResult,
    toolCallId: step.toolCallId,
    isError: step.status === 'failed',
    elapsedMs,
    uiData: step.uiData,
    timestamp: Date.now(),
  }
  // 通过事件通知 chat-service 持久化
  onEvent?.({
    type: 'tool_result_created',
    data: { message: toolResultMessage },
  })

  onEvent?.({
    type: 'tool_call',
    data: {
      type: 'tool_use',
      id: step.toolCallId,
      name: step.toolName,
      input: step.input,
      result: toolResult,
    },
  })

  toolOutputStore.remove(step.toolCallId)

  return toolResultMessage
}
