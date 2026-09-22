/**
 * Agent 引擎 — Barrel 导出
 *
 * 拆分说明：
 * - types.ts:           接口/类型定义 (SendMessageOptions, ToolCallContext)
 * - engine.ts:          AgentEngine 核心类 (sendMessage, snapshot管理)
 * - llm-round.ts:       LLM 调用处理 (doLLMRound, handleStreaming/NonStreaming, collectToolUse)
 * - llm-loop.ts:        「LLM 调用 → 工具执行」共享编排 (executeLLMRound)
 * - tool-executor.ts:   Tool 执行处理 (executeToolSteps, executeSingleStep, handleUserInteraction, handleToolResult)
 * - compress-context.ts: 上下文压缩 (compressContext 纯函数，ai 摘要 / raw 正文压缩两种模式)
 * - compress-raw.ts:     正文压缩渲染 (buildRawSummary：去思考、截断工具输出、正文不删)
 * - iteration-types.ts:  迭代循环类型定义 (Goal, VerificationResult, IterationSession 等)
 * - verifier.ts:         LLMVerifier — 验证执行结果是否达标
 * - iteration-controller.ts: 迭代控制器 — 编排执行→验证→修复循环
 */

import { AgentEnginePort } from '@/domain/ports'
import { AgentEngine } from './engine'
export type { SendMessageOptions, ToolCallContext } from './types'
export { executeLLMRound } from './llm-loop'
export type { ExecuteLLMRoundParams, ExecuteLLMRoundResult } from './llm-loop'
export type {
  Goal,
  VerificationResult,
  VerificationIssue,
  IterationSession,
  IterationEvent,
  IterationEventType,
  IterationEventCallback,
} from './iteration-types'
export { buildFeedbackMessage } from './iteration-types'
export type { CompressMode } from './compress-context'
export { buildRawSummary } from './compress-raw'
export { LLMVerifier, llmVerifier } from './verifier'
export type { VerifierConfig } from './verifier'
export {
  IterationController,
  createIterationController,
} from './iteration-controller'
export type { IterationControllerConfig } from './iteration-controller'

/** 全局 Agent 引擎实例 */
export const agentEngine: AgentEnginePort = new AgentEngine()
