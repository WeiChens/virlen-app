/**
 * execute_command — 执行一条 shell 命令，自动超时杀进程
 *
 * shell 选择策略：
 * - Windows: Windows PowerShell 5.1（powershell.exe，不再混用 cmd）
 * - macOS: zsh
 * - Linux: sh
 */

import { toolRegistry } from '@/domain/tools'
import {
  UserInteractionRequired,
  type ToolContext,
  type ToolExecutor,
  type ToolResult,
} from '@/domain/tools/types'
import { Command, Child } from '@tauri-apps/plugin-shell'
import { invoke } from '@tauri-apps/api/core'

import { t, tpl } from '@/ui/i18n'
import { getSkillsDirPath } from '@/skill/skillStore'
import { securityService } from '@/services/security-service'
import { registerPendingApproval } from './command-approval'
import { toolOutputStore } from '../output-store'
import { processTerminalOutput } from '../terminal-output'

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
function getRiskInfo(risk: string): { label: string; hint: string } {
  const info = RISK_LABELS[risk]
  if (!info) return { label: t('执行命令'), hint: '' }
  return {
    label: t(info.label),
    hint: t(info.hint),
  }
}

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
async function detectPlatform(): Promise<string> {
  if (_platform) return _platform
  try {
    _platform = await invoke<string>('os_platform')
  } catch {
    _platform = platformFromUA()
  }
  return _platform
}

/** 描述惰性求值用的同步快照：优先权威缓存，os_platform 未就绪时用 UA 兜底。 */
function platformSnapshot(): string {
  return _platform || platformFromUA()
}

// 模块加载后立即预热权威平台，让首轮 listDefinitions() 生成描述时即可拿到 os_platform 结果
void detectPlatform()

/** 沙盒模式通用说明（三平台共用尾部）。 */
const SANDBOX_NOTE =
  '结果首行是「终端环境」提示，报告沙盒模式——' +
  '「写隔离」（只能在 workspace/白名单可写根内写入，区外写入会被拒绝）、' +
  '「只读」（不可写）、或「无沙盒」（完整权限）。退出码 >= 2 表示命令执行失败。'

/** 平台特定的工具描述。 */
function buildToolDescription(platform: string): string {
  const prefix =
    platform === 'windows'
      ? '执行任意 shell 命令。当前终端是 Windows PowerShell 5.1（powershell.exe），请使用 PowerShell 语法（不是 cmd）。'
      : platform === 'macos'
        ? '执行任意 shell 命令。当前终端是 zsh（macOS）。'
        : '执行任意 shell 命令。当前终端是 sh（Linux/POSIX）。'
  return (
    prefix +
    '仅在无专用工具时使用（git、npm、构建等）。' +
    '文件/文本操作优先用 read_file、edit_file、write_file、search_* 等专用工具。' +
    SANDBOX_NOTE
  )
}

/** 平台特定的 command 参数描述。 */
function buildCommandDescription(platform: string): string {
  if (platform === 'windows') {
    return (
      '要执行的命令（PowerShell 语法，如 "Get-ChildItem"、"git status"、"node --version"）。' +
      '支持管道、重定向（>$null / 2>$null）、分号顺序执行；不支持 && / ||。'
    )
  }
  if (platform === 'macos') {
    return '要执行的命令（zsh 语法，如 "ls -la"、"git status"、"node --version"）。支持 &&/|| 串联、管道、重定向。'
  }
  return '要执行的命令（sh/POSIX 语法，如 "ls -la"、"git status"、"node --version"）。支持 &&/|| 串联、管道、重定向。'
}

toolRegistry.register(
  {
    name: 'execute_command',
    label: t('执行命令'),
    // 惰性描述：listDefinitions() 真正序列化给 LLM 时才求值。
    // 届时 platformSnapshot() 已大概率拿到 Rust os_platform 的权威平台（模块加载时已预热）。
    description: () => buildToolDescription(platformSnapshot()),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: () => buildCommandDescription(platformSnapshot()),
        },
        tips: {
          type: 'string',
          description:
            '简要说明这条命令的作用和执行原因（用用户的语言）。会显示在 UI 上，帮助用户理解命令的目的。',
        },
        timeout: {
          type: 'number',
          description:
            '超时时间（秒）。超过该时间进程会被强制终止。默认 30。',
          default: 30,
        },
      },
      required: ['command'],
    },
  },
  (async (
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolResult | UserInteractionRequired> => {
    const cmdStr = args.command
    const cwd = await securityService.getWorkspace(ctx.sessionId)
    let timeout = args.timeout ?? 30
    if (timeout < 0) timeout = 30
    if (timeout > 300) timeout = 300
    const timeoutMs = (timeout ?? 30) * 1000

    // 风险分类 & 弹窗确认
    const risk = classifyCommand(cmdStr)
    const mode = await securityService.getCommandApprovalMode()
    let needsApproval = false
    switch (mode) {
      case 'all':
        needsApproval = true
        break
      case 'risky':
        needsApproval = risk === 'dangerous'
        break
      case 'install':
        needsApproval = risk !== 'safe'
        break
      // case 'none': needsApproval 保持 false
    }
    if (needsApproval) {
      const info = getRiskInfo(risk)
      const { sessionId, toolCallId } = ctx
      // 注册本次审批（approvalId 唯一标识），用户确认后由常驻监听器精确执行
      const approvalId = registerPendingApproval({
        sessionId,
        toolCallId,
        run: () => runCommand(cmdStr, cwd, timeoutMs, ctx),
      })

      return new UserInteractionRequired('confirm_command', {
        approvalId,
        command: cmdStr,
        risk,
        label: info.label,
        hint: info.hint,
        tips: args.tips,
      })
    }

    ctx.write(`> ${cmdStr}\n`)
    return runCommand(cmdStr, cwd, timeoutMs, ctx)
  }) as ToolExecutor,
)

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

async function runCommand(
  cmdStr: string,
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
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
      toolName: 'execute_command',
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

export class CmdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CmdError'
  }
}
