/**
 * mcp — MCP 事件桥（前端唯一出口）。
 *
 * Rust 侧 `McpManager` 每次快照变化都会经 `TauriMcpSink` 发两个事件：
 * - `mcp:status`：**状态**变了（连接 / 退避 / 失败）→ 只刷新状态胶囊；
 * - `mcp:changed`：**工具集合**变了 → 失效工具定义缓存 + 把新工具补进默认 Agent 白名单。
 *
 * 为什么「补白名单」要在这里做：`allowedTools` 是穷举名单（`undefined` 才是全部），
 * 新连上的 MCP 工具不会自动出现在存量 Agent 里 —— 用户连了服务器却发现模型看不到工具，
 * 是这条链上最容易踩的坑。只补默认 Agent，不改用户自定义 Agent（那是在编辑器里选的）。
 *
 * 与 `service-notice.ts` 同一套写法：`started` 标志同步置位（`listen` 的 promise resolve
 * 之前就可能被并发调用，只看 promise 会挂两个监听）。
 */
import { listen } from '@tauri-apps/api/event'
import { isTauriAvailable } from '@/services/rust-engine'
import { toolRegistry } from '@/domain/tools'
import { initDefaultAgent } from '@/services/agent-service'
import { agentStore } from '@/ui/store/agentStore'
import { mcpStore } from '@/ui/store/mcpStore'
import { migrateAllowedToolNames, type McpServerStatus } from '@/domain/mcp'

/** Rust → JS 事件名（`src-tauri/src/commands/mcp.rs::TauriMcpSink`） */
export const EVENT_MCP_CHANGED = 'mcp:changed'
export const EVENT_MCP_STATUS = 'mcp:status'

let started = false

/** 挂上监听（`main.ts::init` 调一次；非 Tauri / 挂载失败一律静默降级） */
export function initMcpBridge(): void {
  if (started || !isTauriAvailable()) return
  started = true

  void listen<{ epoch: number }>(EVENT_MCP_CHANGED, (event) => {
    void handleMcpChanged(event.payload?.epoch)
  }).catch(() => {
    started = false
  })

  void listen<McpServerStatus[]>(EVENT_MCP_STATUS, (event) => {
    mcpStore.applyStatuses(event.payload ?? [])
  }).catch(() => {
    // 状态事件失败只影响设置页的实时刷新（用户重开页面会重新拉），不影响工具可用性
  })

  // 首次水合：启动时 Rust 已经按配置连过一轮，而工具可能在我们挂上监听**之前**就连好了
  //（`npx` 冷启动 vs webview 启动的快慢不定）。主动对齐一次：失效定义缓存 + 补默认 Agent 白名单，
  // 否则要等到下一台服务器连上才看得到已连好的那批工具。
  void handleMcpChanged().catch(() => {
    // 对齐失败不影响主流程：下一次 `mcp:changed` 或用户手动刷新会再试
  })
}

/**
 * 服务器改名 → 迁移各 Agent 白名单里的旧公开名（返回改写的名字条数）。
 *
 * 为什么在前端做而不是在 `cmd_mcp_upsert` 里直接改表：Agent 的运行期权威副本是
 * `agentRepo` 的**内存快照**（写入 400ms debounce 才落表）。Rust 改表后前端快照仍是旧的，
 * 下一次 `initDefaultAgent()` 或编辑器保存会把它整份写回去，迁移当场被抹掉。
 * 代价：绕过 GUI 直接改 `app_settings.mcpServers`（如 `virlen-cli config set`）不会迁移。
 */
export function migrateAgentToolNames(oldName: string, newName: string): number {
  const before = agentStore.listAgents()
  const { agents, changed } = migrateAllowedToolNames(before, oldName, newName)
  if (changed === 0) return 0
  // 只写真正改过的那几个：saveAgent 会刷 updatedAt，没必要整份重写
  agents.forEach((agent, index) => {
    if (agent !== before[index]) agentStore.saveAgent(agent)
  })
  return changed
}

/**
 * 工具集合变了：失效定义缓存 → 补进默认 Agent → 刷新 Agent 列表。
 *
 * 导出以便单测直接驱动（真正的调用方是上面的监听器）。
 */
export async function handleMcpChanged(epoch?: number): Promise<void> {
  if (typeof epoch === 'number') mcpStore.applyEpoch(epoch)
  toolRegistry.invalidateDefinitions()
  try {
    await initDefaultAgent()
    agentStore.reload()
  } catch (e: any) {
    // 补白名单失败不该影响「工具已经可用」这件事：下一次发送时 resolveToolDefs 仍会读到新定义
    console.warn(`[mcp] 默认 Agent 白名单补入失败：${e?.message ?? String(e)}`)
  }
  // 状态也顺手对齐（工具集合变了，工具数一定变了）
  await mcpStore.refresh()
}
