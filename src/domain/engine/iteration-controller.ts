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
import type {
  Goal,
  IterationSession,
  IterationEventCallback,
  VerificationResult,
} from './iteration-types'
import { buildFeedbackMessage } from './iteration-types'
import { llmVerifier } from './verifier'
import { executeLLMRound } from './llm-loop'

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

      // ===== 1. LLM Round + 工具执行（共享编排） =====
      const result = await executeLLMRound({
        session,
        provider,
        toolDefs: toolDefs ?? [],
        messages,
        sessionId,
        abortSignal: abortController.signal,
        onEvent,
        onUserInteraction,
        skills,
        effectiveMaxTokens,
        reasoningEffort,
        persistSnapshot,
        clearSnapshot,
      })

      // 将本轮 assistant 消息与 tool result 消息加入消息列表（供验证器使用）
      messages.push(result.assistantMessage)
      for (const msg of result.toolResultMessages) {
        messages.push(msg)
      }

      // 被暂停（用户暂存）或取消：快照保留，供断点恢复
      if (result.paused) {
        return { completed: false, messages }
      }

      // ===== 2. 验证 =====
      this.config.onIterationEvent({
        type: 'iteration_verify_start',
        data: { iteration: iterSession.currentIteration },
      })

      let verifyResult: VerificationResult
      try {
        verifyResult = await llmVerifier.verify(
          provider,
          session,
          goal,
          messages,
          abortController.signal,
        )
      } catch (e) {
        // 验证被用户取消：立即结束，不再注入反馈
        if (abortController.signal.aborted) {
          return { completed: false, messages }
        }
        // 验证调用异常：按未通过处理，让下一轮继续
        const errMsg = (e as any)?.message || String(e)
        verifyResult = {
          passed: false,
          summary: `验证调用失败: ${errMsg}`,
          issues: [
            {
              severity: 'error',
              description: `验证 LLM 调用失败: ${errMsg}`,
              suggestion: '请检查 provider 配置或网络连接后重试',
            },
          ],
        }
      }

      // 验证期间用户取消：停止迭代
      if (abortController.signal.aborted) {
        return { completed: false, messages }
      }

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

    // 目标未达成（超出最大迭代次数）→ completed: false，与文档契约一致
    // （true = 目标达成，false = 超出最大迭代次数；注意与「暂停」语义区分，
    //   暂停在循环内提前 return，不会走到这里）
    return { completed: false, messages }
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
