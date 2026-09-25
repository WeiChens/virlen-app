import {
  ResolvedRegisteredTool,
  ResolvedToolDefinition,
  ToolExecutor,
} from '../tools/types'

/**
 * 工具注册中心端口
 *
 * **机制 C**：工具定义不在前端编写，而是来自权威源
 * （Rust 侧 `src-tauri/virlen-core/src/agent/tool_defs/definitions.json`），
 * 由 `ToolDefinitionsLoader` 注入（Tauri 走命令、其它环境读同一份 JSON）。
 * 因此 `register` 只接收执行器与 UI 文案，且**所有读取接口都是异步的**。
 */
export interface ToolRegistry {
  /** 载入权威定义（幂等）。启动时预热可让失败早暴露；不调用则首次读取时懒加载 */
  init(): Promise<void>

  /** 注册执行器（定义来自权威源，不在此处编写）；`label` 为 UI 文案（i18n） */
  register(name: string, executor: ToolExecutor, label?: string): Promise<void>

  /** 注销一个 tool */
  unregister(name: string): Promise<boolean>

  /** 获取 tool（定义来自契约，执行器来自注册；两者缺一即 undefined） */
  get(name: string): Promise<ResolvedRegisteredTool | undefined>

  /**
   * 列出可用工具定义（= 契约 ∩ 已注册执行器，顺序以契约为准）。
   * 这是发送给 LLM 的工具列表，也是设置页展示的数据源（含 i18n `label`）。
   */
  listDefinitions(): Promise<ResolvedToolDefinition[]>

  /** 列出所有可用的已注册工具（定义 + 执行器） */
  listAll(): Promise<ResolvedRegisteredTool[]>

  /** 检查 tool 是否已注册执行器 */
  has(name: string): Promise<boolean>

  /** 清空所有 tools（含定义缓存） */
  clear(): Promise<void>

  /** 诊断：契约里有定义、但没有注册执行器的工具名（正常应为空） */
  missingExecutorNames(): Promise<string[]>

  /** 诊断：注册了执行器、但契约里没有定义的工具名（正常应为空） */
  missingDefinitionNames(): Promise<string[]>
}
