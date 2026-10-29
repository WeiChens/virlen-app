/**
 * MCP 公开名解析的**跨语言契约**测试。
 *
 * 黄金值只有一份：`src-tauri/virlen-core/src/mcp/naming_fixtures.json` —— Rust 侧
 * `mcp::naming::tests::matches_golden_values` 读同一份。前端**只解析不生成**（生成要 SHA-256，
 * 两套实现必然漂移），所以这里断言的是「Rust 生成的名字，前端能正确拆回服务器与原始工具名」。
 */
import fixturesRaw from '../../../src-tauri/virlen-core/src/mcp/naming_fixtures.json?raw'
import { isMcpToolName, mcpServersOfTools, mcpToolLabel, parseMcpToolName } from '@/domain/mcp'

interface FixtureCase {
  server: string
  raw: string
  expected: string
}

const fixtures = JSON.parse(fixturesRaw) as { cases: FixtureCase[] }

describe('MCP 公开名（黄金值来自 Rust）', () => {
  it('每一例都是 MCP 名', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0)
    for (const item of fixtures.cases) {
      expect(isMcpToolName(item.expected)).toBe(true)
    }
  })

  it('干净名字能原样拆回 (server, raw)', () => {
    for (const item of fixtures.cases) {
      // 「干净」= Rust 没有做字符替换/哈希（名字就是 mcp__server__raw）
      const clean = `mcp__${item.server}__${item.raw}`
      if (item.expected !== clean) continue
      expect(parseMcpToolName(item.expected)).toEqual({
        server: item.server,
        raw: item.raw,
      })
    }
  })

  it('被哈希归一化的名字：能拆就拆，拆不出来就原样展示', () => {
    for (const item of fixtures.cases) {
      const parsed = parseMcpToolName(item.expected)
      if (parsed) {
        expect(parsed.server.length).toBeGreaterThan(0)
        expect(parsed.raw.length).toBeGreaterThan(0)
      } else {
        // 服务器名全是非 ASCII（如“工具”）时，归一化后分隔符已经淹在替換出的下划线里 ——
        // 此时无法反解（名字本来带哈希），卡片直接显示全名，不编造一个假的服务端名
        expect(mcpToolLabel(item.expected)).toBe(item.expected)
      }
    }
  })

  it('拆分的切点在**第一个**分隔符（raw 里可以有 __）', () => {
    expect(parseMcpToolName('mcp__srv__a__b')).toEqual({ server: 'srv', raw: 'a__b' })
  })

  it('非 MCP 名 / 形状残缺返回 null', () => {
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

  it('卡片标签是 server · raw，拆不出来时退回原名', () => {
    expect(mcpToolLabel('mcp__github__create_issue')).toBe('github · create_issue')
    expect(mcpToolLabel('read_file')).toBe('read_file')
  })

  it('白名单 → 涉及的服务器（说明书注入口径，与工具下发同三态）', () => {
    // `undefined`（无白名单 = 全部工具）→ 不过滤
    expect(mcpServersOfTools(undefined)).toBeNull()
    // 空数组 = 一个都不注
    expect(mcpServersOfTools([])).toEqual([])
    // 只拿到内置工具 = 没有任何 MCP 服务器
    expect(mcpServersOfTools(['read_file', 'execute_command'])).toEqual([])
    // 按服务器去重，保持首次出现顺序；形状残缺的名字忽略
    expect(
      mcpServersOfTools([
        'mcp__fs__read',
        'read_file',
        'mcp__db__query',
        'mcp__fs__write',
        'mcp__broken',
      ]),
    ).toEqual(['fs', 'db'])
    // 旧名（改名后的幽灵名）仍能解出旧服务器 —— Rust 侧名单认不得它，自然不会注入（fail-closed）
    expect(mcpServersOfTools(['mcp__fs-old__read'])).toEqual(['fs-old'])
  })
})
