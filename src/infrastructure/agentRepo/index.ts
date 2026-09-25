/**
 * agentRepo — Agent 配置的持久化 Repository（**配置下沉 D3 的延伸**）
 *
 * 存储分工（与 `securityRepo` 的沙盒规则**同款**，见 `docs/config-sink-plan.md`）：
 * - **权威源 = Rust 侧 `app_settings` 表的 `agents` 键**（同一个 `virlen.db`）——
 *   GUI 与 headless CLI 读写同一份，因此 `virlen-cli list-agent` / `list-session -g agent`
 *   能看到同一批 Agent（名称、描述、默认工作目录、默认模型…）；
 * - localStorage（`virlen-store`）**只在非 Tauri**（浏览器 dev / vitest）保留，
 *   作为降级存储，保证 `pnpm dev` 下该功能仍可用；
 * - 启动水合（`hydrateAgents`，`main.ts` 的 `agents` 步骤）：表里**有**该键 → 读进内存快照；
 *   表里**没有** → 一次性迁移 localStorage 的历史副本，然后清掉本地副本
 *   （避免出现第二份权威，也就不会「删了表里的行又被迁回」）。
 *
 * ⚠️ **为什么是「内存快照 + 同步 `load()`」**：`agentStore` 的 `getAgent()` 在**渲染期被同步
 * 调用**（如侧边栏分组 `groupSessionsByAgent`），`SimpleRepo` 接口不能变异步 ——
 * 因此与 `securityRepo` 的 `rulesSnapshot` 用同一招：异步读表 → 落内存快照 → 同步读快照。
 *
 * ⚠️ 写入是 **debounce** 的（连续编辑 Agent 只写一次），退出前由
 * `flushAgentsPersist()` 补一次（`main.ts` 的 `beforeunload`）。
 */
import { getLocal, setLocal } from '@/utils/localStorage'
import type { SimpleRepo } from '@/infrastructure/repo'
import type { Agent } from '@/types'
import { settingsRepo } from '@/infrastructure/settingsRepo'

/** Agent 持久化数据 */
export interface AgentStoreData {
  agents: Agent[]
}

export const defaultAgentStore: AgentStoreData = {
  agents: [],
}

/** 历史 localStorage 键（下沉后仅作迁移来源 / 非 Tauri 降级存储） */
const STORAGE_KEY = 'virlen-store'
/** Agent 在 `app_settings` 里的键名（与字段同名同层，两侧不建映射表） */
export const AGENTS_SETTINGS_KEY = 'agents'
/** 落库 debounce：连续编辑（改名字 / 勾工具）只写一次 */
const AGENTS_SAVE_DEBOUNCE_MS = 400

/**
 * 内存权威快照（仅 Tauri 环境使用）。
 *
 * `null` = 尚未从表里读过；`{agents: []}` = 表里就是空的（**不是**「还没读」）。
 * `load()` 是同步接口（渲染期要用），所以表的异步读取结果落在这里。
 */
let agentsSnapshot: AgentStoreData | null = null

/** 待落库的数据（仅在 Tauri 环境累积；`null` = 无待写） */
let pendingAgents: Agent[] | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 是否处于 Tauri（有表可写）环境 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 从 localStorage 读一份副本（迁移来源 / 非 Tauri 存储） */
function readLocal(): AgentStoreData {
  const raw = getLocal<Partial<AgentStoreData> | null>(null, STORAGE_KEY)
  return { agents: Array.isArray(raw?.agents) ? (raw.agents as Agent[]) : [] }
}

/** 清掉 localStorage 里的历史副本（单一源：agents 只归表） */
function stripLocalSnapshot(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** 触发一次 debounce 落库 */
function schedulePersist(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushAgentsPersist, AGENTS_SAVE_DEBOUNCE_MS)
}

class AgentRepoImpl implements SimpleRepo<AgentStoreData> {
  load(): AgentStoreData {
    if (!settingsRepo.isAvailable()) {
      // 非 Tauri（浏览器 dev / vitest）：没有表 → 仍用 localStorage
      return readLocal()
    }
    // Tauri：只认内存快照（来自表）；hydrate 之前为空
    return agentsSnapshot ?? { agents: [] }
  }

  save(data: AgentStoreData): void {
    const agents = Array.isArray(data.agents) ? data.agents : []
    if (!settingsRepo.isAvailable()) {
      setLocal(STORAGE_KEY, { agents })
      return
    }
    // Tauri：只进表 —— 内存快照即时更新（同进程内 load() 立刻可见）
    agentsSnapshot = { agents }
    pendingAgents = agents
    stripLocalSnapshot()
    schedulePersist()
  }
}

export const agentRepo: SimpleRepo<AgentStoreData> = new AgentRepoImpl()

/** 把待写 Agent 立刻落库（debounce 到期 / 退出前调用） */
export function flushAgentsPersist(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const agents = pendingAgents
  pendingAgents = null
  if (agents === null) return
  settingsRepo.save({ [AGENTS_SETTINGS_KEY]: agents }).catch((e) => {
    console.warn('[agent] 写入 Rust 侧 app_settings 的 agents 失败:', e)
  })
}

/**
 * 启动时同步 Agent 列表（幂等；非 Tauri 环境直接返回）。
 *
 * 1. 表里**已有**该键 → 表为准（CLI 改过的 Agent 在 GUI 里立即生效）；
 * 2. 表里**没有**该键 → 一次性迁移：把 localStorage 的历史副本写进表；
 * 3. 两条分支都会清掉 localStorage 的历史副本。
 *
 * ⚠️ 调用时机：必须在 `initDefaultAgent()` / `agentStore.reload()` **之前**
 * （`main.ts` 的 `agents` 步骤）—— 否则默认 Agent 的补全逻辑读到的是空列表，
 * 会把「已有 Agent」丢掉、在本地重建一份，且落库后覆盖表里的数据。
 */
export async function hydrateAgents(): Promise<void> {
  if (!settingsRepo.isAvailable()) return
  try {
    const stored = await settingsRepo.loadAll()
    const fromTable = stored[AGENTS_SETTINGS_KEY]
    if (Array.isArray(fromTable)) {
      agentsSnapshot = { agents: fromTable as Agent[] }
    } else {
      // 表里没有 → 迁一次存量（历史副本仍可能躺在 localStorage 里）
      const legacy = readLocal()
      agentsSnapshot = legacy
      await settingsRepo.save({ [AGENTS_SETTINGS_KEY]: legacy.agents })
    }
    stripLocalSnapshot()
  } catch (e) {
    // 表读不到（后端不可用等）→ 降级用本地副本，Agent 列表不至于整段失效
    agentsSnapshot = readLocal()
    console.warn('[agent] 读取 Rust 侧 app_settings 的 agents 失败，继续使用本地副本:', e)
  }
}

/**
 * 供测试 / 诊断：当前内存快照是否已从表水合过
 * （`false` 表示尚未读表，`load()` 会返回空列表）
 */
export function isAgentsHydrated(): boolean {
  return agentsSnapshot !== null
}
