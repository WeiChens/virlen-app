/**
 * 可惰性求值的文本：静态字符串，或「序列化给 LLM 前才调用」的函数。
 * 用于注册时无法确定、但到真正使用时已确定的动态描述（如平台信息）。
 * 注册用定义（ToolDefinition）允许惰性函数；对外返回的 ResolvedToolDefinition
 * 中惰性函数已被求值为纯字符串，可直接渲染/JSON 序列化。
 */
export type ResolvableString = string | (() => string)

/** 泛型工具定义：D 为描述字段类型（静态字符串或惰性字符串）。 */
export interface ToolDefinitionLike<D> {
  name: string
  label?: string
  description: D
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameterPropertyLike<D>>
    required: string[]
    oneOf?: Array<{ required: string[] }>
  }
}
/** 泛型参数属性：description 可为静态或惰性字符串。 */
export interface ToolParameterPropertyLike<D> {
  type: string
  description?: D
  enum?: string[]
  default?: any
  [key: string]: any
}

/** 注册用定义（toolRegistry.register 入参）：description 可为惰性函数。 */
export type ToolDefinition = ToolDefinitionLike<ResolvableString>
/** 对外定义（get/listDefinitions/listAll 返回值）：description 保证已解析为纯字符串。 */
export type ResolvedToolDefinition = ToolDefinitionLike<string>

/** 注册用参数属性。 */
export type ToolParameterProperty = ToolParameterPropertyLike<ResolvableString>
/** 对外参数属性：description 保证为字符串。 */
export type ResolvedToolParameterProperty = ToolParameterPropertyLike<string>

export type ToolExecutor = (
  args: Record<string, any>,
  ctx: ToolContext,
) => Promise<ToolExecutorResponse>
export type ToolExecutorResponse = string | UserInteractionRequired | ToolResult
export interface ToolContext {
  sessionId: string
  toolCallId: string
  abortSignal: AbortSignal
  write: (chunk: string) => void
  skills?: string[]
}
export interface ToolResult {
  content: string
  uiData?: Record<string, any>
}

export class UserInteractionRequired {
  interactionType: string
  interactionData: Record<string, any>

  constructor(type: string, data: Record<string, any>) {
    this.interactionType = type
    this.interactionData = data
  }
}
/** 注册中心内部保存的工具（definition 保留惰性函数，序列化时再求值）。 */
export interface RegisteredTool {
  definition: ToolDefinition
  executor: ToolExecutor
}
/** 注册中心对外返回的工具（definition 已解析为纯字符串）。 */
export interface ResolvedRegisteredTool {
  definition: ResolvedToolDefinition
  executor: ToolExecutor
}
