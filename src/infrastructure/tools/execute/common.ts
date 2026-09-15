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
import { invoke } from '@tauri-apps/api/core'
import { Command, Child } from '@tauri-apps/plugin-shell'

import { t, tpl } from '@/ui/i18n'
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
 * - \x1b[nA   → 光标上移 n 行
 * - \x1b[nB   → 光标下移 n 行
 * - \x1b[nC   → 光标右移 n 列
 * - \x1b[nD   → 光标左移 n 列
 * - \x1b[K    → 清除从光标到行尾
 * - \x1b[2J   → 清屏
 * - 其他 \x1b[... 序列（如颜色码）→ 忽略
 * - \x1b[?25l / \x1b[?25h → 忽略
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
    } else if (ch === '\x1b' && raw[i + 1] === '[') {
      // ANSI CSI 序列: ESC [
      let j = i + 2

      // 提取数字参数（可能有多个，如 \x1b[2;3H）
      let numStr = ''
      while (j < raw.length && '0123456789;'.includes(raw[j])) {
        numStr += raw[j]
        j++
      }

      const cmd = raw[j]
      const num = parseInt(numStr, 10) || 1
      i = j + 1 // 跳过命令字符

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
          const line = buffer[row] ?? ''
          buffer[row] = line.substring(0, col)
          break
        }
        case 'J': {
          // 清除屏幕
          // 0 = 光标到屏幕尾, 1 = 屏幕头到光标, 2/3 = 全屏
          const mode = numStr ? parseInt(numStr, 10) : 0
          if (mode === 2 || mode === 3) {
            buffer.length = 0
            buffer.push('')
            row = 0
            col = 0
          }
          break
        }
        case 'H': {
          // 光标定位: \x1b[row;colH
          const parts = numStr.split(';')
          const r = parseInt(parts[0], 10) || 1
          const c = parseInt(parts[1], 10) || 1
          row = r - 1
          col = c - 1
          break
        }
        default:
          // 忽略其他 ANSI 码（颜色、样式、光标隐藏等）
          break
      }
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
): Promise<ToolResult> {
  const platform = await detectPlatform()
  const isWin = platform === 'windows'
  const isLinux = platform === 'linux'

  // ===== SKILL_ROOT 进程级只读保护 =====
  // 注入 SKILL_ROOT 环境变量
  const skillsDir = await getSkillsDirPath()

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
