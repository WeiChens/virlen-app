/**
 * backgroundService — 聊天页「后台服务」面板的**数据入口**（唯一）。
 *
 * 权威状态在 Rust：四个 `*_background_service` 工具与面板共用**同一张注册表**
 *（`virlen-core/src/agent/native_tools/service/registry.rs`，按会话隔离）。
 * 本文件只做两件事 —— 调命令、按环境降级；⚠️ 前端**不缓存**服务状态（AI 杀掉的服务不能在这边阴魂不散）。
 *
 * P3 增终端弹窗的三条（读合并流 / 写键击 / 改尺寸）：它们只服务**用户**在弹窗里的交互，
 * 与工具无关，但同样只认会话 id（跨会话一律当成「没有这个服务」）。
 */
import { invoke } from '@tauri-apps/api/core'

/** 服务快照（字段与 Rust `service/common.rs::base_ui` + `unreadChars` 逐字对应，语言无关） */
export interface BackgroundServiceInfo {
  id: string
  name: string
  cmd: string
  /**
   * `running` | `exited`。
   * ⚠️ 没有 `failed`：spawn 失败根本不会产生条目（那个状态只出现在 `start` 工具的结果里）。
   */
  status: 'running' | 'exited'
  /** 退出码（平台取不到时为 null） */
  returnCode: number | null
  /** 是否「被终止」（区分自己退出 vs 被 AI / 用户终止 —— 与工具侧 `killed` 同义） */
  killed: boolean
  pid: number
  startedAt: number
  uptimeMs: number
  /** 人类可读的运行时长（`12s` / `2m10s`，与语言无关，卡片与面板共用同一份） */
  uptime: string
  /** `write_isolation` / `readonly` / `no_sandbox_*`（词表见 `SandboxBadge`） */
  sandbox: string
  /** AI 还没读过的输出字符数 */
  unreadChars: number
  /** 是否跑在伪控制台里（P3）—— true 才能在弹窗里敲键盘 */
  terminal: boolean
  /** 现在就能输入（`terminal && 仍在运行`）；false 时弹窗是只读回放 */
  interactive: boolean
  /**
   * 归属会话（**只有全局列表** `listAllBackgroundServices` 会带；本会话列表不返回这个字段）。
   * 新对话页的全局视图靠它给每行标「这条是谁的」，并把终止 / 终端弹窗打到正确的会话上（P4）。
   */
  sessionId?: string
}

/** Tauri 环境判定（与 `services/rust-engine.ts::isTauriAvailable` 同一口径） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 列本会话的后台服务（按启动时间升序，含已结束但仍在表里的条目）。
 *
 * 非 Tauri（浏览器 dev / vitest）与命令失败都回空列表 —— 面板显示「暂无」，不抛错
 *（理由同 `memoryRepo`：这是**旁路**信息，读不到不该让页面出错）。
 */
export async function listBackgroundServices(
  sessionId: string,
): Promise<BackgroundServiceInfo[]> {
  if (!isTauri()) return []
  try {
    const rows = await invoke<BackgroundServiceInfo[]>(
      'cmd_list_background_services',
      { sessionId },
    )
    return rows ?? []
  } catch (e: any) {
    console.warn(`[service] 读取后台服务列表失败：${e?.message || String(e)}`)
    return []
  }
}

/**
 * 列**所有会话**的后台服务（新对话页的全局入口用；每行带 `sessionId` 归属，P4）。
 *
 * 只在聊天页**没有选中会话**时调用：服务是活进程，切到新对话页也不能「找不到它」。
 * 与 `listBackgroundServices` 同一张表、同一份字段（多一个 `sessionId`），前端共用一套解析。
 * 非 Tauri（浏览器 dev / vitest）与命令失败同样回空列表 —— 旁路信息，读不到不该让页面出错。
 */
export async function listAllBackgroundServices(): Promise<
  BackgroundServiceInfo[]
> {
  if (!isTauri()) return []
  try {
    const rows = await invoke<BackgroundServiceInfo[]>(
      'cmd_list_all_background_services',
    )
    return rows ?? []
  } catch (e: any) {
    console.warn(`[service] 读取全局后台服务列表失败：${e?.message || String(e)}`)
    return []
  }
}

/**
 * 终止一个后台服务（面板「终止」按钮），返回它的最新快照。
 *
 * 返回 `null` = 本会话已没有这个 id（多半是 AI 刚 kill 掉并把它清出了注册表）。
 * ⚠️ 与工具 `kill_background_service` 的区别：**条目不会被摘掉** —— 面板的「已结束」页要继续显示它。
 * 失败向上抛（调用方 toast），因为这是**用户主动操作**，静默失败会让人以为杀掉了。
 */
export async function killBackgroundService(
  sessionId: string,
  id: string,
): Promise<BackgroundServiceInfo | null> {
  if (!isTauri()) return null
  const row = await invoke<BackgroundServiceInfo | null>(
    'cmd_kill_background_service',
    { sessionId, id },
  )
  return row ?? null
}

// ==================== 终端弹窗（P3） ====================

/** 终端弹窗读到的增量（字段与 Rust `panel.rs::read_service_console` 逐字对应） */
export interface ServiceConsoleChunk {
  /** `reset=true` 时是**整个窗口**，否则只是自上次 `next` 起的新增部分 */
  text: string
  /** true = 客户端必须丢掉本地内容整段重放（首次读取 / 环形已丢掉客户端持有的开头） */
  reset: boolean
  /** 本次读取后的绝对偏移（下次请求原样传回 `from`） */
  next: number
  /** 窗口开头是否已被环形丢弃（提示「更早的输出看不到了」） */
  headDropped: boolean
  /** 服务是否仍在运行 */
  running: boolean
  /** 是否有伪控制台（false = 管道模式，弹窗只是只读回放） */
  terminal: boolean
  /** 现在能不能输入（`running && terminal`） */
  interactive: boolean
}

/**
 * 读服务的终端输出（自绝对偏移 `from` 起的增量）。
 *
 * 返回 `null` = **本会话已没有这个 id**（AI 把它 kill 掉并清出了注册表 / 会话已切走）——
 * 弹窗据此提示并停止轮询。命令本身失败（IPC 异常）会向上抛，调用方保留上一帧内容继续轮询
 * （不把它当成「服务没了」，两种语义必须分开）。
 */
export async function readServiceConsole(
  sessionId: string,
  id: string,
  from: number,
): Promise<ServiceConsoleChunk | null> {
  if (!isTauri()) return null
  const chunk = await invoke<ServiceConsoleChunk | null>(
    'cmd_service_console_read',
    { sessionId, id, from },
  )
  return chunk ?? null
}

/**
 * 把用户的键击（或粘贴内容）写进服务的伪控制台。
 *
 * `false` = 没写进去（服务已结束 / 管道模式 / 已不在表里）。⚠️ 键击丢失不是恶性错误，
 * 调用方**不弹错**（xterm 每敲一下都会调这里，弹错会把界面滚满）。
 */
export async function writeServiceConsole(
  sessionId: string,
  id: string,
  data: string,
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('cmd_service_console_write', {
      sessionId,
      id,
      data,
    })
  } catch (e: any) {
    console.warn(`[service] 终端输入失败：${e?.message || String(e)}`)
    return false
  }
}

/**
 * 把终端量出来的列×行同步给服务的伪控制台（否则折行位置与服务那边不一致）。
 *
 * 返回 `false` = 没有可调的控制台（服务已结束 / 管道模式）；`XtermTerminal` 的尺寸上报
 * 会据此短重试（与 `pty_resize` 同一套逻辑）。同尺寸重复上报由 Rust 侧去重，可以无脑调。
 */
export async function resizeServiceConsole(
  sessionId: string,
  id: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('cmd_service_console_resize', {
      sessionId,
      id,
      cols,
      rows,
    })
  } catch {
    return false
  }
}
