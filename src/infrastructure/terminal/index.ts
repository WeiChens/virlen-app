/**
 * 用户终端（右侧面板「新建终端」）的数据入口。
 *
 * 权威状态在 Rust（`virlen_core::agent::native_tools::user_shell`）：一张**按会话隔离**的
 * 终端注册表，每个条目挂着一个 ConPTY 与一段可续接的输出窗口。这里只调命令、按环境降级，
 * 前端不缓存状态 —— 终端被关掉之后不能在这边阴魂不散。
 *
 * 与 `backgroundService` 的分工：那边是「AI 起的后台服务 + 用户接管」，这边是**用户自己的 shell**。
 * 命令的名词（`sessionId` / `id` / `from` / `cols` / `rows`）与那边逐字一致，前端两套轮询逻辑
 * 因此可以对照着读（`use-user-console` ⇄ `use-service-console`）。
 *
 * 三条口径：
 * 1. **默认脱壳**：终端里的命令跑在用户环境里（与 VS Code 一致），不经过沙盒与审批 ——
 *    界面上用「沙盒已关闭」徽标如实标注，与「AI 执行必须过沙盒」是两套语义；
 * 2. **只有在桌面应用里才有终端**：非 Tauri 环境 `start` 直接抛错（不假装能用）；
 * 3. **不记录任何输入内容**：`write` 只回布尔（键击里常是密码 / token）。
 *
 * 输出有**两条来源**（共用一套绝对偏移续接）：`readUserTerminal` 是权威快照 + 增量，
 * `onUserTerminalOutput` 是输出一到就推的实时增量。前端靠推送跟回显，偏移断了才回头补读。
 *
 * 可选的 shell 有四种（`cmd` / `powershell` / `pwsh` / `gitbash`）：后两种要另外安装，
 * 所以界面**先问 `listUserTerminalShells`**，没装的灰显 —— 不让用户点了才收到「启动失败」。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** 新起的终端（字段与 Rust `user_shell/panel.rs::start_terminal` 逐字对应） */
export interface UserTerminalInfo {
  /** 终端 id（`term_1` …）。**只在界面里用**，不进模型上下文 */
  id: string
  /** 实际使用的 shell 类型 id（`cmd` / `powershell` / `pwsh` / `gitbash`） */
  shell: string
  /** 可执行文件绝对路径（诊断用：同一台机器上可能装了两个 pwsh） */
  command: string
  /** 工作目录（会话工作区） */
  cwd: string
  /** shell 进程 pid */
  pid: number
  /** 启动时刻（毫秒） */
  startedAt: number
}

/**
 * 一种可选的终端类型（字段与 Rust `user_shell/shells.rs::detect_all` + `panel::list_shells` 对应）。
 *
 * ⚠️ 展示名不在这里：那是界面文案（`ui/pages/chat/components/terminal/shells.ts` 的
 * `shellLabel`）。core 只给稳定 id，免得「命令提示符」这种中文名字跑进 Rust。
 */
export interface UserTerminalShell {
  /** 类型 id（`cmd` / `powershell` / `pwsh` / `gitbash`），开终端时原样传回 */
  id: string
  /** 可执行文件名（`pwsh.exe`；未安装时就是给用户看的那个名字） */
  exe: string
  /** 这台机器上装没装（false → 菜单里灰显 + 标「未安装」） */
  available: boolean
  /** 找到的绝对路径（未安装 = 空串） */
  command: string
  /** 启动参数 */
  args: string[]
  /** 没记忆时的首选（Rust 侧口径：powershell 装了就是它） */
  default: boolean
  /** 未安装的原因（查过哪些目录），直接当提示文案 */
  hint: string | null
}

/** 一次读取拿到的增量（字段与 Rust `user_shell/panel.rs::read_terminal` 逐字对应） */
export interface UserTerminalChunk {
  /** `reset=true` 时是整个窗口，否则只是自上次 `next` 起的新增部分 */
  text: string
  /** true = 客户端必须丢掉本地内容整段重放（首次读取 / 环形已丢掉客户端持有的开头） */
  reset: boolean
  /** 本次读取后的绝对偏移（下次请求原样传回 from） */
  next: number
  /** 窗口开头是否已被环形丢弃（提示「更早的输出看不到了」） */
  headDropped: boolean
  /** shell 是否还在跑 */
  running: boolean
  /** 现在能不能输入（`running && 控制台还活着`） */
  interactive: boolean
  /** 退出码（跑着的时候是 null） */
  exitCode: number | null
  /** 是不是被关掉的（区分「自己 exit」与「被终止」） */
  killed: boolean
}

/** Tauri 环境判定（与 `backgroundService` 同一口径） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 推送事件名（与 Rust `commands/terminal.rs::OUTPUT_EVENT` 必须一致） */
export const TERMINAL_OUTPUT_EVENT = 'terminal:output'

/**
 * 一帧推送（Rust 侧输出一到就发，**不用等轮询**）。
 *
 * 与 `cmd_terminal_read` 的应答互补：那边是「权威快照 + 增量」，这边是「实时增量」。
 * 两者共用同一套**绝对偏移**续接：事件带的 `from` 与本地位移不一致（事件丢了 / 慢了一帧）
 * 就回头调读命令补上 —— 所以推送丢帧不会丢内容，只是慢一小下。
 */
export interface UserTerminalOutput {
  /** 归属会话 */
  sessionId: string
  /** 终端 id */
  id: string
  /** 这一段的**起始**绝对偏移；与本地游标不符 = 中间缺一截，应补读 */
  from: number
  /** 这一段的**结束**偏移（= 读命令的 `next`） */
  next: number
  /** 增量正文；`reset` 时是**整个窗口** */
  text: string
  /** 客户端必须丢掉本地内容整段重放（开头已被环形丢弃） */
  reset: boolean
  /** 此刻 shell 是否还在跑（终态变化也走这条，不必等下一次轮询） */
  running: boolean
}

/**
 * 订阅某个会话的终端输出推送。
 *
 * 非桌面环境返回空取消函数（调用方不必写两套挂载逻辑）。
 */
export async function onUserTerminalOutput(
  handler: (frame: UserTerminalOutput) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<UserTerminalOutput>(TERMINAL_OUTPUT_EVENT, (event) => {
    const p = event.payload
    // 形状不对的载荷一律当没收到：宁可走补读，也不拿半个帧去改光标
    if (!p || typeof p.sessionId !== 'string' || typeof p.id !== 'string') return
    if (typeof p.from !== 'number' || typeof p.next !== 'number') return
    handler({
      sessionId: p.sessionId,
      id: p.id,
      from: p.from,
      next: p.next,
      text: typeof p.text === 'string' ? p.text : '',
      reset: p.reset === true,
      running: p.running !== false,
    })
  })
  return unlisten
}

/**
 * 起一个终端。**失败会抛**（工作目录不存在 / 平台不支持 / 终端数量到上限 / 选的那种没装）：
 * 这是用户主动点的动作，静默失败会让人以为「点了没反应」。
 *
 * `cols` / `rows` 只是创建时的尺寸：xterm 挂载后立刻会上报真实尺寸。
 * `shell` 是类型 id（`cmd` / `powershell` / `pwsh` / `gitbash`）：省略 = 让 Rust 用默认（powershell）。
 */
export async function startUserTerminal(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  shell?: string,
): Promise<UserTerminalInfo> {
  if (!isTauri()) {
    throw new Error('终端只在桌面应用中可用')
  }
  return await invoke<UserTerminalInfo>('cmd_terminal_start', {
    sessionId,
    cwd,
    cols,
    rows,
    shell: shell ?? null,
  })
}

/**
 * 问一下这台机器上支持哪些 shell、装没装（新建终端的菜单每次打开都现问）。
 *
 * 非桌面环境回空数组（调用方退回「直接用默认」）。
 * 探测只做文件存在性检查（不真的执行 shell），但**不缓存**：用户可能刚装完 Git。
 */
export async function listUserTerminalShells(): Promise<UserTerminalShell[]> {
  if (!isTauri()) return []
  try {
    const list = await invoke<UserTerminalShell[] | null>('cmd_terminal_shells')
    return Array.isArray(list) ? list.filter((s) => !!s && typeof s.id === 'string') : []
  } catch (e: any) {
    console.warn(`[terminal] 读取终端类型列表失败：${e?.message || String(e)}`)
    return []
  }
}

/**
 * 读终端输出（自绝对偏移 `from` 起的增量）。
 * 返回 null = 本会话已没有这个终端（面板据此收尾）；IPC 异常会向上抛，
 * 调用方保留上一帧继续轮询（两种语义必须分开）。
 */
export async function readUserTerminal(
  sessionId: string,
  id: string,
  from: number,
): Promise<UserTerminalChunk | null> {
  if (!isTauri()) return null
  const chunk = await invoke<UserTerminalChunk | null>('cmd_terminal_read', {
    sessionId,
    id,
    from,
  })
  return chunk ?? null
}

/**
 * 把键击（或粘贴内容）写进伪控制台。
 * false = 没写进去（已结束 / 已不在表里）。键击丢失不弹错（xterm 每敲一下都调这里）。
 */
export async function writeUserTerminal(
  sessionId: string,
  id: string,
  data: string,
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('cmd_terminal_write', { sessionId, id, data })
  } catch (e: any) {
    console.warn(`[terminal] 终端输入失败：${e?.message || String(e)}`)
    return false
  }
}

/**
 * 把终端量出来的列×行同步给伪控制台（否则折行位置不一致）。
 * false = 没有可调的控制台 / 已结束；同尺寸重复上报由 Rust 侧去重。
 */
export async function resizeUserTerminal(
  sessionId: string,
  id: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('cmd_terminal_resize', {
      sessionId,
      id,
      cols,
      rows,
    })
  } catch {
    return false
  }
}

/**
 * 关掉一个终端：终止整棵进程树并把它摘出注册表（幂等）。
 * 返回 false = 本会话已经没有这个 id（例如已经关过一次）。
 */
export async function killUserTerminal(
  sessionId: string,
  id: string,
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('cmd_terminal_kill', { sessionId, id })
  } catch (e: any) {
    // 关标签时的清理失败了也不该弹错：Job 的 KILL_ON_JOB_CLOSE 会兜底
    console.warn(`[terminal] 关闭终端失败：${e?.message || String(e)}`)
    return false
  }
}
