/**
 * mcp — MCP 事件桥（前端唯一出口）。
 *
 * Rust 侧 `McpManager` 每次快照变化都会经 `TauriMcpSink` 发两个事件：
 * - `mcp:status`：**状态**变了（连接 / 退避 / 失败）→ 只刷新状态胶囊；
 * - `mcp:changed`：**工具集合**变了 → 失效工具定义缓存（下一次拉定义自然拿到新集合）。
 *
 * ⚠️ 这里**不再动 Agent 白名单**。早前版本每次 `mcp:changed` 都把新工具名补进默认 Agent
 * （“`allowedTools` 是穷举名单，不补就看不到”），结果是：用户在默认 Agent 里取消勾选的
 * MCP 工具会被反复加回来。现在白名单只由用户在编辑器里决定（`initDefaultAgent` 也是只建不补）。
 *
 * 与 `service-notice.ts` 同一套写法：`started` 标志同步置位（`listen` 的 promise resolve
 * 之前就可能被并发调用，只看 promise 会挂两个监听）。
 */
import { listen } from '@tauri-apps/api/event'
import { isTauriAvailable } from '@/services/rust-engine'
import { toolRegistry } from '@/domain/tools'
import { mcpStore } from '@/ui/store/mcpStore'
import type { McpServerStatus } from '@/domain/mcp'

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
  //（`npx` 冷启动 vs webview 启动的快慢不定）。主动对齐一次：失效定义缓存，
  // 否则要等到下一台服务器连上才看得到已连好的那批工具。
  void handleMcpChanged().catch(() => {
    // 对齐失败不影响主流程：下一次 `mcp:changed` 或用户手动刷新会再试
  })
}

/**
 * 工具集合变了：失效定义缓存 → 刷新状态与冲突名单。
 *
 * 导出以便单测直接驱动（真正的调用方是上面的监听器）。
 */
export async function handleMcpChanged(epoch?: number): Promise<void> {
  if (typeof epoch === 'number') mcpStore.applyEpoch(epoch)
  toolRegistry.invalidateDefinitions()
  // 定义与冲突名单都在服务端快照里：拉一次就对齐（含「刚刚被扣下不发的同名工具」）
  await mcpStore.refresh()
}
