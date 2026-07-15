/**
 * agentStore — UI 层 Store
 *
 * 职责：
 *  - 持有 mobx observable，供 UI 组件响应式渲染
 *  - 数据读写委托给 SimpleRepo<AgentStoreData>
 *
 * 注意：为避免循环依赖（@/agent → engine.ts → @/store），
 * 直接引用子路径而非 @/agent 桶导出。
 */
import { makeObservable, observable } from 'mobx'
import type { SimpleRepo } from '@/infrastructure/repo'
import { agentRepo, AgentStoreData } from '@/infrastructure/agentRepo'
import type { Agent } from '@/types'
import { v4 as uuid } from '@/utils/uuid'
import { DEFAULT_AGENT_ID } from '@/ui/constants'

class AgentStore {
  /** mobx observable — UI 组件直接绑定此属性 */
  value: AgentStoreData = { agents: [] }

  constructor(private repo: SimpleRepo<AgentStoreData>) {
    this.value = { ...repo.load(), agents: [...repo.load().agents] }
    makeObservable(this, {
      value: observable,
    })
  }

  /** 持久化 */
  private persist(): void {
    this.repo.save(this.value)
  }

  /** 根据 ID 获取 Agent */
  getAgent(id: string): Agent | undefined {
    return this.value.agents.find((a) => a.id === id)
  }

  /** 获取所有 Agent 列表 */
  listAgents(): Agent[] {
    return [...this.value.agents]
  }

  /** 保存 Agent（新增或更新） */
  saveAgent(agent: Agent): void {
    const idx = this.value.agents.findIndex((a) => a.id === agent.id)
    if (idx >= 0) {
      const agents = [...this.value.agents]
      agents[idx] = { ...agent, updatedAt: Date.now() }
      this.value = { ...this.value, agents }
    } else {
      this.value = {
        ...this.value,
        agents: [
          ...this.value.agents,
          {
            ...agent,
            id: agent.id || uuid(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }
    }
    this.persist()
  }

  /** 从持久化存储重新加载数据（用于 initDefaultAgent 等外部修改后的同步） */
  reload(): void {
    this.value = { ...this.repo.load(), agents: [...this.repo.load().agents] }
  }

  /** 删除 Agent（不允许删除默认 Agent） */
  deleteAgent(id: string): boolean {
    if (id === DEFAULT_AGENT_ID) return false
    const agents = this.value.agents.filter((a) => a.id !== id)
    if (agents.length === this.value.agents.length) return false
    this.value = { ...this.value, agents }
    this.persist()
    return true
  }
}

/** 全局单例 — UI 组件直接 import 使用 */
export const agentStore = new AgentStore(agentRepo)
export type { AgentStoreData }
