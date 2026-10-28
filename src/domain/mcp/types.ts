/**
 * MCP（Model Context Protocol）服务器 —— 前端侧的数据契约。
 *
 * ⚠️ 与 Rust `virlen-core/src/mcp/config.rs` / `host.rs` 的 serde(camelCase) **一一对应**：
 * 配置由 Rust 命令读写（`cmd_mcp_*`），前端只负责编辑与展示，不做第二份持久化。
 *
 * 与内置工具的关键区别：
 * - MCP 工具是**运行期动态定义**（不在 `definitions.json` 里，不参与「39 个工具」的契约断言）；
 * - 公开名固定 `mcp__<server>__<raw>`，由 Rust 生成；前端**只解析不生成**
 *   （生成需要 SHA-256，两套实现必然漂移，见 `naming.ts` 文件头）；
 * - 执行在 Rust（`McpHost`），前端没有对应的执行器。
 */

/** 传输方式 */
export type McpTransportKind = 'stdio' | 'http'

/**
 * 审批三态（与内置权限同一套词表）：
 * - `allow` 直接执行；`ask`（默认）每次确认；`deny` **不建立连接**、工具不下发。
 */
export type McpApproval = 'allow' | 'ask' | 'deny'

/** 运行态（与 Rust `McpServerState` 同词表） */
export type McpServerState =
  | 'disabled'
  | 'connecting'
  | 'ready'
  | 'backoff'
  | 'failed'
  | 'error'

/** 一台服务器（= `app_settings.mcpServers` 数组的一项） */
export interface McpServerConfig {
  /** 稳定 id（uuid）：只用于 UI key 与重命名；公开工具名**不用**它 */
  id: string
  /** 命名空间：`^[A-Za-z0-9_-]{1,32}$`，不得含 `__` */
  name: string
  enabled: boolean
  transport: McpTransportKind

  /** stdio */
  command?: string
  args?: string[]
  cwd?: string
  /** 叠在「清洗后的父环境」之上（显式覆盖优先） */
  env?: Record<string, string>

  /** http（Streamable HTTP） */
  url?: string
  headers?: Record<string, string>

  approval: McpApproval
  /** 单次 `tools/call` 超时 */
  toolCallTimeoutMs: number
  /** 建连 + 首次 `tools/list` 超时（`npx` 冷启动经常 > 10s） */
  startupTimeoutMs: number
  reconnect: {
    enabled: boolean
    initialDelayMs: number
    maxDelayMs: number
    maxAttempts: number
  }
  /** 只暴露这些工具（`rawName` 白名单；`undefined` = 全部） */
  enabledTools?: string[]
  /** 是否把服务器 `instructions` 注入系统提示词（建会话时由 `cmd_mcp_instructions` 取回） */
  injectInstructions: boolean
}

/** 一个已发布的 MCP 工具 */
export interface McpToolInfo {
  /** 公开名 `mcp__<server>__<raw>` */
  name: string
  /** 服务器自己的名字（`tools/call` 只认它） */
  rawName: string
  description: string
  /** 已清洗的 JSON Schema（可直接下发模型） */
  inputSchema: Record<string, unknown>
}

/** 一台服务器的状态快照（只读；Rust 是唯一来源） */
export interface McpServerStatus {
  id: string
  name: string
  transport: McpTransportKind
  state: McpServerState
  toolCount: number
  tools: McpToolInfo[]
  /** 服务器自称的 serverInfo（仅供展示，绝不用于命名） */
  serverName?: string
  serverVersion?: string
  connectedAt?: number
  /** 最近一次失败原因（已脱敏） */
  lastError?: string
  attempt?: number
  maxAttempts?: number
  /** 服务器自身输出的尾部诊断（stdio 的 stderr） */
  stderrTail?: string
  /** 本次进程内「断链 → 退避重连」的次数（诊断：反复重连通常是服务器自身不稳） */
  reconnectCount: number
}

/** `cmd_mcp_list` 的返回 */
export interface McpListResult {
  configs: McpServerConfig[]
  statuses: McpServerStatus[]
  epoch: number
}

/** `cmd_mcp_test` 的返回 */
export interface McpProbeResult {
  ok: boolean
  toolCount: number
  tools: McpToolInfo[]
  error?: string
}

/** `cmd_mcp_import` 的返回 */
export interface McpImportResult {
  imported: McpServerConfig[]
  skipped: Array<{ name: string; reason: string }>
}
