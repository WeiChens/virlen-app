/**
 * Agent 编辑器的工具分组（纯逻辑，便于单测）。
 *
 * 三段落，顺序即界面顺序：
 *   ① 静态分类（`TOOL_CATEGORIES`，与 `definitions.json` 一一对应）；
 *   ② **MCP 动态分组**（每台服务器一组，标题 `MCP · <server>`）；
 *   ③ 「其他」（哪个分类都没认领的）。
 *
 * 为什么 MCP 不能写进 `TOOL_CATEGORIES`：那张表是契约（条数与 `definitions.json` 对齐，有测试守着），
 * 而 MCP 服务器是用户在设置页随时增删的运行期事实 —— 写死就意味着每接一台服务器改一次契约。
 *
 * ⚠️ MCP 工具必须**从「其他」里拿走**：它落到「其他」也能勾选，但用户找不到「那台服务器的全部工具」，
 * 只能一个个认名字。同理，服务器组按名字排序 —— 每次打开位置都变会让人勾错行。
 */
import type { ResolvedToolDefinition } from './types'
import type { ToolCategory } from './category'
import { parseMcpToolName } from '../mcp/naming'

export interface ToolGroup {
  category: ToolCategory
  tools: ResolvedToolDefinition[]
}

export interface GroupToolsOptions {
  /** 静态分类表（`TOOL_CATEGORIES`） */
  categories: ToolCategory[]
  /** 「其他」的标题（调用方已按界面语言取好） */
  otherLabel: string
  /** MCP 分组的标题（入参是服务器名） */
  mcpLabel: (server: string) => string
}

/** 按「分类 → MCP 服务器 → 其他」分组 */
export function groupToolsForEditor(
  tools: ResolvedToolDefinition[],
  { categories, otherLabel, mcpLabel }: GroupToolsOptions,
): ToolGroup[] {
  const grouped: ToolGroup[] = []
  const used = new Set<string>()

  for (const category of categories) {
    const matched = tools.filter((tool) => category.toolNames.includes(tool.name))
    if (matched.length === 0) continue
    grouped.push({ category, tools: matched })
    for (const tool of matched) used.add(tool.name)
  }

  const byServer = new Map<string, ResolvedToolDefinition[]>()
  for (const tool of tools) {
    const parsed = parseMcpToolName(tool.name)
    if (!parsed) continue
    const list = byServer.get(parsed.server)
    if (list) list.push(tool)
    else byServer.set(parsed.server, [tool])
  }
  for (const server of [...byServer.keys()].sort((a, b) => a.localeCompare(b))) {
    const mcpTools = byServer.get(server) ?? []
    grouped.push({
      category: {
        id: `mcp:${server}`,
        label: mcpLabel(server),
        toolNames: mcpTools.map((tool) => tool.name),
      },
      tools: mcpTools,
    })
    for (const tool of mcpTools) used.add(tool.name)
  }

  const uncategorized = tools.filter((tool) => !used.has(tool.name))
  if (uncategorized.length > 0) {
    grouped.push({
      category: {
        id: 'other',
        label: otherLabel,
        toolNames: uncategorized.map((tool) => tool.name),
      },
      tools: uncategorized,
    })
  }

  return grouped
}
