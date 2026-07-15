import { getLocal, setLocal } from '@/utils/localStorage'
import type { SimpleRepo } from '@/infrastructure/repo'
import type { Agent } from '@/types'

/** Agent 持久化数据 */
export interface AgentStoreData {
  agents: Agent[]
}

const defaultAgentStore: AgentStoreData = {
  agents: [],
}

const STORAGE_KEY = 'virlen-store'

/** localStorage 实现 */
class AgentRepoImpl implements SimpleRepo<AgentStoreData> {
  load(): AgentStoreData {
    return getLocal<AgentStoreData>(defaultAgentStore, STORAGE_KEY)
  }

  save(data: AgentStoreData): void {
    setLocal(STORAGE_KEY, data)
  }
}

export const agentRepo: SimpleRepo<AgentStoreData> = new AgentRepoImpl()
