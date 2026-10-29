/**
 * MCP 服务器改名 → 白名单公开名迁移（`domain/mcp/rename.ts`）
 *
 * 事故背景（§11.69）：服务器从 `blender-mcp` 改名 `blender` 后，公开名前缀整体变掉，
 * 而 Agent 的 `allowTools` 里留着 35 个旧名 —— 界面上「已选 35 / 48」却一行都没勾。
 * 这里钉住四件事：
 *  1. 纯净前缀被替换成新名，其余部分一字不动；
 *  2. 带 SHA-256 指纹（`_[0-9a-f]{12}`）/ 拼完超 64 字符 / 名字残缺 → **不动**
 *     （宁可留幽灵名，也不能写一个不存在的名字）；
 *  3. 迁移后撞名（早就手动勾了新名）保序去重；
 *  4. 没变化的 Agent 保持**引用相等**（调用方只写真正改了的那几个）。
 */
import { describe, expect, it } from 'vitest'
import { migrateAllowedToolNames, migrateToolName } from '@/domain/mcp'

describe('migrateToolName', () => {
  it('纯净前缀：只换服务器名，raw 部分原样', () => {
    expect(
      migrateToolName('mcp__blender-mcp__get_scene_info', 'blender-mcp', 'blender'),
    ).toBe('mcp__blender__get_scene_info')
    // raw 里本身带 `__` 也不影响（切分点只在第一个分隔符）
    expect(migrateToolName('mcp__a__b__c', 'a', 'x')).toBe('mcp__x__b__c')
  })

  it('内置工具 / 别的服务器 / 同名改名 → 不碰', () => {
    expect(migrateToolName('read_file', 'blender-mcp', 'blender')).toBeNull()
    expect(migrateToolName('mcp__github__create_issue', 'blender-mcp', 'blender')).toBeNull()
    expect(migrateToolName('mcp__blender__get_scene_info', 'blender', 'blender')).toBeNull()
    expect(migrateToolName('mcp__blender__', 'blender', 'x')).toBeNull()
  })

  it('带身份指纹的名字不动：指纹含旧服务器名，反推不出新名', () => {
    expect(
      migrateToolName('mcp__blender-mcp__some_very_long_tool_0123456789ab', 'blender-mcp', 'blender'),
    ).toBeNull()
  })

  it('拼完超过 64 字符不动：Rust 会给它加指纹，我们拼的对不上', () => {
    const longServer = 'a'.repeat(30)
    // raw 补到公开名恰好 64 字符（上限内）
    const raw = 'x'.repeat(64 - `mcp__${longServer}__`.length)
    expect(migrateToolName(`mcp__${longServer}__${raw}`, longServer, 'b'.repeat(30))).toBe(
      `mcp__${'b'.repeat(30)}__${raw}`,
    )
    // 新名多 1 个字符 → 65 字符，放弃（Rust 侧会追加指纹，这里拼不出来）
    expect(migrateToolName(`mcp__${longServer}__${raw}`, longServer, 'b'.repeat(31))).toBeNull()
  })
})

describe('migrateAllowedToolNames', () => {
  it('迁移多条，并把改动的 Agent 标出来（其余保持引用相等）', () => {
    const hit = { id: 'hit', allowTools: ['read_file', 'mcp__blender-mcp__look'] }
    const miss = { id: 'miss', allowTools: ['read_file'] }

    const { agents, changed } = migrateAllowedToolNames([hit, miss], 'blender-mcp', 'blender')

    expect(changed).toBe(1)
    expect(agents[0].allowTools).toEqual(['read_file', 'mcp__blender__look'])
    expect(agents[0]).not.toBe(hit)
    expect(agents[1]).toBe(miss)
  })

  it('迁移后撞名（用户早就手动勾了新名）→ 保序去重，不留两条一模一样的', () => {
    const agent = {
      id: 'a',
      allowTools: ['mcp__blender-mcp__look', 'mcp__blender__look', 'read_file'],
    }
    const { agents, changed } = migrateAllowedToolNames([agent], 'blender-mcp', 'blender')

    expect(changed).toBe(1)
    expect(agents[0].allowTools).toEqual(['mcp__blender__look', 'read_file'])
  })

  it('谁都没改 → changed 为 0，数组元素引用全都不变', () => {
    const list = [{ id: 'a', allowTools: ['read_file'] }]
    const { agents, changed } = migrateAllowedToolNames(list, 'blender-mcp', 'blender')

    expect(changed).toBe(0)
    expect(agents[0]).toBe(list[0])
  })
})
