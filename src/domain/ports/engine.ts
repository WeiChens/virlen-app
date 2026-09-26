/**
 * 引擎契约类型 —— chat-service 与引擎适配器共用的共享类型
 *
 * 原位于 `src/domain/engine/types.ts`（TS 引擎内部类型）。TS 引擎已移除，但这些类型仍是
 * `AgentEnginePort` 与 `services/rust-engine.ts` 之间的接口契约，因此迁到 ports 层保留。
 */
import type { Message, Session } from '@/types'
import type { AgentEventCallback, ToolUseContent } from '@/types'
import type { ToolExecutorResponse } from '@/domain/tools/types'

/**
 * 上下文压缩方式 —— 与 Rust `CompressMode`（`'ai' | 'raw'`）取值一致，
 * 也与 `app_settings.contextCompressMode` 同值。
 */
export type CompressMode = 'ai' | 'raw'

/** 发送一次消息（一个 run）的入参 —— `AgentEnginePort.sendMessage` 的选项 */
export interface SendMessageOptions {
  /** 完整 Session 对象，engine 只读 */
  session: Session
  /** 当前消息列表（包含已持久化的所有消息），engine 在其基础上追加新消息 */
  messages: Message[]
  /** 流式事件回调 */
  onEvent?: AgentEventCallback
  /**
   * 当 tool 执行需要用户交互时调用。
   * 返回一个 Promise，在用户完成交互后 resolve 并携带用户输入。
   */
  onUserInteraction?: (
    type: string,
    data: Record<string, any>,
  ) => Promise<ToolExecutorResponse>
  /** 是否启用 tool use，默认 true */
  enableTools?: boolean
  /** 覆盖 maxTokens（不传则使用 session.params.maxTokens） */
  maxTokens?: number
  /**
   * 断点恢复：从指定的 snapshot 恢复工具调用执行。
   * 设置此选项时 engine 不会再次调用 LLM，而是直接执行未完成的 tool steps。
   */
  resumeFromSnapshot?: RunSnapshot
  /** 来自 provider 配置的 reasoningEffort（如 o 系列模型的 low/medium/high） */
  reasoningEffort?: string
  /** 读取最大工具调用轮数，默认 30 */
  maxToolRounds?: number
  /**
   * 迭代目标 — 设置后启用「执行→验证→修复」自主迭代模式。
   * engine 会在每轮 tool 执行后自动验证结果，未达标则注入反馈并重试。
   */
  iterationGoal?: string
  /** 迭代模式最大重试次数，默认 5（仅在 iterationGoal 设置时生效） */
  maxIterations?: number
  /**
   * **轮次边界钩子**：上一批工具的 tool_result 已合并、下一次 LLM 请求尚未发出时调用。
   *
   * 用途：用户在 AI 回复期间「应用」的任务清单变更，必须在这次请求之前进入
   * 消息列表，模型才能在这一轮里看到；返回值会被追加进本轮消息列表。
   * 抛错 / 返回空数组都视为「无可注入」。
   *
   * ⚠️ Rust 引擎不用这个回调（消息列表在 Rust 内存里，前端改不了），走桥接
   * `agent:round-boundary` → `agent_round_boundary_response`：语义对齐、通道不同（铁律 1，§5.1）。
   */
  onRoundBoundary?: (sessionId: string) => Message[] | Promise<Message[]>
}

/**
 * 每次 LLM 一轮对话产生的临时上下文（引擎内部使用）。
 *
 * ⚠️ 保留本类型只因 Rust 侧 `agent::types::ToolCallContext` 有同名对应物（前端已无消费方）。
 */
export interface ToolCallContext {
  assistantMessage: Message
  toolUses: ToolUseContent[]
  roundContent: string
  reasoningContent: string
}

/**
 * Run（执行批次）状态管理
 *
 * 一个 Run 表示一次 sendMessage 调用中 LLM 产出的一个工具调用批次，
 * 包括该批次中每个 tool 的执行进度和结果。
 *
 * 语义：
 * - 每次 LLM 流结束（产生 tool_calls）→ 创建一个 Run
 * - Run 包含多个 ToolStep（每个 tool call 一个 step）
 * - 可暂停/恢复：检查当前是第几个 step，前面的结果已存储
 */
export type ToolStepStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 单个 tool 步骤 */
export interface ToolStep {
  /** tool use id (由 LLM 分配) */
  toolCallId: string
  toolName: string
  input: Record<string, any>
  status: ToolStepStatus
  /** 执行结果（成功则为 tool 返回值，给 LLM 的文本） */
  result?: string
  /** 错误信息 */
  error?: string
  /** 开始执行的时间戳 */
  startedAt?: number
  /** UI 渲染数据（ToolExecutor 返回的 uiData） */
  uiData?: Record<string, any>
}

/** 一个执行批次（一次 LLM tool_calls 响应） */
export interface Run {
  /** run id */
  id: string
  sessionId: string
  /** 归属的 assistant 消息 id（tool_calls 消息） */
  assistantMessageId: string
  /** 本轮 tool step 列表 */
  steps: ToolStep[]
  /** 创建时间 */
  createdAt: number
  /** 是否已收到暂停请求 */
  paused: boolean
  /** 批量序号：第几次 LLM 返回 tool_calls */
  round: number
}

/**
 * Run 快照 —— 断点恢复用（只存引擎侧内存 / Rust 侧内存 Map，页面刷新后即失效）。
 *
 * ⚠️ 由 Rust 引擎权威产出：`agent_get_run_snapshot` 的返回值即此形状（camelCase）。
 */
export interface RunSnapshot {
  assistantMessageId: string
  steps: ToolStep[]
  round: number
  createdAt: number
  /** 是否有暂停标记 */
  paused: boolean
}
