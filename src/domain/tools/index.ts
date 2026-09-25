/**
 * Tool 注册中心 — 「工具定义权威源」与「执行器」的汇合点
 *
 * **机制 C 带来的职责变化**：
 * - 前端**不再编写定义**：定义来自权威源（Rust 侧 `agent/tool_defs/definitions.json`），
 *   经 `ToolDefinitionsLoader` 注入 —— Tauri 走 `cmd_list_tool_definitions`，
 *   浏览器 dev / vitest 直读同一份 JSON（见 `infrastructure/tools/definitions-source.ts`）；
 * - 注册中心只保存**执行器**（+ UI 文案 `label`，走 i18n）；
 * - `listDefinitions()` 返回「契约 ∩ 已注册执行器」，**顺序以契约为准** ——
 *   模型既不会看到没有实现的工具，也不会漏掉契约里新加的工具；
 * - 所有读取接口都是**异步**的（定义可能在首次读取时才从 Rust / 内嵌 JSON 载入）。
 *
 * ⚠️ 惰性描述（`ResolvableString`）机制随定义一起移出前端：平台相关描述现在由契约的
 * 三平台变体承载（`execute_command` / `execute_script`），不需要运行时求值。
 */
import { ToolRegistry } from '../ports/ToolRegistry'
import type {
  RegisteredExecutor,
  ResolvedRegisteredTool,
  ResolvedToolDefinition,
  ToolExecutor,
} from './types'
import type { ToolDefinitionsLoader } from './definitions'

// ==================== 定义加载器（组合根注入） ====================

let definitionsLoader: ToolDefinitionsLoader | null = null

/**
 * 注入定义加载器。
 *
 * 组合根（`src/main.ts`）在启动时接上 infrastructure 的实现；测试可注入假数据。
 * 换加载器会**清掉定义缓存**，避免测试之间或热更之后沿用旧定义。
 */
export function setToolDefinitionsLoader(
  loader: ToolDefinitionsLoader | null,
): void {
  definitionsLoader = loader
  toolRegistry.invalidateDefinitions()
}

// ==================== 注册中心 ====================

export class ToolRegistryImpl implements ToolRegistry {
  /** 执行器表：定义**不在**这里（定义由契约提供，避免第 2、3 份副本） */
  private executors: Map<string, RegisteredExecutor> = new Map()
  /** 权威定义缓存（已按平台选好） */
  private definitions: ResolvedToolDefinition[] | null = null
  /** 进行中的载入（并发去重，避免同时发起多次 IPC / 解析） */
  private loading: Promise<void> | null = null

  /** 载入权威定义（幂等）。启动时预热可让失败早暴露 */
  async init(): Promise<void> {
    await this.ensureDefinitions()
  }

  /** 丢弃定义缓存（下次读取会重新载入） */
  invalidateDefinitions(): void {
    this.definitions = null
    this.loading = null
  }

  private async ensureDefinitions(): Promise<ResolvedToolDefinition[]> {
    if (this.definitions) return this.definitions
    if (!this.loading) {
      if (!definitionsLoader) {
        throw new Error(
          '工具定义加载器未注入：启动时请调用 setToolDefinitionsLoader(loadToolDefinitions)',
        )
      }
      this.loading = definitionsLoader()
        .then((defs) => {
          this.definitions = defs
        })
        .finally(() => {
          this.loading = null
        })
    }
    await this.loading
    return this.definitions ?? []
  }

  /** 注册执行器（定义来自权威源） */
  async register(
    name: string,
    executor: ToolExecutor,
    label?: string,
  ): Promise<void> {
    this.executors.set(name, { name, label, executor })
  }

  /** 注销一个 tool */
  async unregister(name: string): Promise<boolean> {
    return this.executors.delete(name)
  }

  /** 检查 tool 是否已注册执行器 */
  async has(name: string): Promise<boolean> {
    return this.executors.has(name)
  }

  /** 清空所有 tools（含定义缓存） */
  async clear(): Promise<void> {
    this.executors.clear()
    this.invalidateDefinitions()
  }

  /** 契约 ∩ 执行器，顺序以契约为准；`label` 用注册时传入的 i18n 文案补齐 */
  async listDefinitions(): Promise<ResolvedToolDefinition[]> {
    const defs = await this.ensureDefinitions()
    const out: ResolvedToolDefinition[] = []
    for (const def of defs) {
      const exec = this.executors.get(def.name)
      if (exec) out.push(withLabel(def, exec))
    }
    return out
  }

  /** 获取单个 tool（定义与执行器缺一即 undefined） */
  async get(name: string): Promise<ResolvedRegisteredTool | undefined> {
    const exec = this.executors.get(name)
    if (!exec) return undefined
    const def = (await this.ensureDefinitions()).find((d) => d.name === name)
    if (!def) return undefined
    return { definition: withLabel(def, exec), executor: exec.executor }
  }

  /** 列出所有可用的已注册工具（契约顺序） */
  async listAll(): Promise<ResolvedRegisteredTool[]> {
    const defs = await this.ensureDefinitions()
    const out: ResolvedRegisteredTool[] = []
    for (const def of defs) {
      const exec = this.executors.get(def.name)
      if (exec) out.push({ definition: withLabel(def, exec), executor: exec.executor })
    }
    return out
  }

  /** 诊断：契约里有定义、但没有执行器（正常为空） */
  async missingExecutorNames(): Promise<string[]> {
    const defs = await this.ensureDefinitions()
    return defs.filter((d) => !this.executors.has(d.name)).map((d) => d.name)
  }

  /** 诊断：注册了执行器、但契约里没有定义（正常为空） */
  async missingDefinitionNames(): Promise<string[]> {
    const defs = await this.ensureDefinitions()
    const names = new Set(defs.map((d) => d.name))
    return [...this.executors.keys()].filter((n) => !names.has(n))
  }
}

/** 只补 UI 文案，其余字段原样使用契约（契约里没有 label） */
function withLabel(
  def: ResolvedToolDefinition,
  exec: RegisteredExecutor,
): ResolvedToolDefinition {
  return exec.label ? { ...def, label: exec.label } : def
}

/** 全局 tool 注册中心 */
export const toolRegistry = new ToolRegistryImpl()
