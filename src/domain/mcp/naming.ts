/**
 * MCP 工具名的**前端视图**（纯逻辑）。
 *
 * 现在的公开名就是**服务器自己的工具名**（`get_scene_info` / `look`），由 Rust
 * `mcp::naming::public_tool_name` 生成：名字里不再有服务器名，所以前端既不能生成也不能解析归属 ——
 * 归属只能由 Rust 随定义一起下发（`cmd_mcp_tool_definitions` 的 `mcpServer` / `rawName`）。
 * 本模块把那份快照存成「名字 → 归属」目录，供卡片标题、编辑器分组与旧数据展示查。
 *
 * 旧数据（历史消息、旧白名单）里仍是 `mcp__<server>__<raw>`：**只解析、不生成**，
 * 解析结果仅用于展示与一次性迁移（生成需要 SHA-256，两套实现必然漂移）。
 */

/** 历史公开名前缀 —— 只用于识别旧数据 */
export const MCP_PREFIX = 'mcp__'

/** 历史名字里服务器名与工具名之间的分隔符 */
const SEP = '__'

/** 一个公开名的归属 */
export interface McpToolRef {
  /** 服务器配置名 */
  server: string
  /** 服务器自己的工具名 */
  raw: string
}

/** MCP 名称目录：公开名 → 归属（每次定义快照刷新时整体替换） */
const catalog = new Map<string, McpToolRef>()

/**
 * 用最新一次定义快照替换目录（空数组 = 当前没有 MCP 工具，目录清空）。
 *
 * 只装**已发布**的名字：冲突被扣下的工具不在这里（它们本来就不该被当成可用工具）。
 */
export function setMcpToolCatalog(
  tools: readonly { name: string; server: string; raw: string }[],
): void {
  catalog.clear()
  for (const tool of tools) {
    catalog.set(tool.name, { server: tool.server, raw: tool.raw })
  }
}

/** 是不是**旧版**公开名（`mcp__<server>__<raw>`） */
export function isLegacyMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX)
}

/**
 * 从旧版公开名反推归属；不是旧版名 / 形状残缺 → `null`。
 *
 * ⚠️ 只用于**旧数据**（历史消息卡片、白名单一次性迁移）。新名字不带前缀，归属问 `mcpToolRef`。
 */
export function parseMcpToolName(name: string): McpToolRef | null {
  if (!isLegacyMcpToolName(name)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const index = rest.indexOf(SEP)
  if (index <= 0) return null
  const server = rest.slice(0, index)
  const raw = rest.slice(index + SEP.length)
  if (!server || !raw) return null
  return { server, raw }
}

/** 公开名的归属：先查目录（新名字），再退旧前缀解析（历史消息） */
export function mcpToolRef(name: string): McpToolRef | null {
  return catalog.get(name) ?? parseMcpToolName(name)
}

/** 是不是 MCP 工具（新名字靠目录，旧名字靠前缀） */
export function isMcpToolName(name: string): boolean {
  return mcpToolRef(name) !== null
}

/** 所属服务器名（认不出来 → `null`） */
export function mcpToolServer(name: string): string | null {
  return mcpToolRef(name)?.server ?? null
}

/**
 * 卡片 / 分组标题用的标签：`server · raw`。
 * 认不出来时退回原名（宁可直接显示，也不要渲染成空白）。
 */
export function mcpToolLabel(name: string): string {
  const ref = mcpToolRef(name)
  return ref ? `${ref.server} · ${ref.raw}` : name
}
