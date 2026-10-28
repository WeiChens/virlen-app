/**
 * mcpStore — MCP 设置页的**界面状态**（mobx observable）。
 *
 * ⚠️ 这里**不存配置的权威副本**：配置与运行态都由 Rust 持有（`app_settings.mcpServers` +
 * `McpManager` 快照）。store 只是最近一次 `cmd_mcp_list` / `mcp:status` 的结果，任何写操作
 * 之后都重新拉一遍 —— 否则「界面显示已启用、实际已经失败」这类幻觉迟早出现。
 */
import { makeObservable, observable } from 'mobx'
import type { McpServerConfig, McpServerStatus } from '@/domain/mcp'
import { mcpRepo } from '@/infrastructure/mcp/repo'

class McpStore {
  /** 服务器配置（含 disabled 的；顺序即用户配置顺序） */
  configs: McpServerConfig[] = []
  /** 运行态（与 configs 同 id 对应；可能短暂缺项 —— 刚新增还没起任务） */
  statuses: McpServerStatus[] = []
  /** 工具快照世代（每次工具集合变化 +1） */
  epoch = 0
  /** 正在拉取（按钮禁用 / 骨架） */
  loading = false
  /** 最近一次操作失败的原因（设置页顶部提示） */
  error: string | null = null
  /** 是否已从 Rust 拉过一次 */
  hydrated = false

  constructor() {
    makeObservable(this, {
      configs: observable,
      statuses: observable,
      epoch: observable,
      loading: observable,
      error: observable,
      hydrated: observable,
    })
  }

  /** 是否可用（非桌面环境：设置页显示「不可用」而不是空列表） */
  get available(): boolean {
    return mcpRepo.isAvailable()
  }

  statusOf(id: string): McpServerStatus | undefined {
    return this.statuses.find((status) => status.id === id)
  }

  configOf(id: string): McpServerConfig | undefined {
    return this.configs.find((config) => config.id === id)
  }

  /** 全量刷新（页面打开 / 任何写操作之后） */
  async refresh(): Promise<void> {
    if (!this.available) {
      this.hydrated = true
      return
    }
    this.loading = true
    this.error = null
    try {
      const result = await mcpRepo.list()
      this.configs = result.configs
      this.statuses = result.statuses
      this.epoch = result.epoch
      this.hydrated = true
    } catch (e: any) {
      this.error = e?.message ?? String(e)
    } finally {
      this.loading = false
    }
  }

  /** Rust 推来的状态快照（`mcp:status` 事件）—— 只覆盖状态，不动配置 */
  applyStatuses(statuses: McpServerStatus[]): void {
    this.statuses = statuses
  }

  applyEpoch(epoch: number): void {
    this.epoch = epoch
  }
}

/** 全局单例 —— 设置页与服务层共用 */
export const mcpStore = new McpStore()
