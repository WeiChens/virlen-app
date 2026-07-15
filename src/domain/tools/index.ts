/**
 * Tool 注册中心 — 管理所有注册的 tools
 */
import { ToolRegistry } from '../ports/ToolRegistry'
import type { RegisteredTool, ToolDefinition, ToolExecutor } from './types'

export class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map()

  /** 注册一个 tool */
  async register(definition: ToolDefinition, executor: ToolExecutor) {
    this.tools.set(definition.name, { definition, executor })
  }

  /** 注销一个 tool */
  async unregister(name: string) {
    return this.tools.delete(name)
  }

  /** 获取 tool */
  async get(name: string) {
    return this.tools.get(name)
  }

  /** 列出所有 tool 定义（用于发送给 LLM） */
  listDefinitions() {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  /** 列出所有注册的 tool */
  async listAll() {
    return Array.from(this.tools.values())
  }

  /** 检查 tool 是否存在 */
  async has(name: string) {
    return this.tools.has(name)
  }

  /** 清空所有 tools */
  async clear() {
    this.tools.clear()
  }
}

/** 全局 tool 注册中心 */
export const toolRegistry = new ToolRegistryImpl()
