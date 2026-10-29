// @vitest-environment node
/**
 * Agent 编辑器的工具分组（`groupToolsForEditor`）。
 *
 * 要守的三件事，每一件都对应一个「用户明明连了服务器却勾不到工具」的形态：
 *   ① MCP 工具按服务器动态成组，且**不进「其他」**（进了也能勾，但找不到「那台服务器的全部工具」）；
 *   ② 服务器组按名字排序（每次打开位置都变会让人勾错行）；
 *   ③ 静态分类保持契约顺序，未认领的才落「其他」。
 *
 * 服务器名取自定义的 `mcpServer`（Rust 随定义下发）—— 工具名里已经没有服务器名，不能靠拆名字。
 */
import { describe, expect, it } from 'vitest'
import { groupToolsForEditor } from '@/domain/tools/grouping'
import { TOOL_CATEGORIES } from '@/domain/tools/category'
import type { ResolvedToolDefinition } from '@/domain/tools/types'

/** 造一个定义；`server` 有值时按 MCP 定义（`origin` + `mcpServer`）标记 */
const tool = (name: string, server?: string): ResolvedToolDefinition =>
  ({
    name,
    description: '',
    input_schema: { type: 'object', properties: {} },
    ...(server ? { origin: 'mcp', mcpServer: server } : {}),
  }) as unknown as ResolvedToolDefinition

const OPTIONS = {
  categories: TOOL_CATEGORIES,
  otherLabel: '其他',
  mcpLabel: (server: string) => `MCP · ${server}`,
}

const ids = (groups: ReturnType<typeof groupToolsForEditor>) =>
  groups.map((g) => g.category.id)
const groupOf = (groups: ReturnType<typeof groupToolsForEditor>, id: string) =>
  groups.find((g) => g.category.id === id)

describe('groupToolsForEditor', () => {
  it('静态分类在前，MCP 按服务器成组，未认领的落「其他」', () => {
    const groups = groupToolsForEditor(
      [tool('read_file'), tool('look', 'fs'), tool('ghost_tool'), tool('status', 'git')],
      OPTIONS,
    )
    expect(ids(groups)).toEqual(['file', 'mcp:fs', 'mcp:git', 'other'])
    // MCP 工具绝不出现在「其他」里（否则「其他」会混进别的服务器的工具）
    expect(groupOf(groups, 'other')?.tools.map((t) => t.name)).toEqual(['ghost_tool'])
    expect(groupOf(groups, 'mcp:fs')?.tools.map((t) => t.name)).toEqual(['look'])
  })

  it('服务器组按名字排序（与工具到达顺序无关）', () => {
    const groups = groupToolsForEditor(
      [tool('a', 'zeta'), tool('b', 'alpha'), tool('c', 'mid')],
      OPTIONS,
    )
    expect(ids(groups)).toEqual(['mcp:alpha', 'mcp:mid', 'mcp:zeta'])
  })

  it('组标题与批量勾选清单一致（toolNames 就是组内工具名）', () => {
    const groups = groupToolsForEditor([tool('a', 'fs'), tool('b', 'fs')], OPTIONS)
    const mcp = groupOf(groups, 'mcp:fs')
    expect(mcp?.category.label).toBe('MCP · fs')
    expect(mcp?.category.toolNames).toEqual(mcp?.tools.map((t) => t.name))
  })

  it('没有 MCP 工具时不产生空的服务器组', () => {
    const groups = groupToolsForEditor([tool('read_file')], OPTIONS)
    expect(ids(groups)).toEqual(['file'])
  })

  it('空列表 → 空分组（界面自己显示「暂无可用的工具」）', () => {
    expect(groupToolsForEditor([], OPTIONS)).toEqual([])
  })

  it('缺 mcpServer 的定义不硬塞进服务器组，落到「其他」', () => {
    const groups = groupToolsForEditor([tool('mcp__broken')], OPTIONS)
    expect(ids(groups)).toEqual(['other'])
  })
})
