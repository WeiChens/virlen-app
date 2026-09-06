/**
 * Tool 注册中心 — 管理所有注册的 tools
 */
import { ToolRegistry } from '../ports/ToolRegistry'
import type {
  RegisteredTool,
  ResolvedRegisteredTool,
  ResolvableString,
  ResolvedToolDefinition,
  ToolDefinition,
  ToolExecutor,
} from './types'

/**
 * 求值单个惰性描述：函数在真正序列化时调用，拿到调用时刻的动态信息
 * （如 execute_command 的平台缓存，此时 Rust os_platform 通常已就绪）。
 */
function resolveResolvable(v: ResolvableString): string {
  return typeof v === 'function' ? v() : v
}

/**
 * 拷贝 definition，并把所有惰性描述解析为纯字符串。
 * 返回的新对象不含任何函数，可直接 JSON 序列化或展示给 UI。
 * 惰性函数每次 listDefinitions()/get()/listAll() 时重新求值，
 * 因此权威信息（如 os_platform 缓存）晚于注册就绪时也能拿到最新值。
 */
function resolveDefinition(def: ToolDefinition): ResolvedToolDefinition {
  const properties: ResolvedToolDefinition['parameters']['properties'] = {}
  for (const [key, prop] of Object.entries(def.parameters.properties)) {
    if (prop.description === undefined || typeof prop.description === 'string') {
      properties[key] = prop as ResolvedToolDefinition['parameters']['properties'][string]
    } else {
      properties[key] = { ...prop, description: prop.description() }
    }
  }
  return {
    ...def,
    description: resolveResolvable(def.description),
    parameters: { ...def.parameters, properties },
  }
}

export class ToolRegistryImpl implements ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map()

  /** 注册一个 tool */
  async register(definition: ToolDefinition, executor: ToolExecutor) {
    // 保存原始定义（description 可能仍是惰性函数，待序列化时再求值）
    this.tools.set(definition.name, { definition, executor })
  }

  /** 注销一个 tool */
  async unregister(name: string) {
    return this.tools.delete(name)
  }

  /** 获取 tool（返回已解析定义：惰性描述已求值为纯字符串） */
  async get(name: string): Promise<ResolvedRegisteredTool | undefined> {
    const t = this.tools.get(name)
    if (!t) return undefined
    return { definition: resolveDefinition(t.definition), executor: t.executor }
  }

  /** 列出所有 tool 定义（用于发送给 LLM；惰性描述在此求值为字符串） */
  listDefinitions(): ResolvedToolDefinition[] {
    return Array.from(this.tools.values()).map((t) =>
      resolveDefinition(t.definition),
    )
  }

  /** 列出所有注册的 tool（返回已解析定义） */
  async listAll(): Promise<ResolvedRegisteredTool[]> {
    return Array.from(this.tools.values()).map((t) => ({
      definition: resolveDefinition(t.definition),
      executor: t.executor,
    }))
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
