/**
 * MCP 的 Tauri 命令封装（infrastructure）。
 *
 * ⚠️ **配置的唯一持久化在 Rust**（`app_settings.mcpServers`）：前端不缓存、不写 localStorage，
 * 也不用 `SettingsStore` —— 否则同一个键有两个写者，谁最后保存谁把对方顶掉。
 *
 * 非 Tauri 环境（浏览器 dev / vitest）全部降级为空实现：设置页能渲染，但显示「不可用」。
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  McpImportResult,
  McpListResult,
  McpProbeResult,
  McpServerConfig,
  McpServerStatus,
} from '@/domain/mcp'
import type { ResolvedToolDefinition } from '@/domain/tools/types'

/** 是否在 Tauri 环境（与本仓库其它 infra 同一判据） */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export interface McpRepo {
  /** 有没有真实后端（非 Tauri → false，设置页显示不可用而不是假装空列表） */
  isAvailable(): boolean
  /** 配置 + 状态 + 世代（一次 IPC） */
  list(): Promise<McpListResult>
  /** 新增 / 编辑（整条覆盖） */
  upsert(config: McpServerConfig): Promise<{ ok: boolean; id: string }>
  remove(id: string): Promise<{ ok: boolean }>
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }>
  /** 手动重连（不传 id = 全部） */
  reload(id?: string): Promise<{ ok: boolean }>
  /** 当前快照里的 MCP 工具定义（同步返回，不等连接） */
  toolDefinitions(): Promise<ResolvedToolDefinition[]>
  status(): Promise<McpServerStatus[]>
  /** 「测试连接」：临时连一次，不落库 */
  test(config: McpServerConfig): Promise<McpProbeResult>
  /** 从 Claude Desktop 风格 JSON 导入 */
  importJson(json: string): Promise<McpImportResult>
  /**
   * 要注入系统提示词的服务器说明书（已带归属前缀 + 32 KB 截断）；没有 → `null`。
   * 建会话时取一次（与长期记忆同理：中途变更不改已建会话的 systemPrompt）。
   */
  instructions(): Promise<string | null>
}

const EMPTY_LIST: McpListResult = { configs: [], statuses: [], epoch: 0 }

const tauriRepo: McpRepo = {
  isAvailable: () => true,
  list: () => invoke<McpListResult>('cmd_mcp_list'),
  upsert: (config) => invoke('cmd_mcp_upsert', { config }),
  remove: (id) => invoke('cmd_mcp_remove', { id }),
  setEnabled: (id, enabled) => invoke('cmd_mcp_set_enabled', { id, enabled }),
  reload: (id) => invoke('cmd_mcp_reload', { id: id ?? null }),
  toolDefinitions: () =>
    invoke<ResolvedToolDefinition[]>('cmd_mcp_tool_definitions'),
  status: () => invoke<McpServerStatus[]>('cmd_mcp_status'),
  test: (config) => invoke<McpProbeResult>('cmd_mcp_test', { config }),
  importJson: (json) => invoke<McpImportResult>('cmd_mcp_import', { json }),
  instructions: () => invoke<string | null>('cmd_mcp_instructions'),
}

const noopRepo: McpRepo = {
  isAvailable: () => false,
  list: async () => EMPTY_LIST,
  upsert: async (config) => ({ ok: false, id: config.id }),
  remove: async () => ({ ok: false }),
  setEnabled: async () => ({ ok: false }),
  reload: async () => ({ ok: false }),
  toolDefinitions: async () => [],
  status: async () => [],
  test: async () => ({
    ok: false,
    toolCount: 0,
    tools: [],
    error: '当前环境不支持 MCP（非桌面应用）',
  }),
  importJson: async () => ({ imported: [], skipped: [] }),
  instructions: async () => null,
}

export const mcpRepo: McpRepo = {
  isAvailable: () => (isTauriEnv() ? tauriRepo.isAvailable() : false),
  list: () => (isTauriEnv() ? tauriRepo.list() : noopRepo.list()),
  upsert: (config) => (isTauriEnv() ? tauriRepo.upsert(config) : noopRepo.upsert(config)),
  remove: (id) => (isTauriEnv() ? tauriRepo.remove(id) : noopRepo.remove(id)),
  setEnabled: (id, enabled) =>
    isTauriEnv() ? tauriRepo.setEnabled(id, enabled) : noopRepo.setEnabled(id, enabled),
  reload: (id) => (isTauriEnv() ? tauriRepo.reload(id) : noopRepo.reload(id)),
  toolDefinitions: () =>
    isTauriEnv() ? tauriRepo.toolDefinitions() : noopRepo.toolDefinitions(),
  status: () => (isTauriEnv() ? tauriRepo.status() : noopRepo.status()),
  test: (config) => (isTauriEnv() ? tauriRepo.test(config) : noopRepo.test(config)),
  importJson: (json) =>
    isTauriEnv() ? tauriRepo.importJson(json) : noopRepo.importJson(json),
  instructions: () =>
    isTauriEnv() ? tauriRepo.instructions() : noopRepo.instructions(),
}
