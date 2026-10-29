/**
 * MCP 工具名的**前端视图**（`domain/mcp/naming.ts`）。
 *
 * 名字由 Rust 生成（`mcp::naming::public_tool_name` = 服务器自己的工具名），前端既不生成也不解析归属：
 * 归属来自定义快照（`setMcpToolCatalog`）。这里钉三件事：
 *  ① 目录能认出 MCP 工具并给出服务器（卡片标题、编辑器分组都靠它）；
 *  ② 目录是**整体替换**的（新快照里没有的名字立刻不再算 MCP，内置名不会被误判）；
 *  ③ 旧版 `mcp__<server>__<raw>` 仍能解析（历史消息卡片 + 白名单一次性迁移）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  isLegacyMcpToolName,
  isMcpToolName,
  mcpToolLabel,
  mcpToolRef,
  mcpToolServer,
  parseMcpToolName,
  setMcpToolCatalog,
} from '@/domain/mcp'

beforeEach(() => setMcpToolCatalog([]))

describe('MCP 名称目录（新名字：服务器自己的工具名）', () => {
  it('目录里的名字被认成 MCP，并能查回服务器与原始名', () => {
    setMcpToolCatalog([{ name: 'look', server: 'blender', raw: 'look' }])
    expect(isMcpToolName('look')).toBe(true)
    expect(mcpToolRef('look')).toEqual({ server: 'blender', raw: 'look' })
    expect(mcpToolServer('look')).toBe('blender')
    expect(mcpToolLabel('look')).toBe('blender · look')
  })

  it('目录外同形式的名字不算 MCP（内置 read_file 不会被误判）', () => {
    setMcpToolCatalog([{ name: 'look', server: 'blender', raw: 'look' }])
    expect(isMcpToolName('read_file')).toBe(false)
    expect(mcpToolLabel('read_file')).toBe('read_file')
  })

  it('整体替换：新快照里没有的名字立刻不再算 MCP', () => {
    setMcpToolCatalog([{ name: 'look', server: 'blender', raw: 'look' }])
    setMcpToolCatalog([])
    expect(isMcpToolName('look')).toBe(false)
    expect(mcpToolServer('look')).toBeNull()
  })

  it('归一化后带哈希的名字也能查回原服务器', () => {
    setMcpToolCatalog([
      { name: 'list_files_52db686404e5', server: 'fs', raw: 'list/files' },
    ])
    expect(mcpToolServer('list_files_52db686404e5')).toBe('fs')
    expect(mcpToolLabel('list_files_52db686404e5')).toBe('fs · list/files')
  })
})

describe('旧版公开名（mcp__<server>__<raw>）', () => {
  it('只解析不生成：切点在**第一个**分隔符（raw 里可以有 __）', () => {
    expect(parseMcpToolName('mcp__srv__a__b')).toEqual({ server: 'srv', raw: 'a__b' })
    expect(isLegacyMcpToolName('mcp__srv__a')).toBe(true)
  })

  it('非旧版名 / 形状残缺 → null', () => {
    for (const name of [
      'read_file',
      'execute_command',
      'mcp__',
      'mcp__srv',
      'mcp__srv__',
      'mcp____tool',
    ]) {
      expect(parseMcpToolName(name)).toBeNull()
    }
  })

  it('旧名字没有目录也能认出服务器（历史消息卡片）', () => {
    expect(mcpToolServer('mcp__github__create_issue')).toBe('github')
    expect(mcpToolLabel('mcp__github__create_issue')).toBe('github · create_issue')
  })
})
