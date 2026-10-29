/**
 * MCP 公开工具名的**解析**（纯逻辑）。
 *
 * 名字形状：`mcp__<serverName>__<rawName>`，由 Rust `mcp::naming::public_tool_name` 生成：
 * - 非法字符 → `_`；超 64 字符 → 前缀截断 + 12 位 SHA-256 兜底；
 * - `serverName` 校验禁止出现 `__`，所以「第一个 `__` 之后」就是原始名（`raw` 里可以有 `__`）。
 *
 * ⚠️ **这里只解析、不生成**。生成需要 SHA-256 与「逐字符替换 + 截断 + 哈希」三段规则，
 * 前端再实现一遍就是第二份真相 —— 而名字一旦两侧不一致，会话历史里的工具名会指向另一个工具。
 * 前端拿到的一切名字都来自 Rust（`cmd_mcp_tool_definitions` / `cmd_mcp_status`）。
 */

/** 保留前缀：内置 39 个工具不允许以它开头 */
export const MCP_PREFIX = 'mcp__'

/** 服务器名与工具名之间的分隔符 */
const SEP = '__'

/** 是不是 MCP 工具（引擎按它决定走 MCP 分发而不是内置执行器） */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX)
}

/**
 * 从公开名反推 `(serverName, rawName)`；不是 MCP 名 / 形状残缺 → `null`。
 *
 * 只用于**展示分组**（卡片标题、Agent 编辑器的动态分组）。路由以 Rust 侧的路由表为准：
 * 名字被哈希归一化过时，这里只能给出「近似」服务端名。
 */
export function parseMcpToolName(
  name: string,
): { server: string; raw: string } | null {
  if (!isMcpToolName(name)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const index = rest.indexOf(SEP)
  if (index <= 0) return null
  const server = rest.slice(0, index)
  const raw = rest.slice(index + SEP.length)
  if (!server || !raw) return null
  return { server, raw }
}

/**
 * 卡片 / 分组标题用的短标签：`server · raw`。
 * 解析不出来时退回原名（宁可直接显示，也不要渲染成空白）。
 */
export function mcpToolLabel(name: string): string {
  const parsed = parseMcpToolName(name)
  return parsed ? `${parsed.server} · ${parsed.raw}` : name
}

/**
 * 白名单 → 涉及的 MCP 服务器名（去重）。
 *
 * 唯一用途：**说明书注入口径**（`agent-service` 传给 `cmd_mcp_instructions`）。
 * 三态映射与 `filterAllowedToolDefs`（工具下发的唯一口径）逐条对应：
 * - `undefined`（无白名单 = 全部工具）→ `null`（不过滤）；
 * - `[]`（显式关掉全部）→ `[]`（一个都不注）；
 * - 有名字 → 解析出的服务器名；旧名解析出已不存在的服务器时，Rust 侧自然过滤掉（fail-closed）。
 */
export function mcpServersOfTools(
  toolNames: readonly string[] | undefined,
): string[] | null {
  if (toolNames === undefined) return null
  const servers = new Set<string>()
  for (const name of toolNames) {
    const parsed = parseMcpToolName(name)
    if (parsed) servers.add(parsed.server)
  }
  return [...servers]
}
