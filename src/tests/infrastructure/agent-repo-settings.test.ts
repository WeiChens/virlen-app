/**
 * agentRepo · Agent 配置的**单一源**（Rust `app_settings` 表的 `agents` 键）契约
 *
 * 背景：agents 原先只存 localStorage（`virlen-store`），headless CLI 读不到
 * → 无法实现 `virlen-cli list-agent`（也无法在 `list-session -g agent` 里显示 Agent 名）。
 * 下沉后与 `securityRepo` 的沙盒规则**同款**：表为权威源、localStorage 只作迁移来源
 * 与非 Tauri 环境的降级存储。
 *
 * 这里钉住 5 件容易被改坏的事（**模拟 Tauri** 环境，与产品默认路径一致）：
 *  1. 表里有 agents → `load()` 返回表值，且 localStorage 历史副本被清掉；
 *  2. 表里没有该键 → 一次性迁移 localStorage 存量进表（老用户升级无感）；
 *  3. 表里是**空数组** → 视为「用户清空了」，**不**被迁回；
 *  4. `save()` → 只进表；内存快照即时更新（同进程 `load()` 立刻可见）；本地副本被清；
 *  5. 水合之前（Tauri）`load()` 返回空 —— 绝不回退读 localStorage
 *     （否则「表里删掉的 Agent」会在下次启动复活，等于两份权威）。
 *
 * ※ 模块级状态（内存快照 / 落库 debounce）要求每个用例重新加载模块；
 *   `@tauri-apps/api/core` 的 `invoke` 已在 `src/tests/setup.ts` 里 mock。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Agent } from '@/types'

const STORAGE_KEY = 'virlen-store'

interface TauriCtx {
  repo: typeof import('@/infrastructure/agentRepo')
  /** 收到的 upsert 载荷（按调用顺序） */
  upserts: Array<Record<string, unknown>>
}

/** 切到「模拟 Tauri」并重新加载被测模块（表内容 = `stored`） */
async function setupTauri(stored: Record<string, unknown>): Promise<TauriCtx> {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  vi.resetModules()
  let table = { ...stored }
  const upserts: Array<Record<string, unknown>> = []

  const core = await import('@tauri-apps/api/core')
  vi.mocked(core.invoke).mockImplementation((async (
    cmd: string,
    args?: { entries?: Record<string, unknown> },
  ) => {
    if (cmd === 'cmd_settings_get_all') return { ...table }
    if (cmd === 'cmd_settings_upsert') {
      const entries = args?.entries ?? {}
      upserts.push(entries)
      table = { ...table, ...entries }
      return undefined
    }
    if (cmd === 'cmd_settings_import') return false
    return undefined
  }) as never)

  const repo = await import('@/infrastructure/agentRepo')
  return { repo, upserts }
}

/** 造一个最小可用的 Agent */
function agent(id: string): Agent {
  return {
    id,
    name: id,
    description: '',
    personality: '',
    identity: '',
    defaultWorkspace: '',
    projectRulesFile: 'AGENTS.md',
    defaultModel: { providerConfigId: 'p1', modelId: 'm1' },
    allowTools: [],
    skills: [],
    createdAt: 1,
    updatedAt: 1,
  } as Agent
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  localStorage.clear()
  vi.resetModules()
})

describe('agentRepo · agents 单一源（app_settings）', () => {
  it('表里有 agents → load() 返回表值，且清掉 localStorage 历史副本', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents: [agent('stale')] }))
    const t = await setupTauri({ agents: [agent('from-table')] })

    await t.repo.hydrateAgents()

    expect(t.repo.agentRepo.load().agents.map((a) => a.id)).toEqual(['from-table'])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(t.upserts).toHaveLength(0)
  })

  it('表里没有该键 → 把 localStorage 存量迁进表，并清掉本地副本', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents: [agent('legacy')] }))
    const t = await setupTauri({ language: 'zh-CN' })

    await t.repo.hydrateAgents()

    expect(t.upserts).toHaveLength(1)
    expect((t.upserts[0].agents as Agent[]).map((a) => a.id)).toEqual(['legacy'])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(t.repo.agentRepo.load().agents.map((a) => a.id)).toEqual(['legacy'])
  })

  it('表里是空数组 → 视为「已清空」，不被迁回', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents: [agent('stale')] }))
    const t = await setupTauri({ agents: [] })

    await t.repo.hydrateAgents()

    expect(t.upserts).toHaveLength(0)
    expect(t.repo.agentRepo.load().agents).toEqual([])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('水合之前（Tauri）load() 返回空 —— 不回退读 localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ agents: [agent('stale')] }))
    const t = await setupTauri({ agents: [agent('from-table')] })

    expect(t.repo.isAgentsHydrated()).toBe(false)
    expect(t.repo.agentRepo.load().agents).toEqual([])

    await t.repo.hydrateAgents()
    expect(t.repo.isAgentsHydrated()).toBe(true)
    expect(t.repo.agentRepo.load().agents.map((a) => a.id)).toEqual(['from-table'])
  })

  it('save() → 只进表；内存快照即时更新；本地不残留副本', async () => {
    const t = await setupTauri({ agents: [] })
    await t.repo.hydrateAgents()

    t.repo.agentRepo.save({ agents: [agent('new')] })
    // 快照即时可见（渲染期同步读的就是它）
    expect(t.repo.agentRepo.load().agents.map((a) => a.id)).toEqual(['new'])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

    t.repo.flushAgentsPersist()
    await new Promise((r) => setTimeout(r, 0))

    const last = t.upserts[t.upserts.length - 1]
    expect((last?.agents as Agent[]).map((a) => a.id)).toEqual(['new'])
  })

  it('非 Tauri（浏览器 dev / vitest 无表）→ 仍用 localStorage 持久化', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    vi.resetModules()
    const repo = await import('@/infrastructure/agentRepo')

    // 无表可写：水合是空操作，读写都落 localStorage
    await repo.hydrateAgents()
    repo.agentRepo.save({ agents: [agent('dev')] })
    repo.flushAgentsPersist()

    expect(repo.agentRepo.load().agents.map((a) => a.id)).toEqual(['dev'])
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').agents).toHaveLength(1)
  })
})
