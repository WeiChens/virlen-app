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
  /** UI 文案（i18n）。机制 C 下不进契约，由注册时的 label 提供 */
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

/**
 * 工具级失败（模型侧 `message` 固定英文，与 Rust 侧同形）。
 *
 * `uiData` 是 **D2 的失败侧**：与成功结果同一套语义 —— 模型看英文 `message`，
 * UI 看语言无关的结构化字段、按界面语言重建文案。
 *
 * 为什么要专门一个类型：引擎与桥都靠「是不是 `Error` 实例」判定工具失败
 * （`services/rust-engine.ts` 的桥接层 / Rust `NativeToolOutcome::Error`），
 * 而裸 `Error` 带不了结构化字段 → 失败文案在中文界面下只能直显英文（遗留项 L6）。
 */
export class ToolError extends Error {
  uiData?: Record<string, any>

  constructor(message: string, uiData?: Record<string, any>) {
    super(message)
    this.name = 'ToolError'
    this.uiData = uiData
  }
}
/** 注册中心内部保存的形态（机制 C：**只存执行器**，定义来自权威源）。 */
export interface RegisteredExecutor {
  name: string
  /** UI 文案（i18n）。**不进契约**：Rust 不翻译，契约里存了会把英文界面顶成中文 */
  label?: string
  executor: ToolExecutor
}
/** 已注册的工具（定义来自权威源，执行器来自注册）：`get` / `listAll` 的返回值 */
export interface ResolvedRegisteredTool {
  definition: ResolvedToolDefinition
  executor: ToolExecutor
}
