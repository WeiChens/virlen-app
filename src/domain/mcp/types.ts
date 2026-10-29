/**
 * MCP（Model Context Protocol）服务器 —— 前端侧的数据契约。
 *
 * ⚠️ 与 Rust `virlen-core/src/mcp/config.rs` / `host.rs` 的 serde(camelCase) **一一对应**：
 * 配置由 Rust 命令读写（`cmd_mcp_*`），前端只负责编辑与展示，不做第二份持久化。
 *
 * 与内置工具的关键区别：
 * - MCP 工具是**运行期动态定义**（不在 `definitions.json` 里，不参与「39 个工具」的契约断言）；
 * - 公开名就是**服务器自己的工具名**（可在设置页逐工具改别名；仅在字符替换 / 超长时带哈希后缀），
 *   由 Rust 生成；名字里不含服务器名 → 归属由定义一起下发（`mcpServer`），前端不解析；
 * - 执行在 Rust（`McpHost`），前端没有对应的执行器。
 */

/** 传输方式 */
export type McpTransportKind = 'stdio' | 'http'

/**
 * 审批三态（与内置权限同一套词表）：
 * - `allow`（默认，新建草稿）直接执行；`ask` 每次确认；`deny` **不建立连接**、工具不下发。
 * 从 JSON 导入是例外：Rust 侧显式写 `ask`（别人写的配置不自动放开）。
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
  /**
   * 工具公开名的自定义覆盖：`服务器原始工具名 → 模型可见名`（无条目 = 与服务一致）。
   *
   * 只影响模型看到的名字（下发 / 卡片 / 白名单），`tools/call` 永远发服务器原始名。
   * 落库与校验的裁决在 Rust（`mcp::config::validate`）。
   */
  toolAliases?: Record<string, string>
  /** 是否把服务器 `instructions` 注入系统提示词（建会话时由 `cmd_mcp_instructions` 取回） */
  injectInstructions: boolean
}

/** 一个已发布的 MCP 工具 */
export interface McpToolInfo {
  /** 模型可见名（= 用户指定的别名，缺省则服务器自己的工具名；必要时带 12 位哈希后缀） */
  name: string
  /** 服务器自己的名字（`tools/call` 只认它） */
  rawName: string
  description: string
  /** 已清洗的 JSON Schema（可直接下发模型） */
  inputSchema: Record<string, unknown>
}

/**
 * 一个被**扣下不发**的同名工具。
 *
 * 名字是模型唯一的身份凭据：与内置重名时内置优先，两台服务器同名时两边都不发 ——
 * 不猜路由，而是把原因摆到界面上让人处理（改名 / 停用其中一台）。
 */
export interface McpConflict {
  /** 冲突的公开名 */
  name: string
  /** `builtin` = 与内置工具重名；`server` = 两台以上服务器同名 */
  kind: 'builtin' | 'server'
  /** 涉及的服务器名（`builtin` 时是「想占用这个名字」的服务器） */
  servers: string[]
}

/** 一台服务器的状态快照（只读；Rust 是唯一来源） */
export interface McpServerStatus {
  id: string
  name: string
  transport: McpTransportKind
  state: McpServerState
  toolCount: number
  /** 已发布（模型可见）的工具：**已被 `enabledTools` 裁剪** */
  tools: McpToolInfo[]
  /**
   * 服务器提供的**完整**工具清单（不受 `enabledTools` 裁剪）。
   *
   * 编辑弹窗用它当候选回填勾选 —— 拿 `tools` 当候选就只能看到已勾过的那些，
   * 被排除的工具再也勾不回来（白名单是穷举的）。
   */
  allTools: McpToolInfo[]
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
  /** 本世代被扣下不发的同名工具（不在任何 status.tools 里，必须单独报） */
  conflicts: McpConflict[]
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
