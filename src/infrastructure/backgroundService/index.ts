/**
 * 「后台服务」面板的数据入口。权威状态在 Rust（与四个 `*_background_service` 工具共用同一张注册表，
 * 按会话隔离）。这里只调命令 + 按环境降级，前端不缓存状态（AI 杀掉的服务不能在这边阴魂不散）。
 */
import { invoke } from '@tauri-apps/api/core'

/** 服务快照（字段与 Rust `service/common.rs::base_ui` 逐字对应） */
export interface BackgroundServiceInfo {
  id: string
  name: string
  cmd: string
  /**
   * running | exited。
   * 没有 failed：spawn 失败根本不会产生条目（那个状态只出现在 start 工具的结果里）。
   */
  status: 'running' | 'exited'
  /** 退出码（平台取不到时为 null） */
  returnCode: number | null
  /** 是否被终止（区分自己退出 vs 被 AI / 用户终止） */
  killed: boolean
  pid: number
  startedAt: number
  uptimeMs: number
  /** 人类可读的运行时长（12s / 2m10s），卡片与面板共用 */
  uptime: string
  /** write_isolation / readonly / no_sandbox_*（词表见 SandboxBadge） */
  sandbox: string
  /** AI 还没读过的输出字符数 */
  unreadChars: number
  /** 是否跑在伪控制台里 —— true 才能在终端面板里敲键盘 */
  terminal: boolean
  /** 现在就能输入（terminal && 仍在运行）；false 时终端面板只读回放 */
  interactive: boolean
  /**
   * 归属会话（只有全局列表会带）。新对话页靠它给每行标「这条是谁的」，
   * 并把终止 / 终端面板打到正确的会话上。
   */
  sessionId?: string
}

/** Tauri 环境判定（与 rust-engine.ts::isTauriAvailable 同一口径） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 列本会话的后台服务（含已结束但仍在表里的条目）。
 * 非 Tauri 与命令失败都回空列表 —— 旁路信息，读不到不该让页面出错。
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
 * 列所有会话的后台服务（新对话页的全局入口；每行带 sessionId）。
 * 只在没选中会话时调用：服务是活进程，切到新对话页也不能「找不到它」。
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
 * 终止一个后台服务，返回它的最新快照。
 *
 * 返回 null = 本会话已没有这个 id；与 kill 工具的区别：条目不会被摘掉（面板要显示「已结束」）。
 * 失败向上抛：这是用户主动操作，静默失败会让人以为杀掉了。
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

// ==================== 服务终端（右侧面板里的一个标签） ====================

/** 终端面板读到的增量（字段与 Rust panel.rs::read_service_console 逐字对应） */
export interface ServiceConsoleChunk {
  /** reset=true 时是整个窗口，否则只是自上次 next 起的新增部分 */
  text: string
  /** true = 客户端必须丢掉本地内容整段重放（首次读取 / 环形已丢掉客户端持有的开头） */
  reset: boolean
  /** 本次读取后的绝对偏移（下次请求原样传回 from） */
  next: number
  /** 窗口开头是否已被环形丢弃（提示「更早的输出看不到了」） */
  headDropped: boolean
  /** 服务是否仍在运行 */
  running: boolean
  /** 是否有伪控制台（false = 管道模式，弹窗只是只读回放） */
  terminal: boolean
  /** 现在能不能输入（running && terminal） */
  interactive: boolean
}

/**
 * 读终端输出（自绝对偏移 from 起的增量）。
 * 返回 null = 本会话已没有这个 id（面板据此停止轮询）；IPC 异常会向上抛，
 * 调用方保留上一帧继续轮询（两种语义必须分开）。
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
 * 把键击（或粘贴内容）写进伪控制台。
 * false = 没写进去（已结束 / 管道模式 / 已不在表里）。键击丢失不弹错（xterm 每敲一下都调这里）。
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
 * 把终端量出来的列×行同步给伪控制台（否则折行位置不一致）。
 * false = 没有可调的控制台；同尺寸重复上报由 Rust 侧去重。
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

// ==================== 结束通知 ====================

/**
 * 结束通知回执：告诉 Rust「这条已上屏 + 落库」→ 它才把通知从「待注入队列」里摘掉。
 *
 * ⚠️ 必须在上屏 + `cmd_append_messages` **都成功之后**才调：Rust 侧 emit 成功不代表有人接
 *（没有监听者时同样成功），漏了 ack 它会在下一次请求前再注入一遍（按 id 去重，不会重复上屏）。
 */
export async function ackServiceNotice(id: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('cmd_ack_service_notice', { id })
  } catch (e: any) {
    console.warn(`[service] 结束通知回执失败：${e?.message || String(e)}`)
    return false
  }
}
