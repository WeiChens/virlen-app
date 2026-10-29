/**
 * `services/mcp.ts::migrateAgentToolNames` —— 改名后**真的**落到了各个 Agent 上。
 *
 * 这里守的是「迁移结果要进 store + 落盘」，而不只是纯函数算对：
 * 白名单的权威副本在运行期是 `agentRepo` 的内存快照，只改表不改快照（或反之）都会被下一次
 * 保存整份写回去，迁移等于没做。非 Tauri（无表）路径用 localStorage，与浏览器 dev 一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/types'

const STORAGE_KEY = 'virlen-store'
const OLD = 'mcp__blender-mcp__look'
const NEW = 'mcp__blender__look'

function agent(id: string, allowTools: string[]): Agent {
  return {
    id,
    name: id,
    description: '',
    personality: '',
    identity: '',
    defaultWorkspace: '',
    projectRulesFile: 'AGENTS.md',
    defaultModel: { providerConfigId: '', modelId: '' },
    allowTools,
    skills: [],
    defaultParams: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

afterEach(() => {
  localStorage.clear()
  vi.resetModules()
})

async function setup(agents: Agent[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents }))
  vi.resetModules()
  const { agentStore } = await import('@/ui/store/agentStore')
  const { migrateAgentToolNames } = await import('@/services/mcp')
  return { agentStore, migrateAgentToolNames }
}

describe('migrateAgentToolNames', () => {
  it('改名 → store 与持久化里的旧名都换成新名，并返回改写条数', async () => {
    const { agentStore, migrateAgentToolNames } = await setup([
      agent('a', ['read_file', OLD]),
      agent('b', ['read_file']),
    ])

    expect(migrateAgentToolNames('blender-mcp', 'blender')).toBe(1)

    expect(agentStore.getAgent('a')!.allowTools).toEqual(['read_file', NEW])
    expect(agentStore.getAgent('b')!.allowTools).toEqual(['read_file'])

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.agents.find((x: Agent) => x.id === 'a').allowTools).toEqual([
      'read_file',
      NEW,
    ])
  })

  it('没有可迁移的名字 → 一条都不写（不刷 updatedAt），返回 0', async () => {
    const { agentStore, migrateAgentToolNames } = await setup([agent('a', ['read_file'])])
    const before = agentStore.getAgent('a')!

    expect(migrateAgentToolNames('blender-mcp', 'blender')).toBe(0)

    expect(agentStore.getAgent('a')).toBe(before)
    expect(agentStore.getAgent('a')!.updatedAt).toBe(1)
  })
})
