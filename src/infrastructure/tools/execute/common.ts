/**
 * execute — 代码执行分类公共函数（分类 id: execute）
 *
 * 供 execute_command / execute_script 复用，按职责分五节：
 *   1. 平台探测        — Rust `os_platform` 权威值 + UA 兜底（进程内缓存）
 *   2. 命令解析与风险分类 — 引号感知切分、cmd/powershell 套壳剥离、safe/install/dangerous
 *   3. 风险提示文案     — getRiskInfo
 *   4. 命令审批注册表   — approvalId 精确分发（多命令并发待确认时不会互相消费事件）
 *   5. 终端输出处理     — \r 回车覆盖 / ANSI 光标移动 → 纯文本
 *   6. 命令执行核心     — runCommand（spawn + 超时/取消杀进程树 + 输出截断）
 */
import { invoke, Channel } from '@tauri-apps/api/core'
import { Command, Child } from '@tauri-apps/plugin-shell'

import { t, tpl } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import { v4 } from '@/utils/uuid'
import toolInteractEvent from '@/events/toolInteractEvent'
import type {
  ToolContext,
  ToolExecutorResponse,
  ToolResult,
} from '@/domain/tools/types'
import { getSkillsDirPath } from '@/skill/skillStore'
import { toolOutputStore } from '../output-store'

// ══════════════════════════════════════════════════════════════════
// 1. 平台探测
// ══════════════════════════════════════════════════════════════════

/**
 * ===== 平台探测（权威来源优先）=====
 * 主来源：Rust os_platform（std::env::consts::OS）。
 * UA 只是兜底：仅当 os_platform 尚未解析完成时才临时使用。
 * 权威值缓存进 _platform 后，描述与执行路径统一读同一缓存，不再依赖两套探测。
 */

/** UA 启发式兜底（navigator.userAgent 可被 WebView 覆盖，仅作临时兜底）。 */
function platformFromUA(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  return 'linux'
}

/** 缓存的平台字符串，来自 Rust os_platform（权威来源）。 */
let _platform: string | undefined

/** 权威平台探测（os_platform），失败时 UA 兜底；结果缓存，同一进程只解析一次。 */
export async function detectPlatform(): Promise<string> {
  if (_platform) return _platform
  try {
    _platform = await invoke<string>('os_platform')
  } catch {
    _platform = platformFromUA()
  }
  return _platform
}

/** 描述惰性求值用的同步快照：优先权威缓存，os_platform 未就绪时用 UA 兜底。 */
export function platformSnapshot(): string {
  return _platform || platformFromUA()
}

// 模块加载后立即预热权威平台，让首轮 listDefinitions() 生成描述时即可拿到 os_platform 结果
void detectPlatform()

// ══════════════════════════════════════════════════════════════════
// 2. 命令解析与风险分类
// ══════════════════════════════════════════════════════════════════

/**
 * 引号感知：提取命令段第一个 token。
 * 单引号/双引号内的空白和分隔符不参与切分（如 "C:\Program Files\app.exe" 视为一个整体）。
 */
function extractFirstToken(raw: string): string {
  let token = ''
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (quote) {
      token += ch
      // 双引号内支持 \" 转义（单引号内无反斜杠转义）
      if (quote === '"' && ch === '\\' && i + 1 < raw.length) {
        token += raw[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      token += ch
      i++
      continue
    }
    if (/[\s|&;<>()]/.test(ch)) break
    token += ch
    i++
  }
  return token
}

/**
 * 提取命令名（第一个 token，去路径/扩展名/引号）
 */
export function extractCommandName(raw: string): string {
  const trimmed = raw.trimStart()
  const firstToken = extractFirstToken(trimmed)
  return firstToken
    .replace(/^['"]/, '')
    .replace(/['"]$/, '') // 剥掉尾引号（与 Rust 侧对齐）
    .replace(/^\.\//, '')
    .replace(/^.*[/\\]/, '') // 去掉路径前缀
    .toLowerCase()
    .replace(/\.(exe|bat|cmd|ps1|sh)$/, '') // 去扩展名
}

/**
 * 引号感知：按分隔符切分 shell 命令，引号内的分隔符不生效。
 * 例如 `echo "a;b"` 不会被 `;` 切开，`echo 'a&&b'` 不会被 `&&` 切开。
 */
function splitCommandRespectingQuotes(
  cmd: string,
  separators: string[],
): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (quote) {
      current += ch
      // 双引号内支持 \" 转义（单引号内无反斜杠转义）
      if (quote === '"' && ch === '\\' && i + 1 < cmd.length) {
        current += cmd[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      i++
      continue
    }
    let matched = false
    for (const sep of separators) {
      if (cmd.startsWith(sep, i)) {
        parts.push(current)
        current = ''
        i += sep.length
        matched = true
        break
      }
    }
    if (matched) continue
    current += ch
    i++
  }
  parts.push(current)
  return parts
}

/**
 * 剥掉外层 cmd /c "..." 、powershell -Command "..." 等包装，提取真正要跑的命令。
 * 递归剥壳，防止多次套壳（如 cmd /c "powershell -Command \"npm install\""），最大递归深度 5。
 */
function unwrapShellWrapper(cmdStr: string, depth: number = 5): string {
  if (depth <= 0) return cmdStr
  // cmd /c "..." 或 cmd /c ...
  let m = cmdStr.match(/^(?:cmd\.exe|cmd)\s+\/c\s+"?([^"]+)"?$/i)
  if (m) return unwrapShellWrapper(m[1], depth - 1)
  // powershell -Command "..." 或 pwsh -Command ...
  m = cmdStr.match(/^(?:powershell|pwsh)(?:\.exe)?\s+-Command\s+"?([^"]+)"?$/i)
  if (m) return unwrapShellWrapper(m[1], depth - 1)
  // sh -c "..."
  m = cmdStr.match(/^(?:sh|bash|zsh|dash)\s+-c\s+"?([^"]+)"?$/i)
  if (m) return unwrapShellWrapper(m[1], depth - 1)
  return cmdStr
}

/**
 * 提取命令中所有被 &&、||、; 分隔的命令名（去重）
 * ⚠️ 引号内的分隔符不切分（如 `echo "a;b"` 不会把 `b` 当命令名）
 */
export function extractAllCommandNames(raw: string): string[] {
  const segments = splitCommandRespectingQuotes(raw, ['&&', '||', ';'])
  const names = new Set<string>()
  for (const seg of segments) {
    const name = extractCommandName(seg)
    if (name) names.add(name)
  }
  return [...names]
}

/**
 * 命令风险分类
 */
export function classifyCommand(
  cmdStr: string,
): 'safe' | 'install' | 'dangerous' {
  const inner = unwrapShellWrapper(cmdStr)
  const cmds = extractAllCommandNames(inner)

  const dangerous = new Set([
    'rm',
    'del',
    'erase',
    'rd',
    'rmdir',
    'format',
    'diskpart',
    'fdisk',
    'mkfs',
    'shutdown',
    'reboot',
    'restart',
    'halt',
    'poweroff',
    'sudo',
    'su',
    'runas',
    'chmod',
    'chown',
    'attrib',
    'cacls',
    'icacls',
    'reg',
    'regedit',
    'taskkill',
    'kill',
    'pkill',
    'tskill',
    'mount',
    'umount',
    'msiexec',
    'mshta',
    'sc',
    'net',
    'bcdedit',
    'bootrec',
    'vssadmin',
    'wevtutil',
    'cipher',
    'takeown',
    'remove-item',
  ])

  const installers = new Set([
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'pip',
    'pip3',
    'poetry',
    'conda',
    'cargo',
    'go',
    'gem',
    'nuget',
    'dotnet',
    'brew',
    'port',
    'apt',
    'apt-get',
    'dpkg',
    'yum',
    'dnf',
    'rpm',
    'pacman',
    'choco',
    'scoop',
    'winget',
    'composer',
    'docker',
    'docker-compose',
    'podman',
    'npx',
  ])

  // 优先检查 dangerous：只要有一条子命令是危险的，整条命令就标为高危
  for (const c of cmds) {
    if (dangerous.has(c)) return 'dangerous'
  }
  // 再检查 install：只要有一条是安装命令，就标为安装命令
  for (const c of cmds) {
    if (installers.has(c)) return 'install'
  }
  return 'safe'
}

// ══════════════════════════════════════════════════════════════════
// 3. 风险提示文案
// ══════════════════════════════════════════════════════════════════

/** 风险等级对应的用户提示 */
const RISK_LABELS: Record<string, { label: string; hint: string }> = {
  dangerous: {
    label: '高危命令',
    hint: '此命令可能对系统造成破坏，请确认是否执行',
  },
  install: {
    label: '安装命令',
    hint: '此命令会修改系统环境或下载外部代码，请确认是否执行',
  },
}

/** 获取翻译后的风险标签 */
export function getRiskInfo(risk: string): { label: string; hint: string } {
  const info = RISK_LABELS[risk]
  if (!info) return { label: t('执行命令'), hint: '' }
  return {
    label: t(info.label),
    hint: t(info.hint),
  }
}

// ══════════════════════════════════════════════════════════════════
// 4. 命令审批注册表
// ══════════════════════════════════════════════════════════════════

/**
 * 命令审批注册表 — 负责工具与 command_confirm 交互层之间的审批协调。
 *
 * 按 approvalId 精确匹配，避免旧实现（全局 once 监听）在多个命令同时待确认时
 * 被第一个事件（即使不匹配）消费掉的问题。
 */

/** 一次待审批的命令 */
export interface PendingApproval {
  sessionId: string
  toolCallId: string
  run: () => Promise<ToolExecutorResponse>
}

const pendingApprovals = new Map<string, PendingApproval>()
let listenerInstalled = false

/**
 * 注册一次待审批命令，返回唯一 approvalId。
 * 用户确认后，command_confirm 侧 emit userAllowCmd(approvalId, ...) 触发执行；
 * 用户拒绝后，emit userCmdRejected(approvalId, ...) 清理注册表。
 */
export function registerPendingApproval(entry: PendingApproval): string {
  installListener()
  const approvalId = v4()
  pendingApprovals.set(approvalId, entry)
  return approvalId
}

/** 安装常驻审批监听器（只安装一次，按 approvalId 精确分发） */
function installListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true

  toolInteractEvent.on(
    'userAllowCmd',
    (approvalId, sessionId, toolCallId, callback) => {
      const entry = pendingApprovals.get(approvalId)
      if (!entry) return
      if (entry.sessionId !== sessionId || entry.toolCallId !== toolCallId) {
        return
      }
      pendingApprovals.delete(approvalId)
      callback.result = entry.run()
    },
  )

  // 用户拒绝 → 清理注册表，避免内存泄漏
  toolInteractEvent.on(
    'userCmdRejected',
    (approvalId, sessionId, toolCallId) => {
      const entry = pendingApprovals.get(approvalId)
      if (
        entry &&
        entry.sessionId === sessionId &&
        entry.toolCallId === toolCallId
      ) {
        pendingApprovals.delete(approvalId)
      }
    },
  )
}

// ══════════════════════════════════════════════════════════════════
// 5. 终端输出处理
// ══════════════════════════════════════════════════════════════════

/**
 * 处理终端输出中的 \r（回车覆盖）和光标移动转义序列，
 * 返回处理后的纯文本（不包含颜色/样式 ANSI 码）。
 *
 * 用行缓冲区模拟虚拟终端：
 * - \r        → 回到当前行首，后续字符覆盖
 * - \n        → 换行（光标移到下一行行首）
 * - \b        → 光标左移一格（退格）
 * - \x1b[nA   → 光标上移 n 行
 * - \x1b[nB   → 光标下移 n 行
 * - \x1b[nC   → 光标右移 n 列
 * - \x1b[nD   → 光标左移 n 列
 * - \x1b[nK   → 清除从光标到行尾
 * - \x1b[nJ   → 清屏（2/3 为全屏）
 * - \x1b[r;cH/f → 光标定位
 * - \x1b[?25l / \x1b[?25h → 私有模式（DECSET/DECRST），整条忽略但必须吞完
 * - \x1b]... BEL/ST → OSC（如改窗口标题），整条忽略
 * - 其他 \x1b[... 序列（颜色、样式、ECH 擦除字符等）→ 忽略
 *
 * ⚠️ 必须**完整**吞掉转义序列：旧实现只认 `ESC [` 且只吃 0-9;，
 * `\x1b[?25l` 会把 "25l" 漏成正文 —— 而 PTY（ConPTY）路径下这类序列极其密集。
 * 本函数与 Rust 侧 `native_tools/execute/common.rs::process_terminal_output`
 * **逐条对齐**（铁律 1：双引擎语义同步），改一边必须同步改另一边。
 */
export function processTerminalOutput(raw: string): string {
  if (!raw) return ''

  // 行缓冲区
  const buffer: string[] = ['']
  let row = 0 // 当前行（从 0 开始）
  let col = 0 // 当前列

  let i = 0
  while (i < raw.length) {
    const ch = raw[i]

    if (ch === '\r') {
      // 回车：回到行首
      col = 0
      i++
    } else if (ch === '\n') {
      // 换行：移动到下一行
      row++
      col = 0
      if (row >= buffer.length) {
        buffer.push('')
      }
      i++
    } else if (ch === '\x1b' && i + 1 < raw.length) {
      // ---- ANSI 转义序列：必须完整吞掉，否则参数会被当成正文写进输出 ----
      // （旧实现只认 `ESC [` 且只吃 0-9;，`\x1b[?25l` 这类私有模式会把 "25l" 漏成正文）
      const kind = raw[i + 1]
      if (kind === '[') {
        // CSI: ESC [ 0x30-0x3F(参数) 0x20-0x2F(中间) 0x40-0x7E(结束)
        let j = i + 2
        let params = ''
        while (j < raw.length && /[0-9;:<=>?]/.test(raw[j])) {
          params += raw[j]
          j++
        }
        // 中间字节（空格、!、"、#、$、%、&、'、*、+、-、.、/）不属于参数，跳过
        while (j < raw.length && raw[j] >= ' ' && raw[j] <= '/') {
          j++
        }
        const cmd = j < raw.length ? raw[j] : ' '
        i = Math.min(j + 1, raw.length) // 跳过命令字符
        // 带 ? < = > 前缀的是私有模式 → 整体忽略（但已完整吞掉）
        const privateMode = /^[?<=>]/.test(params)
        const numStr = params.replace(/^[?<=>]+/, '')
        const num = parseInt(numStr, 10) || 1
        if (!privateMode) {
          switch (cmd) {
            case 'A': // 光标上移
              row = Math.max(0, row - num)
              break
            case 'B': // 光标下移
              row = Math.min(buffer.length - 1, row + num)
              break
            case 'C': // 光标右移
              col += num
              break
            case 'D': // 光标左移
              col = Math.max(0, col - num)
              break
            case 'K': {
              // 清除从光标到行尾
              while (row >= buffer.length) buffer.push('')
              const line = buffer[row] ?? ''
              buffer[row] = line.substring(0, col)
              break
            }
            case 'J': {
              // 清除屏幕：0 = 光标到屏幕尾, 1 = 屏幕头到光标, 2/3 = 全屏
              const mode = numStr ? parseInt(numStr, 10) : 0
              if (mode === 2 || mode === 3) {
                buffer.length = 0
                buffer.push('')
                row = 0
                col = 0
              }
              break
            }
            case 'H': // 光标定位: \x1b[row;colH
            case 'f': {
              const parts = numStr.split(';')
              const r = parseInt(parts[0], 10) || 1
              const c = parseInt(parts[1], 10) || 1
              row = r - 1
              col = c - 1
              break
            }
            default:
              // 颜色 / 样式 / ECH 擦除字符等：对纯文本无影响，忽略
              break
          }
        }
      } else if (kind === ']') {
        // OSC: ESC ] ... 由 BEL 或 ST(ESC \) 结束（典型是 `\x1b]0;标题\x07`）
        let j = i + 2
        while (j < raw.length) {
          if (raw[j] === '\x07') {
            j++
            break
          }
          if (raw[j] === '\x1b' && raw[j + 1] === '\\') {
            j += 2
            break
          }
          j++
        }
        i = Math.min(j, raw.length)
      } else if (kind >= ' ' && kind <= '/') {
        // 带中间字节的**三字节**转义（ESC ( 0 切字符集 / ESC # 8 等）
        i = Math.min(i + 3, raw.length)
      } else {
        // 两字符转义（ESC 7 保存光标 / ESC = 等）
        i = Math.min(i + 2, raw.length)
      }
    } else if (ch === '\b') {
      // 退格：光标左移一格
      col = Math.max(0, col - 1)
      i++
    } else if (ch === '\t') {
      // Tab → 补到下一个 8 列边界
      const tabStop = 8
      const nextCol = Math.ceil((col + 1) / tabStop) * tabStop
      while (row >= buffer.length) buffer.push('')
      let line = buffer[row]
      while (col < nextCol) {
        if (col >= line.length) {
          line += ' '
        }
        col++
      }
      buffer[row] = line
      i++
    } else if (ch >= ' ') {
      // 可打印字符：写入缓冲区
      while (row >= buffer.length) {
        buffer.push('')
      }
      let line = buffer[row]
      if (col >= line.length) {
        // 追加到行尾
        buffer[row] = line + ch
      } else {
        // 覆盖当前位置
        buffer[row] = line.substring(0, col) + ch + line.substring(col + 1)
      }
      col++
      i++
    } else {
      // 不可见控制字符（如 \x00-\x1f 中未处理的）→ 跳过
      i++
    }
  }

  // 移除尾部空行（保留至少一行）
  while (buffer.length > 1 && buffer[buffer.length - 1] === '') {
    buffer.pop()
  }
  return buffer.join('\n')
}

// ══════════════════════════════════════════════════════════════════
// 6. 命令执行核心
// ══════════════════════════════════════════════════════════════════

/**
 * Cross-platform process tree killer via Rust `kill_process_tree` command.
 * Uses OS-native kill semantics from the Rust side (no shell permission needed).
 */
async function killProcessTree(
  _shellName: string,
  child: Child,
): Promise<void> {
  try {
    await invoke('kill_process_tree', { pid: child.pid })
  } catch (e) {
    console.warn('kill_process_tree failed, falling back to child.kill():', e)
    await child.kill()
  }
}

/** 是否运行在 Tauri（桌面）环境 —— 浏览器 dev 里没有 Rust 侧，也就没有原生执行。 */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * TS 引擎路径的「原生执行」入口 —— 把执行下沉到 Rust（沙盒 + ConPTY）。
 *
 * 背景：TS 引擎路径的 `execute_command` 原先走 `plugin-shell` 匿名管道：无沙盒、
 * 无 ANSI 解析、无交互（见 docs/pty-research.md §7 #14）。这里改走 Rust 的
 * `pty_run_command`，与 Rust 引擎路径**共用同一套执行语义**（铁律 1）：
 *   - 沙盒优先（受限令牌 + ACL），失败才降级裸跑；
 *   - ConPTY → 输出是带光标控制的 VT 流，UI 走 xterm 渲染、用户可中途插键盘；
 *   - 超时 / 终止 / `waitReason` / 「等待输入」引导 均由 Rust 侧统一生成。
 *
 * 输出经 `on_output` **ipc::Channel** 流式回传（不经过引擎事件总线）：
 * 一步送到发起它的调用方，无需安装全局 `agent:tool-output` 监听。
 *
 * 不可用时（非 Tauri / 非 Windows）返回 `null`，由调用方回落到 plugin-shell 管道路径。
 */
async function tryRunCommandNativePty(
  cmdStr: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
  toolName: string,
  skillsDir: string,
  bypassSandbox: boolean,
): Promise<ToolResult | null> {
  // 仅 Windows 桌面端有 ConPTY；其他平台 / 浏览器 dev 继续走 plugin-shell。
  if (platformSnapshot() !== 'windows' || !isTauriEnv()) return null

  const { toolCallId, sessionId, abortSignal } = ctx

  // 流式输出 → toolOutputStore（与 Rust 引擎路径的 agent:tool-output 监听等价）
  const channel = new Channel<{ chunk?: string }>()
  channel.onmessage = (payload) => {
    const chunk = payload?.chunk ?? ''
    if (chunk) toolOutputStore.append(toolCallId, chunk)
  }

  const kill = () => {
    invoke('agent_kill_command', { toolCallId }).catch(() => {})
  }
  // 注册带 kill 的 entry；pty=true → 运行中即用 xterm 渲染。
  // ⚠️ register 会**替换**同 id 的 entry → 之前 `ctx.write` 写下的「> cmd」表头被清掉，
  //    与 Rust 引擎路径观感一致（终端块本就单独渲染 `$ cmd` 那一行）。
  toolOutputStore.register(toolCallId, {
    toolName,
    output: '',
    pty: true,
    kill,
  })

  const onAbort = () => kill()
  abortSignal?.addEventListener('abort', onAbort)

  try {
    const res = await invoke<{ content: string; uiData?: Record<string, any> }>(
      'pty_run_command',
      {
        sessionId,
        toolCallId,
        command: cmdStr,
        security: {
          workspace: cwd,
          sandboxMode: settingsState.value.sandboxMode ?? 'on',
          skillsDir,
        },
        timeoutSecs: Math.min(300, Math.max(1, Math.round(timeoutMs / 1000))),
        bypassSandbox,
        onOutput: channel,
      },
    )
    return { content: res.content, uiData: res.uiData }
  } catch (e: any) {
    // Rust 侧把「退出码 >= 2」等失败封成 Err（已格式化报告文本）→ CmdError，语义同管道路径
    throw new CmdError(typeof e === 'string' ? e : (e?.message ?? String(e)))
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 执行一条 shell 命令（execute_command / execute_script 共用）
 *
 * shell 选择策略：
 * - Windows: Windows PowerShell 5.1（powershell.exe，不再混用 cmd）
 * - macOS: zsh
 * - Linux: sh（可用时用 unshare -mr 把技能目录 bind 为只读）
 */
export async function runCommand(
  cmdStr: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
  toolName: string = 'execute_command',
  opts?: { bypassSandbox?: boolean },
): Promise<ToolResult> {
  const platform = await detectPlatform()
  const isWin = platform === 'windows'
  const isLinux = platform === 'linux'

  // ===== SKILL_ROOT 进程级只读保护 =====
  // 注入 SKILL_ROOT 环境变量
  const skillsDir = await getSkillsDirPath()

  // ===== 首选：Rust 原生执行（沙盒 + ConPTY），见 docs/pty-research.md §7 #14 =====
  // 不可用时返回 null → 继续下方 plugin-shell 管道路径（跨平台兜底）。
  const native = await tryRunCommandNativePty(
    cmdStr,
    cwd,
    timeoutMs,
    ctx,
    toolName,
    skillsDir,
    opts?.bypassSandbox ?? false,
  )
  if (native) return native

  // 选择 shell（平台自适应）
  let shellName: string
  let shellArgs: string[]

  if (isWin) {
    // Windows 统一走 Windows PowerShell 5.1（powershell.exe），不再混用 cmd。
    // 先切到 UTF-8 输出，避免中文系统默认 GBK 使管道输出乱码（与 Rust 原生路径对齐）。
    shellName = 'powershell'
    shellArgs = [
      '-NoProfile',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmdStr}`,
    ]
  } else if (platform === 'macos') {
    // macOS Catalina+ 默认 shell 为 zsh（/bin/sh 是 bash POSIX 模式，行为有差异）
    shellName = 'zsh'
    shellArgs = ['-c', cmdStr]
  } else if (isLinux) {
    // Linux: 优先使用 unshare -mr 创建独立 mount namespace
    // 将 skillsDir bind-mount 为只读保护技能目录不被篡改
    // 若 unshare 不可用（无 CAP_SYS_ADMIN 或内核未启用 user namespace），
    // 静默降级为普通 sh 执行
    shellName = 'sh'
    shellArgs = [
      '-c',
      `if command -v unshare >/dev/null 2>&1 && unshare -mr true 2>/dev/null; then
  exec unshare -mr sh -c "mount --bind '${skillsDir}' '${skillsDir}' && mount -o remount,ro,bind '${skillsDir}' && exec ${cmdStr}"
else
  ${cmdStr}
fi`,
    ]
  } else {
    shellName = 'sh'
    shellArgs = ['-c', cmdStr]
  }

  try {
    // 注入通用编码环境变量，解决 Windows cmd (GBK) 无法输出 UTF-8 字符（如 emoji）的问题
    const extraEnv: Record<string, string> = {
      SKILL_ROOT: skillsDir,
      PYTHONIOENCODING: 'utf-8',
    }
    const cmd = Command.create(shellName, shellArgs, {
      cwd,
      env: extraEnv,
    })
    const output = { stdout: '', stderr: '', exitCode: 0 }

    cmd.stdout.on('data', (data: string) => {
      output.stdout += data
      ctx.write(data)
    })
    cmd.stderr.on('data', (data: string) => {
      output.stderr += data
      ctx.write(`[stderr] ${data}`)
    })

    const child = await cmd.spawn()

    let killedByUser = false
    let killedByTimeout = false

    const doKill = async () => {
      killedByUser = true
      await killProcessTree(shellName, child)
    }

    toolOutputStore.register(ctx.toolCallId, {
      toolName,
      output: '',
      kill: () => void doKill(),
    })

    const onAbort = () => {
      killedByUser = true
      killProcessTree(shellName, child).catch(() => {})
    }
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

    const exitCode = await new Promise<number | null>((resolve) => {
      let settled = false
      const settle = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code)
      }

      const timer = setTimeout(async () => {
        killedByTimeout = true
        // ⚠️ 必须先等 kill 真正执行完（Rust 侧递归枚举后代逐个 taskkill），
        // 再等 close 事件（进程树确实退出）。不能发完信号立刻 resolve，
        // 否则工具返回「已终止」但 node/npm/python 等子进程还活着。
        try {
          await killProcessTree(shellName, child)
        } catch {
          // ignore — settle 由 close/兜底定时器接管
        }
        // 若进程树没被杀干净（极端情况），最多再等 5s 兜底返回，避免工具卡死
        const closeTimer = setTimeout(() => settle(null), 5000)
        cmd.on(
          'close',
          (payload: { code: number | null; signal: number | null }) => {
            clearTimeout(closeTimer)
            settle(payload.code)
          },
        )
      }, timeoutMs)

      // 如果 abortSignal 已经 aborted，上面的监听已经杀了进程
      // close 事件还是会触发，正常 resolve
      cmd.on(
        'close',
        (payload: { code: number | null; signal: number | null }) => {
          settle(payload.code)
        },
      )
    })
    output.exitCode = exitCode

    let result = ''
    if (killedByUser) {
      result += t('命令已被用户取消') + '\n'
    } else if (killedByTimeout) {
      result +=
        tpl('命令在 $__time__ 秒后超时并被终止', {
          time: (timeoutMs / 1000).toFixed(3),
        }) + '\n'
    } else {
      result += tpl('退出码: $__code__', { code: exitCode }) + '\n'
    }
    if (output.stdout) result += processTerminalOutput(output.stdout)
    if (output.stdout && output.stderr) result += '\n'
    if (output.stderr)
      result += t('[标准错误]') + '\n' + processTerminalOutput(output.stderr)

    const MAX = 32000
    const out =
      result.length > MAX
        ? result.slice(0, MAX) +
          tpl('...（已截断，共 $__count__ 字符）', { count: result.length })
        : result

    if (exitCode != null && exitCode >= 2) {
      throw new CmdError(out)
    }

    return {
      uiData: output,
      content: out,
    }
  } catch (e: any) {
    if (e instanceof CmdError) throw e
    const reason = e?.message || String(e)
    throw new Error(`[${shellName} error] ${reason}`)
  }
}

/** 命令以非 0/1 退出码结束（>= 2）时抛出，供工具层区分「命令失败」与「执行器异常」 */
export class CmdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CmdError'
  }
}
