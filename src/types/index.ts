/**
 * 全局类型定义
 *
 * 从 agent/types.ts 迁移至此，供全项目共享。
 */
export type ProviderType = 'openai' | 'anthropic' | 'gemini'

export interface ProviderConfig {
  id: string
  name: string
  templateName: ProviderType | 'custom'
  type: ProviderType
  apiKey: string
  baseUrl: string
  models: ModelInfo[]
  reasoningEffort?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}
export interface ProviderConfigTemplate {
  templateName: string
  type: ProviderType
  label: string
  baseUrl: string
  allowTypeList?: {
    type: ProviderType
    baseUrl: string
  }[]
  /** 允许的 reasoningEffort 值列表（如 ['low', 'medium', 'high']），不设置则表示不支持 */
  allowReasoningEffortList?: string[]
  /**
   * 官网地址
   */
  officialLink?: string
}

export type ModelInfo = string

export type MessageRole = 'user' | 'assistant' | 'tool' | 'summary'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageContent {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type MessageContent =
  | string
  | (TextContent | ImageContent | ToolUseContent | ToolResultContent)[]

export interface Message {
  id: string
  role: MessageRole
  content: MessageContent
  toolCalls?: ToolUseContent[]
  reasoningContent?: string
  toolCallId?: string
  isError?: boolean
  elapsedMs?: number
  uiData?: Record<string, any>
  timestamp: number
  streaming?: boolean
  model?: string
  usage?: TokenUsage
  /** 发送时是否启用了图片自动视觉分析 */
  imageVisionAnalyzeOptimize?: boolean
  /** 视觉分析结果文本（tree text） */
  imageVisionAnalyzeResult?: string
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface Agent {
  id: string
  name: string
  description: string
  personality: string
  identity: string
  defaultWorkspace: string
  defaultModel: {
    providerConfigId: string
    modelId: string
  }
  allowTools: string[]
  skills: string[]
  defaultParams?: Partial<SessionParams>
  createdAt: number
  updatedAt: number
}

export interface Session {
  id: string
  title: string
  messages: Message[]
  providerConfigId: string
  modelId: string
  systemPrompt: string
  params: SessionParams
  createdAt: number
  updatedAt: number
  pinned: boolean
  tags: string[]
  workspace?: string
  agentId?: string
  allowedTools?: string[]
  skills?: string[]
  systemPromptManuallyEdited?: boolean
}

export interface SessionParams {
  temperature: number
  topP: number
  maxTokens: number
  stream: boolean
}

export type StreamEventType =
  | 'text_delta'
  | 'reasoning_content_change'
  | 'tool_use'
  | 'tool_result'
  | 'message_stop'
  | 'error'

export interface StreamEvent {
  type: StreamEventType
  data?: string
  toolUse?: ToolUseContent
  reasoningContent?: string
  error?: string
  usage?: TokenUsage
}

export type StreamCallback = (event: StreamEvent) => void

export type RequestMiddleware = (ctx: {
  session: Session
  messages: Message[]
  abortSignal: AbortSignal
}) => Promise<{
  session: Session
  messages: Message[]
  abortSignal: AbortSignal
}>

export type AgentEventType =
  | 'stream_start'
  | 'stream_event'
  | 'stream_end'
  | 'tool_call'
  | 'user_interaction'
  | 'error'
  | 'update_message_id'
  | 'assistant_message_created'
  | 'assistant_message_updated'
  | 'tool_result_created'

export interface AgentEvent {
  type: AgentEventType
  data?: any
  error?: string
}

export type AgentEventCallback = (event: AgentEvent) => void

export const DEFAULT_SESSION_PARAMS: SessionParams = {
  temperature: 0.7,
  topP: 1.0,
  maxTokens: 2000000,
  stream: true,
}

export function getLastSummaryMessageIndex(list: Message[]): number {
  let index = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'summary') {
      index = i
      break
    }
  }
  return index
}
