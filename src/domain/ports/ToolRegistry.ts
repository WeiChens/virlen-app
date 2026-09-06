import {
  RegisteredTool,
  ResolvedRegisteredTool,
  ResolvedToolDefinition,
  ToolDefinition,
  ToolExecutor,
} from '../tools/types'

export interface ToolRegistry {
  /** 注册一个 tool（definition.description 可为惰性函数，序列化时才求值） */
  register(definition: ToolDefinition, executor: ToolExecutor): Promise<void>

  /** 注销一个 tool */
  unregister(name: string): Promise<boolean>

  /** 获取 tool（返回已解析定义：惰性描述已求值为纯字符串） */
  get(name: string): Promise<ResolvedRegisteredTool | undefined>

  /** 列出所有 tool 定义（用于发送给 LLM；惰性描述在此求值为字符串） */
  listDefinitions(): ResolvedToolDefinition[]
  /** 列出所有注册的 tool（返回已解析定义） */
  listAll(): Promise<ResolvedRegisteredTool[]>

  /** 检查 tool 是否存在 */
  has(name: string): Promise<boolean>

  /** 清空所有 tools */
  clear(): Promise<void>
}
