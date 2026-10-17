/** 全局共享类型。 */
export type ProviderType = 'openai' | 'anthropic' | 'gemini'

export interface ProviderConfig {
  id: string
  name: string
  templateName: ProviderType | 'custom'
  type: ProviderType
  apiKey: string
  baseUrl: string
  models: ModelInfo[]
  /** 该服务商可选的推理强度档位（聊天界面只能从这些值里选） */
  reasoningEffortList?: string[]
  /** 默认推理强度（会话级选择优先） */
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
  /** 允许的 reasoningEffort 值；不设置 = 不支持 */
  allowReasoningEffortList?: string[]
  /** 官网地址 */
  officialLink?: string
}

export type ModelInfo = string

export type MessageRole = 'user' | 'assistant' | 'tool' | 'summary' | 'feedback'

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

export interface FileContent {
  type: 'file'
  /** 文件绝对路径（不拷贝内容） */
  path: string
  /** 展示用文件名（不含目录） */
  name?: string
  /** 是否为目录 */
  isDir?: boolean
  /** 文件字节数（目录无此值） */
  size?: number
}

/**
 * 引用消息块：把某条历史消息作为上下文。
 * text 是正文快照 —— 原消息可能被删除 / 压缩 / 移出内存，所以引用必须自包含。
 * 各协议统一降级为文本。
 */
export interface QuoteContent {
  type: 'quote'
  /** 被引用消息的 id */
  messageId: string
  /** 被引用消息的发送方 */
  role: 'user' | 'assistant'
  /** 被引用消息的正文快照 */
  text: string
}

/**
 * 技能引用块：把 SKILL.md 全文作为上下文（与 FileContent 只存路径不同，技能要立刻可用）。
 */
export interface SkillContent {
  type: 'skill'
  /** 技能标识（skillStore 的 meta.name） */
  name: string
  /** 技能源码目录绝对路径（供模型定位 SKILL.md 之外的资源） */
  path?: string
  /** 技能描述：只给 UI 用，不参与降级文本（两侧都只取 name / path / content） */
  description?: string
  /** SKILL.md 全文快照 */
  content: string
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
  | (
      | TextContent
      | ImageContent
      | FileContent
      | QuoteContent
      | SkillContent
      | ToolUseContent
      | ToolResultContent
    )[]

/**
 * 附件标签：文件块降级成文本时打在路径前。与 Rust provider.rs 的同名常量逐字一致。
 */
export const ATTACHED_FILE_LABEL = '[User attached file]'
export const ATTACHED_DIR_LABEL = '[User attached folder]'

/**
 * 文件块 → 发给 LLM 的文本。各 Provider 共用，保证同一条消息在所有协议下呈现一致。
 */
export function fileBlockToText(block: FileContent): string {
  const path = block.path || ''
  return block.isDir
    ? `${ATTACHED_DIR_LABEL} ${path}`
    : `${ATTACHED_FILE_LABEL} ${path}`
}

/** 引用块标签：降级文本的字段名。与 Rust provider.rs 逐字一致。 */
export const QUOTED_MESSAGE_LABEL = '[Quoted message]'
export const QUOTE_SENDER_LABEL = 'Sender'
export const QUOTE_MESSAGE_ID_LABEL = 'Message ID'
export const QUOTE_CONTENT_LABEL = 'Content'

/**
 * 引用块 → 发给 LLM 的文本（四行固定字段 + 正文），各 Provider 共用。
 */
export function quoteBlockToText(block: QuoteContent): string {
  return [
    QUOTED_MESSAGE_LABEL,
    `${QUOTE_SENDER_LABEL}: ${block.role}`,
    `${QUOTE_MESSAGE_ID_LABEL}: ${block.messageId}`,
    `${QUOTE_CONTENT_LABEL}:`,
    block.text,
  ].join('\n')
}

/** 技能块标签：降级文本的字段名。与 Rust provider.rs 逐字一致。 */
export const SKILL_BLOCK_LABEL = '[Skill]'
export const SKILL_NAME_LABEL = 'Name'
export const SKILL_DIR_LABEL = 'Directory'
export const SKILL_CONTENT_LABEL = 'SKILL.md'

/**
 * 技能块 → 发给 LLM 的文本：SKILL.md 全文原样带出，目录行供模型读其它资源。
 * 四个字段恒定输出（缺失留空），不做条件拼接 —— 条件分支最容易让两侧差一个换行。
 */
export function skillBlockToText(block: SkillContent): string {
  return [
    SKILL_BLOCK_LABEL,
    `${SKILL_NAME_LABEL}: ${block.name || ''}`,
    `${SKILL_DIR_LABEL}: ${block.path || ''}`,
    `${SKILL_CONTENT_LABEL}:`,
    block.content || '',
  ].join('\n')
}

export interface Message {
  id: string
  role: MessageRole
  content: MessageContent
  toolCalls?: ToolUseContent[]
  reasoningContent?: string
  toolCallId?: string
  isError?: boolean
  elapsedMs?: number
  /** 思考消耗的毫秒数，思考结束开始输出正文时确定 */
  reasoningElapsedMs?: number
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
  /**
   * 缓存命中的输入 token（API 回报时才有）。各家口径不同（OpenAI 含在 promptTokens 里，
   * Anthropic 的 input_tokens 本就不含），账本写入时按 provider 拉平，这里保持原样。
   */
  cachedTokens?: number
  /**
   * 缓存写入的输入 token（Anthropic 的 cache_creation_input_tokens，其余 provider 恒缺省）。
   * 必须与 cachedTokens 分开：读 0.1x、写 1.25x 计费，合成就没法分别计价。
   */
  cacheWriteTokens?: number
}

export interface Agent {
  id: string
  name: string
  description: string
  personality: string
  identity: string
  defaultWorkspace: string
  /**
   * 项目规则文件（相对工作目录的路径，默认 AGENTS.md）。会话创建时若存在则注入系统提示词；
   * 空串 = 不注入。老数据缺省时按默认值处理。
   */
  projectRulesFile?: string
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
  /** 会话级推理强度（覆盖 Provider 默认值） */
  reasoningEffort?: string
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
  /**
   * 工具参数生成进度：引擎累积参数期间不发其它事件，长参数意味着长时间静默，消费方用它说明「工作中」。
   */
  | 'tool_progress'
  | 'user_interaction'
  | 'error'
  | 'update_message_id'
  | 'assistant_message_created'
  | 'assistant_message_updated'
  | 'tool_result_created'
  | 'iteration_start'
  | 'iteration_verify_start'
  | 'iteration_verify_end'
  | 'iteration_verify_pass'
  | 'iteration_verify_fail'
  | 'iteration_max_exceeded'
  | 'iteration_end'

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

// 版本更新

/** 支持的操作系统平台 */
export type UpdatePlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios'

/** 更新策略 */
export type UpdatePolicy = 'optional' | 'recommended' | 'force'

/** 检查更新请求 */
export interface ICheckUpdateRequest {
  platform: UpdatePlatform
  current_version: string
  current_build_number?: number
}

/** 最新版本信息 */
export interface ILatestVersion {
  version: string
  build_number?: number
  changelog: string
  update_policy: UpdatePolicy
  download: {
    url: string
    file_size: number
    file_md5: string
    original_name: string
  }
}

/** 检查更新响应 */
export interface ICheckUpdateResponse {
  has_update: boolean
  latest_version?: ILatestVersion
}

/** 检查更新 API 包装响应 */
export interface IApiResponse<T = unknown> {
  code: number
  message: string
  data?: T
}
