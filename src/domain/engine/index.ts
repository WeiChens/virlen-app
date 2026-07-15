/**
 * Agent 引擎 — Barrel 导出
 *
 * 拆分说明：
 * - types.ts:           接口/类型定义 (SendMessageOptions, ToolCallContext)
 * - engine.ts:          AgentEngine 核心类 (sendMessage, snapshot管理)
 * - llm-round.ts:       LLM 调用处理 (doLLMRound, handleStreaming/NonStreaming, collectToolUse)
 * - tool-executor.ts:   Tool 执行处理 (executeToolSteps, executeSingleStep, handleUserInteraction, handleToolResult)
 * - compress-context.ts: 上下文压缩 (compressContext 独立纯函数)
 */

import { AgentEnginePort } from '@/domain/ports'
import { AgentEngine } from './engine'
export type { SendMessageOptions, ToolCallContext } from './types'

/** 全局 Agent 引擎实例 */
export const agentEngine: AgentEnginePort = new AgentEngine()
