import { ToolDefinition } from '@/domain/tools/types'
import { Message, ProviderConfig, StreamCallback } from '@/types'

/** Provider 接口 — 所有 LLM Provider 需要实现此接口 */
export interface IProvider {
  /** Provider 名称 */
  readonly name: string

  /** 获取可用模型列表 */
  listModels(): Promise<string[]>

  /** 发送聊天请求（非流式） */
  chat(request: ChatRequest, signal?: AbortSignal): Promise<Message>

  /** 发送聊天请求（流式，回调方式） */
  chatStream(
    request: ChatRequest,
    callback: StreamCallback,
    signal?: AbortSignal,
  ): Promise<void>

  /** 将内部消息格式转为 provider 专属请求 */
  buildRequest(request: ChatRequest): ChatCompletionRequest | any

  /** 验证 API key */
  validateApiKey(config: ProviderConfig): Promise<boolean>
}
/** 聊天请求 */
export interface ChatRequest {
  model: string
  messages: Message[]
  systemPrompt?: string
  tools?: ToolDefinition[]
  temperature: number
  topP: number
  maxTokens: number
  stream: boolean
  tool_choice: 'none' | 'auto'
  /** 推理努力程度（如 OpenAI o 系列模型的 reasoning_effort） */
  reasoningEffort?: string
}
/** Chat 完成请求参数（原始格式） */
export interface ChatCompletionRequest {
  model: string
  messages: {
    role: string
    content: any
    tool_calls?: any[]
    tool_call_id?: string
  }[]
  tools?: any[]
  temperature: number
  top_p: number
  max_tokens: number
  stream: boolean
}
