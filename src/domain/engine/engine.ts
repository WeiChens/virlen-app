/**
 * Agent 引擎核心类 — 编排 Provider、Tool、Session 的交互
 *
 * 核心能力：
 * 1. 接收用户消息 → 构建上下文 → 调用 LLM → 流式输出
 * 2. Tool call 循环：按步骤执行工具，支持在任意步骤 暂停/恢复
 * 3. 暂停时完整记录进度（已完成工具的 results + 进行中的 step），断点续传
 *
 * ⚠️ 引擎不直接操作持久化状态（不 import store）。
 *    所有消息的创建/更新通过 onEvent 抛给 chat-service 处理。
 *
 * 方法按职责拆分到独立模块：
 * - llm-round.ts: LLM 调用相关（doLLMRound, handleStreaming 等）
 * - llm-loop.ts: 「LLM 调用 → 工具执行」共享编排（executeLLMRound）
 * - tool-executor.ts: Tool 执行相关（executeToolSteps, createRun 等）
 * - compress-context.ts: 上下文压缩（独立纯函数）
 * - types.ts: 类型定义
 */
import { snapshotToRun } from './run-state'
import type { Run, RunSnapshot } from './types'
import type {
  Message,
  Session,
  AgentEventCallback,
} from '@/types'
import { executeToolSteps } from './tool-executor'
import { executeLLMRound } from './llm-loop'
import {
  clearToolCallHistory,
  clearAllToolCallHistories,
} from './storm-breaker'
import type { SendMessageOptions } from './types'
import { providerPort } from '../provider'
import { toolRegistry } from '../tools'
import { AgentEnginePort } from '../ports'
import { compressContext } from './compress-context'
import { generateTitle } from './generate-title'
import { IterationController } from './iteration-controller'
import type { IProvider } from '@/infrastructure/provider/types'
import type { ToolDefinition, ToolExecutorResponse } from '../tools/types'

export class AgentEngine implements AgentEnginePort {
  compressContext(
    session: Session,
    allMessages: Message[],
  ): Promise<{ summary?: string; messages: Message[] }> {
    return compressContext(session, allMessages)
  }
  generateTitle(session: Session, messages: Message[]): Promise<string> {
    return generateTitle(session, messages)
  }
  private abortControllers: Map<string, AbortController> = new Map()
  private runSnapshots: Map<string, RunSnapshot> = new Map()

  async sendMessage(options: SendMessageOptions): Promise<void> {
    const {
      session,
      messages: allMessages,
      onEvent,
      enableTools = true,
      onUserInteraction,
      resumeFromSnapshot,
      reasoningEffort,
      maxToolRounds = 30,
      iterationGoal,
      maxIterations = 5,
    } = options

    const sessionId = session.id
    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)

    const effectiveMaxTokens = options.maxTokens ?? session.params.maxTokens
    const skills = session.skills

    try {
      // 1. 获取 provider
      const provider = await providerPort.ensureProvider(session)
      if (!provider) return

      // 2. 解析可用工具列表
      const toolDefs = await this.#resolveToolDefs(enableTools, session)

      // 3. 维护内存中的消息列表，随 tool 循环增长
      let currentMessages: Message[] = [...allMessages]
      let remainingRounds = maxToolRounds

      // 4. 断点恢复：直接跳到执行未完成的 tool steps
      if (resumeFromSnapshot) {
        const resumed = await this.#resumeRun(
          resumeFromSnapshot,
          sessionId,
          abortController,
          onEvent,
          onUserInteraction,
          skills,
          currentMessages,
          maxToolRounds,
        )
        if (!resumed) return
        currentMessages = resumed.messages
        remainingRounds = resumed.remainingRounds
      }

      // 4.5 纯 Tool 模式：不再自动注入 RAG 上下文
      //     知识库的检索和写入完全由 AI 通过 Tool 自主决定。
      //     AI 可调用以下工具：
      //     - search_knowledge_base: 搜索知识库
      //     - list_knowledge_bases: 列出知识库
      //     - write_to_knowledge_base: 写入知识库

      // 5. tool call 主循环（迭代模式或普通模式）
      let completed: boolean

      if (iterationGoal) {
        // ===== 迭代模式：执行→验证→修复 =====
        const iterationController = new IterationController({
          maxIterations,
          onIterationEvent: (iterEvent) => {
            onEvent?.({
              type: iterEvent.type as any,
              data: iterEvent.data,
            })
          },
        })

        const result = await iterationController.run({
          goal: { description: iterationGoal },
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
          persistSnapshot: (sid, run) => this.persistRunSnapshot(sid, run),
          clearSnapshot: (sid) => this.clearRunSnapshot(sid),
        })

        // 将迭代过程中新增的消息合并回 currentMessages
        // result.messages 包含所有消息（原始的 + 迭代中新增的）
        // 但 chat-service 已通过事件持久化了这些消息，这里不需要再做
        completed = result.completed
      } else {
        // ===== 普通模式 =====
        completed = await this.#executeToolLoop({
          session,
          provider,
          toolDefs,
          currentMessages,
          remainingRounds,
          sessionId,
          abortController,
          onEvent,
          onUserInteraction,
          skills,
          effectiveMaxTokens,
          reasoningEffort,
        })
      }

      if (completed) {
        onEvent?.({ type: 'stream_end', data: {} })
      }
    } catch (e: any) {
      onEvent?.({ type: 'error', error: e.message || String(e) })
    } finally {
      this.abortControllers.delete(sessionId)
      clearToolCallHistory(sessionId)
    }
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 根据会话配置解析可用工具定义列表
   */
  async #resolveToolDefs(
    enableTools: boolean,
    session: Session,
  ): Promise<ToolDefinition[] | undefined> {
    if (!enableTools) return undefined
    const allToolDefs = await toolRegistry.listDefinitions()
    if (session.allowedTools === undefined) return allToolDefs
    if (session.allowedTools.length === 0) return undefined
    return allToolDefs.filter((t) => session.allowedTools!.includes(t.name))
  }

  /**
   * 断点恢复：从 snapshot 重建 run，执行未完成的 tool steps
   * @returns null 表示恢复未能完成（被暂停），否则返回更新后的消息列表和剩余轮数
   */
  async #resumeRun(
    snapshot: RunSnapshot,
    sessionId: string,
    abortController: AbortController,
    onEvent: AgentEventCallback | undefined,
    onUserInteraction:
      | ((
          type: string,
          data: Record<string, any>,
        ) => Promise<ToolExecutorResponse>)
      | undefined,
    skills: string[] | undefined,
    currentMessages: Message[],
    maxToolRounds: number,
  ): Promise<{ messages: Message[]; remainingRounds: number } | null> {
    const run = snapshotToRun(snapshot, sessionId)
    const { completed, toolResultMessages } = await executeToolSteps(
      run,
      abortController.signal,
      onEvent,
      onUserInteraction,
      skills,
      (r) => this.persistRunSnapshot(sessionId, r),
    )
    for (const msg of toolResultMessages) {
      currentMessages.push(msg)
    }
    if (!completed) return null
    return {
      messages: currentMessages,
      remainingRounds: maxToolRounds - (snapshot.round ?? 1),
    }
  }

  /**
   * Tool call 主循环：LLM 调用 → 工具执行 → 结果合并
   * 每轮调用 LLM，如有 tool_calls 则依次执行工具，直到无 tool_calls 或达到上限
   * @returns true = 正常结束，false = 被暂停
   */
  async #executeToolLoop(params: {
    session: Session
    provider: IProvider
    toolDefs: ToolDefinition[] | undefined
    currentMessages: Message[]
    remainingRounds: number
    sessionId: string
    abortController: AbortController
    onEvent?: AgentEventCallback
    onUserInteraction?: (
      type: string,
      data: Record<string, any>,
    ) => Promise<ToolExecutorResponse>
    skills?: string[]
    effectiveMaxTokens: number
    reasoningEffort?: string
  }): Promise<boolean> {
    const {
      session,
      provider,
      toolDefs,
      currentMessages,
      remainingRounds,
      sessionId,
      abortController,
      onEvent,
      onUserInteraction,
      skills,
      effectiveMaxTokens,
      reasoningEffort,
    } = params

    let rounds = remainingRounds

    while (rounds > 0) {
      rounds--
      const result = await executeLLMRound({
        session,
        provider,
        toolDefs,
        messages: currentMessages,
        sessionId,
        abortSignal: abortController.signal,
        onEvent,
        onUserInteraction,
        skills,
        effectiveMaxTokens,
        reasoningEffort,
        persistSnapshot: (sid, run) => this.persistRunSnapshot(sid, run),
        clearSnapshot: (sid) => this.clearRunSnapshot(sid),
      })

      if (!result.ctx) break // 没有 tool calls，结束循环

      // 将 assistant 消息与 tool result 消息加入内存列表
      currentMessages.push(result.assistantMessage)
      for (const msg of result.toolResultMessages) {
        currentMessages.push(msg)
      }

      if (result.paused) return false // 被暂停
    }

    return true
  }

  // ==================== Snapshot 管理 ====================

  /**
   * 获取当前会话最新的 run 快照（用于断点恢复）
   *
   * 快照存储在内存 Map 中（不持久化），页面刷新后不可恢复。
   * 因为 tool run 需要 engine 的完整上下文，页面刷新后即使有快照也无法正常恢复。
   */
  async getRunSnapshot(sessionId: string) {
    return this.runSnapshots.get(sessionId) ?? null
  }

  /**
   * 将 run 快照保存到内存 Map
   */
  private persistRunSnapshot(sessionId: string, run: Run): void {
    try {
      this.runSnapshots.set(sessionId, runToSnapshotFast(run))
    } catch {
      // 序列化失败不阻塞
    }
  }

  /**
   * 清除 run 快照
   */
  async clearRunSnapshot(sessionId: string) {
    this.runSnapshots.delete(sessionId)
  }

  // ==================== 生命周期 ====================

  /** 取消当前请求 */
  async cancel(sessionId: string) {
    this.runSnapshots.delete(sessionId)
    clearToolCallHistory(sessionId)
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort('user_cancelled')
    }
  }

  /** 销毁引擎 */
  dispose(): void {
    for (const [, controller] of this.abortControllers) {
      controller.abort('engine_disposed')
    }
    this.abortControllers.clear()
    clearAllToolCallHistories()
  }
}

/** 快速 run→snapshot 序列化（避免循环依赖 run-state） */
function runToSnapshotFast(run: Run): RunSnapshot {
  return {
    assistantMessageId: run.assistantMessageId,
    steps: run.steps,
    round: run.round,
    createdAt: run.createdAt,
    paused: run.paused,
  }
}
