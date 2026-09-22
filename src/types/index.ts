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
  /**
   * 该服务商可选的推理强度档位（用户在服务商配置里从 REASONING_EFFORT_UNION 多选而来）
   * 聊天界面只能从这些值里切换实际使用的档位
   */
  reasoningEffortList?: string[]
  /** 默认推理强度：会话未单独选择时使用（会话级选择优先） */
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
  /**
   * 允许的 reasoningEffort 值列表（如 ['low', 'medium', 'high']），不设置则表示不支持
   * @deprecated 已由用户多选（ProviderConfig.reasoningEffortList）取代，仅作参考数据保留
   */
  allowReasoningEffortList?: string[]
  /**
   * 官网地址
   */
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
  /** 文件绝对路径（只存路径，不拷贝文件内容） */
  path: string
  /** 展示用文件名（不含目录） */
  name?: string
  /** 是否为目录 */
  isDir?: boolean
  /** 文件字节数（目录无此值） */
  size?: number
}

/**
 * 引用消息块：把某条历史消息（用户 / AI 正文）作为本条消息的上下文
 *
 * 与 FileContent 同构——只存「引用来源 + 正文快照」，不做任何拷贝之外的加工：
 *   - messageId：被引用消息的 id（发给模型，供后续能力定位原消息）
 *   - text：正文快照。原消息可能被删除、被上下文压缩（summary）替换，或被
 *     分页懒加载移出内存，所以引用必须自包含，不能只存 id 让模型自己去查。
 * 各协议（openai / anthropic / gemini / Rust 原生引擎）统一降级为文本。
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
 * 技能引用块：把某个 Skill 的 SKILL.md **全文**作为本条消息的上下文
 *
 * 与 FileContent（只存路径，让模型自己读）刻意不同：技能是「领域知识包」，
 * 用户引用它的意图就是让模型**立刻拿到**其中的规则/流程，所以内容随消息一起发送。
 * 与 QuoteContent 同构——引用即快照，发送后技能被改 / 被删都不影响本条消息的自包含性。
 * 各协议（openai / anthropic / gemini / Rust 原生引擎）统一降级为文本。
 */
export interface SkillContent {
  type: 'skill'
  /** 技能唯一标识（skillStore 的 meta.name） */
  name: string
  /** 技能源码目录绝对路径（供模型定位 SKILL.md 之外的脚本 / 资源） */
  path?: string
  /**
   * 技能描述（来自 SKILL.md frontmatter）
   *
   * ⚠️ 只服务于 UI（消息气泡的技能卡片正文）。**不参与降级文本**：
   * `skillBlockToText` 只带 name / path / content，Rust 侧 `skill_block_to_text`
   * 同样按字段名取 name / path / content（块以 `Value` 解析，多余字段自动忽略）。
   * 所以加这个字段不会改变发给模型的内容，也就不涉及双引擎同步。
   */
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
 * 附件标签：文件附件块降级成文本时、打在路径前面的标记（模型可读，不是 UI 文案）
 *
 * 与 Rust 侧 `src-tauri/src/agent/provider.rs` 的同名常量必须逐字一致
 * （铁律 1：TS / Rust 双引擎同语义），改文案要两边一起改。
 */
export const ATTACHED_FILE_LABEL = '[User attached file]'
export const ATTACHED_DIR_LABEL = '[User attached folder]'

/**
 * 文件附件块 → 发给 LLM 的文本形式
 *
 * 各 Provider（openai / anthropic / gemini / Rust 原生引擎）共用此函数，
 * 保证同一条消息在所有协议下对模型呈现完全一致。
 * 语义：告诉模型「用户附带了这个文件」，具体内容由模型自行用工具按路径读取。
 */
export function fileBlockToText(block: FileContent): string {
  const path = block.path || ''
  return block.isDir
    ? `${ATTACHED_DIR_LABEL} ${path}`
    : `${ATTACHED_FILE_LABEL} ${path}`
}

/**
 * 引用块标签：降级成文本时给模型看的字段名（模型可读，不是 UI 文案）
 *
 * 与 Rust 侧 `src-tauri/src/agent/provider.rs` 的同名常量必须逐字一致
 * （铁律 1：TS / Rust 双引擎同语义），改文案要两边一起改。
 */
export const QUOTED_MESSAGE_LABEL = '[Quoted message]'
export const QUOTE_SENDER_LABEL = 'Sender'
export const QUOTE_MESSAGE_ID_LABEL = 'Message ID'
export const QUOTE_CONTENT_LABEL = 'Content'

/**
 * 引用块 → 发给 LLM 的文本形式
 *
 * 与 fileBlockToText 一样由所有 Provider 共用，保证同一条消息在所有协议下
 * 对模型呈现完全一致。格式固定为四行字段 + 正文，便于模型稳定解析：
 *
 * ```
 * [Quoted message]
 * Sender: user
 * Message ID: <id>
 * Content:
 * <正文>
 * ```
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

/**
 * 技能引用块标签：降级成文本时给模型看的字段名（模型可读，不是 UI 文案）
 *
 * 与 Rust 侧 `src-tauri/src/agent/provider.rs` 的同名常量必须逐字一致
 * （铁律 1：TS / Rust 双引擎同语义），改文案要两边一起改。
 */
export const SKILL_BLOCK_LABEL = '[Skill]'
export const SKILL_NAME_LABEL = 'Name'
export const SKILL_DIR_LABEL = 'Directory'
export const SKILL_CONTENT_LABEL = 'SKILL.md'

/**
 * 技能引用块 → 发给 LLM 的文本形式
 *
 * 与 quoteBlockToText 一样由所有 Provider 共用，保证同一条消息在所有协议下
 * 对模型呈现完全一致。**SKILL.md 全文原样带出**（这正是「引用技能」的语义），
 * 目录行让模型能顺着 `Directory` 用文件工具读取脚本等其它资源。
 *
 * ```
 * [Skill]
 * Name: my-skill
 * Directory: <技能目录绝对路径>
 * SKILL.md:
 * <SKILL.md 全文>
 * ```
 *
 * ⚠️ 四个字段**恒定输出**（缺失时为空值），不做条件拼接 —— 条件分支最容易
 * 让 TS / Rust 两侧的输出产生一个换行的差异。
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
  /** 深度思考（reasoning）消耗的毫秒数，思考结束开始输出正文时确定 */
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
   * 缓存命中的输入 token（API 明确回报时才有）。
   *
   * ⚠️ 各家口径不同：OpenAI 兼容（含 DeepSeek）把它算在 `promptTokens` 里，
   * Gemini 的 `cachedContentTokenCount` 也是 `promptTokenCount` 的子集，
   * 而 Anthropic 的 `input_tokens` 本来就不含缓存。
   * **账本写入时会按 provider 拉平口径**（见 `domain/usage::ledgerTokensOf`），
   * 这里的字段保持 API 原样，供展示使用。
   */
  cachedTokens?: number
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
  /** 会话级推理强度（覆盖 Provider 默认值），不设置则回退 Provider 默认值 */
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

// ===== 版本更新相关 =====

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
