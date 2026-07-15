/**
 * Agent 引擎内部类型定义
 *
 * 从 index.ts 拆分，减少文件体积
 */
import type {
  Message,
  ToolUseContent,
  AgentEventCallback,
  Session,
} from '@/types'
import { ToolExecutorResponse } from '../tools/types'

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
  /** 读取最大工具调用轮数，默认 30  */
  maxToolRounds?: number
}

/**
 * 每次 LLM 一轮对话产生的临时上下文
 */
export interface ToolCallContext {
  assistantMessage: Message
  toolUses: ToolUseContent[]
  roundContent: string
  reasoningContent: string
}
/**
 * Run (执行批次) 状态管理
 *
 * 一个 Run 表示一次 sendMessage 调用中 LLM 产出的一个工具调用批次，
 * 包括该批次中每个 tool 的执行进度和结果。
 *
 * 语义：
 * - 每次 LLM 流结束(产生 tool_calls) → 创建一个 Run
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
 * Run 状态管理器 — 负责创建、查询、更新执行批次状态
 *
 * 存储方案：写入 engine 内部 Map (内存)，不随会话持久化。
 * 页面刷新后 run 状态自动清空，tool run 断点恢复仅在页面内有效。
 */
export interface RunSnapshot {
  assistantMessageId: string
  steps: ToolStep[]
  round: number
  createdAt: number
  /** 是否有暂停标记 */
  paused: boolean
}
