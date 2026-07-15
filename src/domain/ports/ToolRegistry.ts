import { RegisteredTool, ToolDefinition, ToolExecutor } from '../tools/types'

export interface ToolRegistry {
  /** 注册一个 tool */
  register(definition: ToolDefinition, executor: ToolExecutor): Promise<void>

  /** 注销一个 tool */
  unregister(name: string): Promise<boolean>

  /** 获取 tool */
  get(name: string): Promise<RegisteredTool | undefined>

  /** 列出所有 tool 定义（用于发送给 LLM） */
  listDefinitions(): ToolDefinition[]
  /** 列出所有注册的 tool */
  listAll(): Promise<RegisteredTool[]>

  /** 检查 tool 是否存在 */
  has(name: string): Promise<boolean>

  /** 清空所有 tools */
  clear(): Promise<void>
}
