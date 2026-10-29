/**
 * Agent 白名单与 MCP 工具名的关系（两条规则，都是「白名单只由用户决定」的延伸）：
 *  ① `initDefaultAgent` **只建不补**（早前每次 `mcp:changed` 都把缺失的工具名补回默认 Agent，
 *    于是用户在默认 Agent 里取消勾选的 MCP 工具会被反复加回来）；
 *  ② 用户给 MCP 工具改公开名 → 各 Agent 白名单里的旧名跟着换（否则工具还在，名字却已落空，
 *    正是 §11.69 的幽灵条目）。
 *
 * 非 Tauri 环境（vitest 默认）：`agentRepo` 落 localStorage（`virlen-store`），读写都是同步的，
 * 不需要走 `hydrateAgents()` / debounce。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@/types'
import { initDefaultAgent, migrateAgentToolNames } from '@/services/agent-service'
import { toolRegistry } from '@/domain/tools'
import { DEFAULT_AGENT_ID } from '@/ui/constants'

const STORAGE_KEY = 'virlen-store'

function agent(id: string, allowTools: string[], updatedAt = 1): Agent {
  return {
    id,
    name: id,
    description: '',
    personality: '',
    identity: '',
    defaultWorkspace: '',
    projectRulesFile: 'AGENTS.md',
    defaultModel: { providerConfigId: 'p1', modelId: 'm1' },
    allowTools,
    skills: [],
    createdAt: 1,
    updatedAt,
  } as Agent
}

function seed(agents: Agent[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents }))
}

function read(): Agent[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{"agents":[]}').agents as Agent[]
}

beforeEach(() => localStorage.clear())

describe('initDefaultAgent · 只建不补', () => {
  it('已存在的默认 Agent 一个字都不动（不再补入缺失工具）', async () => {
    seed([agent(DEFAULT_AGENT_ID, ['read_file'])])

    await initDefaultAgent()

    const stored = read()
    expect(stored).toHaveLength(1)
    expect(stored[0].allowTools).toEqual(['read_file'])
    expect(stored[0].updatedAt).toBe(1)
  })

  it('不存在时按当时可用的工具建一份', async () => {
    seed([])
    // `listDefinitions()` = 契约 ∩ 已注册执行器：不注册的话默认 Agent 会是空的（启动时由 toolsInit 负责）
    await toolRegistry.register('read_file', async () => 'ok')

    await initDefaultAgent()
    await toolRegistry.unregister('read_file')

    const stored = read()
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(DEFAULT_AGENT_ID)
    expect(stored[0].allowTools).toEqual(['read_file'])
  })
})

describe('migrateAgentToolNames · 改名的白名单迁移', () => {
  it('把旧公开名换成新公开名，只写受影响的 Agent', () => {
    seed([agent('a', ['look', 'stat'], 1), agent('b', ['stat'], 1)])

    const migrated = migrateAgentToolNames([{ from: 'look', to: 'blender_look' }])

    expect(migrated).toBe(1)
    const stored = read()
    expect(stored[0].allowTools).toEqual(['blender_look', 'stat'])
    // 没命中的 Agent 不刷 updatedAt（不是「用户改过」）
    expect(stored[1]).toEqual(agent('b', ['stat'], 1))
  })

  it('幂等：再跑一次没有匹配就不写库', () => {
    seed([agent('a', ['blender_look'])])
    expect(migrateAgentToolNames([{ from: 'look', to: 'blender_look' }])).toBe(0)
    expect(read()[0].updatedAt).toBe(1)
  })

  it('换名后撞上已有条目时保序去重', () => {
    seed([agent('a', ['look', 'blender_look', 'stat'])])

    migrateAgentToolNames([{ from: 'look', to: 'blender_look' }])

    expect(read()[0].allowTools).toEqual(['blender_look', 'stat'])
  })

  it('from === to（恢复默认时的新旧同名）不产生任何改写', () => {
    seed([agent('a', ['look'])])
    expect(migrateAgentToolNames([{ from: 'look', to: 'look' }])).toBe(0)
    expect(read()[0].allowTools).toEqual(['look'])
  })
})
