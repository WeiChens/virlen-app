export interface ToolDefinition {
  name: string
  label?: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameterProperty>
    required: string[]
  }
}
export interface ToolParameterProperty {
  type: string
  description?: string
  enum?: string[]
  default?: any
  [key: string]: any
}
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
export interface RegisteredTool {
  definition: ToolDefinition
  executor: ToolExecutor
}
