/**
 * 代码执行公共函数（execute_command / execute_script 共用）：平台探测、命令解析与风险分类、
 * 审批注册表、终端输出处理、执行核心 runCommand。
 */
import { invoke, Channel } from '@tauri-apps/api/core'
import { Command, Child } from '@tauri-apps/plugin-shell'

import { t, tpl } from '@/ui/i18n'
import { settingsState } from '@/ui/store'
import { v4 } from '@/utils/uuid'
import toolInteractEvent from '@/events/toolInteractEvent'
import {
  ToolError,
  type ToolContext,
  type ToolExecutorResponse,
  type ToolResult,
} from '@/domain/tools/types'
import { getSkillsDirPath } from '@/skill/skillStore'
import { toolOutputStore } from '../output-store'

// 1. 平台探测

/** 平台探测：权威源是 Rust os_platform，UA 仅作未就绪时的兜底，结果缓存。 */

/** UA 启发式兜底（WebView 可改 UA，仅临时用）。 */
function platformFromUA(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  return 'linux'
}

/** 缓存的平台字符串，来自 Rust os_platform（权威来源）。 */
let _platform: string | undefined

/** 权威平台探测（os_platform），失败退 UA；进程内只解析一次。 */
export async function detectPlatform(): Promise<string> {
  if (_platform) return _platform
  try {
    _platform = await invoke<string>('os_platform')
  } catch {
    _platform = platformFromUA()
  }
  return _platform
}

/** 同步快照：优先权威缓存，未就绪时用 UA。 */
export function platformSnapshot(): string {
  return _platform || platformFromUA()
}

// 立即预热，让首轮 listDefinitions() 就能拿到 os_platform
void detectPlatform()

// 2. 命令解析与风险分类

/** 引号感知：取命令段第一个 token（引号内的空白与分隔符不参与切分）。 */
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

/** 取命令名：第一个 token，去路径 / 扩展名 / 引号，小写。 */
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

/** 按分隔符切分命令，引号内的分隔符不生效（`echo "a;b"` 不会被切开）。 */
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

/** 剥掉 cmd /c、powershell -Command 等套壳，递归上限 5 层。 */
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

/** 提取被 && / || / ; 分隔的所有命令名（去重，引号内不切）。 */
export function extractAllCommandNames(raw: string): string[] {
  const segments = splitCommandRespectingQuotes(raw, ['&&', '||', ';'])
  const names = new Set<string>()
  for (const seg of segments) {
    const name = extractCommandName(seg)
    if (name) names.add(name)
  }
  return [...names]
}

/** 风险分类：任一条子命令命中 dangerous 即 dangerous，其次 install，否则 safe。 */
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

  // 优先查 dangerous：只要有一条子命令危险，整条就是高危
  for (const c of cmds) {
    if (dangerous.has(c)) return 'dangerous'
  }
  // 再查 install
  for (const c of cmds) {
    if (installers.has(c)) return 'install'
  }
  return 'safe'
}

// 3. 风险提示文案

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

/**
 * 申请绕过沙盒（`sandbox:"off"`）时追加到审批弹窗的警告（命令 / 脚本共用；中文即 i18n key）。
 * ⚠️ 与 Rust `classify.rs::SANDBOX_BYPASS_HINT` 逐字一致（铁律 1）。
 */
export const SANDBOX_BYPASS_HINT =
  '⚠️ 该命令申请「不使用沙盒」执行：不受写隔离与受限令牌限制，可写入任意路径。' +
  '仅当该命令确实需要管道 stdio（如 vitest / vite / jest / node-gyp）时允许。'

/**
 * 命中「忽略沙盒命令」规则的警告。与告上一条的区别：不是 AI 申请的，而是用户的规则把命令改成无沙盒。
 * 与 Rust rules.rs::with_rule_hint 逐字一致。
 */
export const SANDBOX_RULE_BYPASS_HINT =
  '⚠️ 该命令命中「忽略沙盒命令」规则「$__rule__」，将以「不使用沙盒」方式执行：' +
  '不受写隔离与受限令牌限制，可写入任意路径。'

// 4. 命令审批注册表

/** 命令审批注册表：按 approvalId 精确分发（全局 once 监听会被不匹配的事件消费掉）。 */

/** 一次待审批的命令 */
export interface PendingApproval {
  sessionId: string
  toolCallId: string
  run: () => Promise<ToolExecutorResponse>
}

const pendingApprovals = new Map<string, PendingApproval>()
let listenerInstalled = false

/** 注册待审批命令，返回 approvalId；确认后由 userAllowCmd 触发执行。 */
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

// 5. 终端输出处理

/**
 * 终端输出解析器（**有状态**）：喂的是「累积输出」，只解析上次之后新增的那一段。
 *
 * 为什么需要：运行中的命令每 50ms 通知一次 UI（`output-store.ts` 的 `NOTIFY_INTERVAL_MS`），
 * 而 `output` 是整段累积串。以前每次都从头跑一遍逐字符状态机 —— 一轮大输出（几 MB）就是 O(n²)，
 * CPU 全耗在重解析已经解析过的内容上（还会把主线程卡住）。
 *
 * 两条不变量：
 * 1. **只前进**：`raw` 单调增长，变短视为换了一条流（重置）；同一份内容重复喂是幂等的；
 * 2. **半截转义序列留到下一块**：`"\x1b["` 可能被切在两个 chunk 之间，当正文吐出去就是乱码。
 *
 * 单次结果与 Rust `common.rs::process_terminal_output` 逐条对齐（回归用例见
 * `tests/infrastructure/terminal-output.test.ts`）。
 */
export class TerminalOutputParser {
  /**
   * 行缓冲区。⚠️ **不裁剪尾部空行**：裁剪会让 `\x1b[B` 的边界判定与全量解析不一致
   *（空行也是光标可停的可写位置）；只在 `text()` 输出时跳过尾部空行。
   */
  private buffer: string[] = ['']
  /** 当前行（从 0 开始） */
  private row = 0
  /** 当前列 */
  private col = 0
  /** 已经吃进解析器的原始长度 */
  private rawLen = 0
  /** 上一块末尾没解析完的转义序列（已计入 rawLen） */
  private carry = ''
  private cache: string | null = null

  /** 喂入**累积**输出，返回当前的纯文本视图 */
  feed(raw: string): string {
    // 空 / null（旧实现 `if (!raw) return ''`，调用方可能传 undefined）
    if (!raw) {
      this.reset()
      return ''
    }
    if (raw.length < this.rawLen) this.reset()
    // React StrictMode / 重复渲染会把同一份内容喂两次：必须是幂等的
    if (raw.length === this.rawLen) return this.text()
    const chunk = this.carry + raw.slice(this.rawLen)
    this.rawLen = raw.length
    this.carry = this.scan(chunk)
    this.cache = null
    return this.text()
  }

  /** 当前解析结果（移除尾部空行，保留至少一行） */
  text(): string {
    if (this.cache !== null) return this.cache
    let end = this.buffer.length
    while (end > 1 && this.buffer[end - 1] === '') end--
    this.cache = this.buffer.slice(0, end).join('\n')
    return this.cache
  }

  private reset(): void {
    this.buffer = ['']
    this.row = 0
    this.col = 0
    this.rawLen = 0
    this.carry = ''
    this.cache = null
  }

  /** 解析一块；返回末尾那段**尚未完成**的转义序列（没有则空串） */
  private scan(chunk: string): string {
    const n = chunk.length
    const buffer = this.buffer
    let row = this.row
    let col = this.col
    let i = 0
    try {
      while (i < n) {
        const ch = chunk[i]

        if (ch === '\r') {
          // 回车：回到行首
          col = 0
          i++
        } else if (ch === '\n') {
          // 换行：移动到下一行
          row++
          col = 0
          if (row >= buffer.length) buffer.push('')
          i++
        } else if (ch === '\x1b') {
          // ---- ANSI 转义序列：必须完整吞掉，否则参数会被当成正文写进输出 ----
          if (i + 1 >= n) return chunk.slice(i)
          const kind = chunk[i + 1]
          if (kind === '[') {
            // CSI: ESC [ 0x30-0x3F(参数) 0x20-0x2F(中间) 0x40-0x7E(结束)
            let j = i + 2
            let params = ''
            while (j < n && /[0-9;:<=>?]/.test(chunk[j])) {
              params += chunk[j]
              j++
            }
            if (j >= n) return chunk.slice(i)
            // 中间字节（空格、!、"、#、$、%、&、'、*、+、-、.、/）不属于参数，跳过
            while (j < n && chunk[j] >= ' ' && chunk[j] <= '/') j++
            if (j >= n) return chunk.slice(i)
            const cmd = chunk[j]
            i = j + 1
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
            let closed = false
            while (j < n) {
              if (chunk[j] === '\x07') {
                j++
                closed = true
                break
              }
              if (chunk[j] === '\x1b' && chunk[j + 1] === '\\') {
                j += 2
                closed = true
                break
              }
              j++
            }
            if (!closed) return chunk.slice(i)
            i = Math.min(j, n)
          } else if (kind >= ' ' && kind <= '/') {
            // 带中间字节的**三字节**转义（ESC ( 0 切字符集 / ESC # 8 等）
            if (i + 3 > n) return chunk.slice(i)
            i += 3
          } else {
            // 两字符转义（ESC 7 保存光标 / ESC = 等）
            i += 2
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
          while (row >= buffer.length) buffer.push('')
          const line = buffer[row]
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
      return ''
    } finally {
      this.row = row
      this.col = col
    }
  }
}

/**
 * 把终端输出中的 \r 覆盖、光标移动与清屏序列解释成纯文本（一次性版本）。
 * 必须完整吞掉转义序列（旧实现只吃 `0-9;`，`\x1b[?25l` 会漏出 "25l"）。
 * 流式场景请用 `TerminalOutputParser`：这个函数每次都从头解析。
 */
export function processTerminalOutput(raw: string): string {
  return new TerminalOutputParser().feed(raw)
}

// 6. 命令执行核心

/**
 * 跨平台进程树杀手（走 Rust kill_process_tree，用 OS 原生 kill 语义，无需 shell 权限）；失败回退 child.kill()。
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
 * 原生执行入口：把命令下沉到 Rust（沙盒 + ConPTY），与 Rust 引擎路径共用同一套语义。
 * 输出经 ipc::Channel 流式回传。非 Tauri / 非 Windows 返 null，由调用方回落 plugin-shell。
 */
async function tryRunCommandNativePty(
  cmdStr: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
  toolName: string,
  skillsDir: string,
  bypassSandbox: boolean,
  bypassByRule: boolean,
): Promise<ToolResult | null> {
  // 仅 Windows 桌面端有 ConPTY
  if (platformSnapshot() !== 'windows' || !isTauriEnv()) return null

  const { toolCallId, sessionId, abortSignal } = ctx

  // 流式输出 → toolOutputStore（与 Rust 引擎路径的 agent:tool-output 监听等价）
  const channel = new Channel<{ chunk?: string; sandbox?: string }>()
  channel.onmessage = (payload) => {
    // `agent:tool-env`：命令开始执行时下发的实际沙盒模式（运行中徽标）
    if (payload?.sandbox) {
      toolOutputStore.setSandbox(toolCallId, payload.sandbox)
      return
    }
    const chunk = payload?.chunk ?? ''
    if (chunk) toolOutputStore.append(toolCallId, chunk)
  }

  const kill = () => {
    invoke('agent_kill_command', { toolCallId }).catch(() => {})
  }
  // register 会替换同 id 的 entry（清掉先前 ctx.write 写的「> cmd」表头），与 Rust 路径观感一致
  toolOutputStore.register(toolCallId, {
    toolName,
    output: '',
    pty: true,
    kill,
  })

  const onAbort = () => kill()
  abortSignal?.addEventListener('abort', onAbort)

  try {
    const res = await invoke<{
      content: string
      uiData?: Record<string, any>
      isError?: boolean
    }>(
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
        bypassByRule,
        onOutput: channel,
      },
    )
    // Rust 侧成功与工具级失败都回 Ok，用 isError 区分（Tauri 的 Err 只能传字符串，结构会丢）
    if (res.isError) {
      throw new CmdError(res.content, res.uiData)
    }
    return { content: res.content, uiData: res.uiData }
  } catch (e: any) {
    if (e instanceof CmdError) throw e
    // 真正的调用级异常（如沙盒只读拒绝）：没有结构化信息
    throw new CmdError(typeof e === 'string' ? e : (e?.message ?? String(e)))
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 执行一条 shell 命令。Windows 用 Windows PowerShell 5.1，macOS 用 zsh，Linux 用 sh。
 */
export async function runCommand(
  cmdStr: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
  toolName: string = 'execute_command',
  opts?: { bypassSandbox?: boolean; bypassByRule?: boolean },
): Promise<ToolResult> {
  const platform = await detectPlatform()
  const isWin = platform === 'windows'
  const isLinux = platform === 'linux'

  // SKILL_ROOT 进程级只读保护
  const skillsDir = await getSkillsDirPath()

  // 首选 Rust 原生执行；不可用返回 null → 走下方 plugin-shell 管道
  const native = await tryRunCommandNativePty(
    cmdStr,
    cwd,
    timeoutMs,
    ctx,
    toolName,
    skillsDir,
    opts?.bypassSandbox ?? false,
    opts?.bypassByRule ?? false,
  )
  if (native) return native

  // 选择 shell（平台自适应）
  let shellName: string
  let shellArgs: string[]

  if (isWin) {
    // 统一走 powershell.exe；先切 UTF-8，否则中文系统 GBK 会乱码（与 Rust 路径对齐）
    shellName = 'powershell'
    shellArgs = [
      '-NoProfile',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmdStr}`,
    ]
  } else if (platform === 'macos') {
    // Catalina+ 默认 zsh（/bin/sh 是 bash POSIX 模式，行为有差异）
    shellName = 'zsh'
    shellArgs = ['-c', cmdStr]
  } else if (isLinux) {
    // 优先 unshare -mr 建独立 mount namespace，把技能目录 bind 成只读；不可用时静默降级为普通 sh
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
    // 注入编码环境变量，避免 Windows GBK 管道输出 UTF-8 字符（emoji）乱码
    const extraEnv: Record<string, string> = {
      SKILL_ROOT: skillsDir,
      PYTHONIOENCODING: 'utf-8',
    }
    const cmd = Command.create(shellName, shellArgs, {
      cwd,
      env: extraEnv,
    })
    /** exitCode 为 null 表示被信号终止，UI 按失败渲染。 */
    const output: {
      stdout: string
      stderr: string
      exitCode: number | null
    } = { stdout: '', stderr: '', exitCode: 0 }

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
        // 必须先等 kill 真正执行完（Rust 递归枚举后代），再等 close ——
        // 发完信号立刻 resolve 会让工具说「已终止」而子进程还活着
        try {
          await killProcessTree(shellName, child)
        } catch {
          // ignore — settle 由 close/兜底定时器接管
        }
        // 进程树没杀干净时最多再等 5s，避免工具卡死
        const closeTimer = setTimeout(() => settle(null), 5000)
        cmd.on(
          'close',
          (payload: { code: number | null; signal: number | null }) => {
            clearTimeout(closeTimer)
            settle(payload.code)
          },
        )
      }, timeoutMs)

      // abortSignal 已 aborted 时进程已在上面被杀，close 事件照常 settle
      cmd.on(
        'close',
        (payload: { code: number | null; signal: number | null }) => {
          settle(payload.code)
        },
      )
    })
    output.exitCode = exitCode

    // 以下 5 条是模型侧文案：固定英文，与 Rust runner 逐字对齐，不进 i18n
    let result = ''
    if (killedByUser) {
      result += 'Command cancelled by the user\n'
    } else if (killedByTimeout) {
      result += `Command timed out after ${(timeoutMs / 1000).toFixed(
        3,
      )}s and was terminated\n`
    } else {
      // 被信号终止时没有退出码
      result += `Exit code: ${exitCode ?? 'null'}\n`
    }
    if (output.stdout) result += processTerminalOutput(output.stdout)
    if (output.stdout && output.stderr) result += '\n'
    if (output.stderr)
      result += '[stderr]\n' + processTerminalOutput(output.stderr)

    const MAX = 32000
    const out =
      result.length > MAX
        ? result.slice(0, MAX) +
          `...(truncated, ${result.length} characters total)`
        : result

    if (exitCode != null && exitCode >= 2) {
      // 失败也带结构化 uiData，UI 才能按界面语言重建
      throw new CmdError(out, { ...output })
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

/**
 * 命令以 >= 2 的退出码结束时抛出，区别于「执行器异常」。继承 ToolError 以携带 uiData，
 * 让 UI 按界面语言重建而不是直贴英文报告。
 */
export class CmdError extends ToolError {
  constructor(message: string, uiData?: Record<string, any>) {
    super(message, uiData)
    this.name = 'CmdError'
  }
}
