/**
 * 迭代控制器 — 编排 LLM调用→工具执行→验证→反馈 的循环
 *
 * 核心流程：
 *   用户输入 Goal ─► LLM Round (think + act) ─► 执行 Tools
 *       ─► LLMVerifier 验证 ─► ✅ 通过 → 结束
 *                            ─► ❌ 未通过 → 注入反馈 → 回到 LLM Round
 *
 * 设计决策（见 plan.md）：
 * - 同一模型验证：使用与执行相同的模型
 * - 验证时机：每次 tool 执行完毕后立即验证
 * - 反馈注入：以 user 角色消息注入
 * - 最大迭代：默认 5 次，超出后以失败状态结束
 */
import type { Message, Session, AgentEventCallback } from '@/types'
import type { IProvider } from '@/infrastructure/provider/types'
import type { ToolDefinition } from '../tools/types'
import type { RunSnapshot, ToolCallContext } from './types'
import type {
  Goal,
  IterationSession,
  IterationEventCallback,
} from './iteration-types'
import { buildFeedbackMessage } from './iteration-types'
import { llmVerifier } from './verifier'
import { doLLMRound } from './llm-round'
import { createRun, executeToolSteps } from './tool-executor'
import { clearToolCallHistory } from './storm-breaker'

/** 迭代控制器配置 */
export interface IterationControllerConfig {
  /** 最大迭代次数，默认 5 */
  maxIterations?: number
  /** 迭代事件回调 */
  onIterationEvent?: IterationEventCallback
}

/** 默认最大迭代次数 */
const DEFAULT_MAX_ITERATIONS = 5

/**
 * 迭代控制器
 *
 * 包装现有的 LLM Round + Tool 执行逻辑，在每轮之后插入验证步骤。
 * 与 AgentEngine 协作：引擎负责 provider 生命周期和快照管理，
 * 控制器负责迭代循环编排。
 */
export class IterationController {
  private config: Required<IterationControllerConfig>

  constructor(config: IterationControllerConfig = {}) {
    this.config = {
      maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      onIterationEvent: config.onIterationEvent ?? (() => {}),
    }
  }

  /**
   * 运行迭代循环
   *
   * @returns true = 目标达成，false = 超出最大迭代次数
   */
  async run(params: {
    goal: Goal
    session: Session
    provider: IProvider
    toolDefs: ToolDefinition[] | undefined
    currentMessages: Message[]
    sessionId: string
    abortController: AbortController
    onEvent?: AgentEventCallback
    onUserInteraction?: (
      type: string,
      data: Record<string, any>,
    ) => Promise<any>
    skills?: string[]
    effectiveMaxTokens: number
    reasoningEffort?: string
    persistSnapshot: (sessionId: string, run: any) => void
    clearSnapshot: (sessionId: string) => void
  }): Promise<{ completed: boolean; messages: Message[] }> {
    const {
      goal,
      session,
      provider,
      toolDefs,
      currentMessages,
      sessionId,
      abortController,
      onEvent,
      onUserInteraction,
      skills,
      effectiveMaxTokens,
      reasoningEffort,
      persistSnapshot,
      clearSnapshot,
    } = params

    const model = session.modelId

    const iterSession: IterationSession = {
      goal,
      currentIteration: 0,
      maxIterations: this.config.maxIterations,
      verificationHistory: [],
    }

    this.config.onIterationEvent({
      type: 'iteration_start',
      data: { maxIterations: this.config.maxIterations },
    })

    let messages = [...currentMessages]

    while (iterSession.currentIteration < this.config.maxIterations) {
      iterSession.currentIteration++

      // 检查是否被取消
      if (abortController.signal.aborted) {
        return { completed: false, messages }
      }

      // ===== 1. LLM Round =====
      // 拦截事件以捕获 assistant 消息（ctx 为 null 时需要用到）
      let capturedAssistant: Message | null = null

      const interceptOnEvent: AgentEventCallback = (event) => {
        if (
          event.type === 'assistant_message_created' &&
          event.data?.message
        ) {
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
        toolDefs ?? [],
        messages,
        abortController.signal,
        interceptOnEvent,
        effectiveMaxTokens,
        reasoningEffort,
      )

      if (ctx) {
        // ===== 有 tool calls：执行工具 → 验证 =====
        messages.push(ctx.assistantMessage)
        this.#finalizeAssistantRound(ctx, model, onEvent)

        const run = createRun(sessionId, ctx)
        persistSnapshot(sessionId, run)

        const { completed: toolsDone, toolResultMessages } =
          await executeToolSteps(
            run,
            abortController.signal,
            onEvent,
            onUserInteraction,
            skills,
            (r) => persistSnapshot(sessionId, r),
          )

        for (const msg of toolResultMessages) {
          messages.push(msg)
        }

        if (!toolsDone) {
          return { completed: false, messages }
        }

        clearSnapshot(sessionId)
      } else {
        // ===== 没有 tool calls：LLM 直接给出了文字回答 =====
        // 把捕获到的 assistant 消息加入消息列表，供验证器使用
        if (capturedAssistant) {
          messages.push(capturedAssistant)
        }
      }

      // ===== 2. 验证 =====
      this.config.onIterationEvent({
        type: 'iteration_verify_start',
        data: { iteration: iterSession.currentIteration },
      })

      const verifyResult = await llmVerifier.verify(
        provider,
        session,
        goal,
        messages,
      )

      this.config.onIterationEvent({
        type: 'iteration_verify_end',
        data: { iteration: iterSession.currentIteration },
      })

      iterSession.verificationHistory.push(verifyResult)

      if (verifyResult.passed) {
        this.config.onIterationEvent({
          type: 'iteration_verify_pass',
          data: {
            iteration: iterSession.currentIteration,
            result: verifyResult,
          },
        })
        this.config.onIterationEvent({
          type: 'iteration_end',
          data: {
            iteration: iterSession.currentIteration,
            maxIterations: this.config.maxIterations,
            summary: `目标在第 ${iterSession.currentIteration} 次迭代后达成`,
          },
        })
        return { completed: true, messages }
      }

      // ===== 3. 验证未通过：注入反馈，继续下一轮 =====
      this.config.onIterationEvent({
        type: 'iteration_verify_fail',
        data: {
          iteration: iterSession.currentIteration,
          result: verifyResult,
        },
      })

      const feedbackMsg = buildFeedbackMessage(verifyResult)
      messages.push(feedbackMsg)

      onEvent?.({
        type: 'assistant_message_created',
        data: { message: feedbackMsg },
      })
    }

    // 超出最大迭代次数
    this.config.onIterationEvent({
      type: 'iteration_max_exceeded',
      data: {
        iteration: iterSession.currentIteration,
        maxIterations: this.config.maxIterations,
      },
    })
    this.config.onIterationEvent({
      type: 'iteration_end',
      data: {
        iteration: iterSession.currentIteration,
        maxIterations: this.config.maxIterations,
        summary: `超出最大迭代次数 (${this.config.maxIterations})，目标未完全达成`,
      },
    })

    // 生成失败报告
    const failureReport = this.#buildFailureReport(iterSession)
    messages.push(failureReport)

    onEvent?.({
      type: 'assistant_message_created',
      data: { message: failureReport },
    })

    return { completed: true, messages }
  }

  /** 完成一轮 assistant 消息的流式标记 */
  #finalizeAssistantRound(
    ctx: ToolCallContext,
    model: string,
    onEvent?: AgentEventCallback,
  ): void {
    ctx.assistantMessage.streaming = false
    onEvent?.({
      type: 'assistant_message_updated',
      data: {
        messageId: ctx.assistantMessage.id,
        patch: {
          content: ctx.assistantMessage.content,
          streaming: false,
          toolCalls: ctx.assistantMessage.toolCalls,
          reasoningContent: ctx.assistantMessage.reasoningContent,
          usage: ctx.assistantMessage.usage,
          model,
        },
      },
    })
  }

  /** 构建失败报告消息 */
  #buildFailureReport(iterSession: IterationSession): Message {
    const historySummary = iterSession.verificationHistory
      .map(
        (v, i) =>
          `第 ${i + 1} 次: ${v.passed ? '✅' : '❌'} ${v.summary}`,
      )
      .join('\n')

    const content = [
      '【迭代结束报告】',
      '',
      `目标: ${iterSession.goal.description}`,
      `总迭代次数: ${iterSession.currentIteration}/${iterSession.maxIterations}`,
      `最终状态: ❌ 未完全达成`,
      '',
      '各轮验证结果:',
      historySummary,
      '',
      '已达到最大迭代次数限制。请检查执行结果，考虑：',
      '1. 调整目标描述，使其更具体明确',
      '2. 手动完成剩余步骤',
      '3. 增加最大迭代次数后重试',
    ].join('\n')

    return {
      id: `failure_report_${Date.now()}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    }
  }
}

/**
 * 创建默认配置的迭代控制器
 */
export function createIterationController(
  config?: IterationControllerConfig,
): IterationController {
  return new IterationController(config)
}
