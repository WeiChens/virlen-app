/**
 * execute_command — 执行一条 shell 命令，自动超时杀进程
 *
 * shell 选择策略：
 * - Windows: 命令含 cmd 特有语法（&& || >nul 2>nul <nul）时用 cmd，否则用 powershell
 * - macOS/Linux: sh
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
import toolInteractEvent from '@/events/toolInteractEvent'
import { getSkillsDirPath } from '@/skill/skillStore'
import { securityService } from '@/services/security-service'
import { toolOutputStore } from '../output-store'
import { processTerminalOutput } from '../terminal-output'

/**
 * 检测命令是否包含 cmd 特有语法。
 * 条件宽松——宁可误判也不要漏判，误判发到 cmd 也能正常工作。
 */
function hasCmdSyntax(cmd: string): boolean {
  // 运算符链：&&  ||  注意排除 powershell 的 -and / -or
  // ⚠️ 不能用 \b 包裹 && / ||，因为 & 和 | 是非单词字符，
  // 两边的空格也是非单词字符，\b 永远匹配不上（详见下方测试注释）
  if (/&&|\|\|/.test(cmd)) return true

  // 重定向：>nul  2>nul  <nul  （powershell 里是 $null）
  if (/[12]?>nul\b/.test(cmd)) return true
  if (/<nul\b/.test(cmd)) return true

  // 管道中间有 echo（cmd 风格 > nul 后面加内容，powershell 风格不同）
  if (/\becho\b/i.test(cmd) && /[>|]/.test(cmd)) return true

  return false
}

/**
 * 提取命令名（第一个 token，去路径/扩展名/引号）
 */
function extractCommandName(raw: string): string {
  const trimmed = raw.trimStart()
  const firstToken =
    trimmed.split(/[\s|&;<>()]/).find((t) => t.length > 0) || ''
  return firstToken
    .replace(/^['"]/, '')
    .replace(/^\.\//, '')
    .replace(/^.*[/\\]/, '') // 去掉路径前缀
    .toLowerCase()
    .replace(/\.(exe|bat|cmd|ps1|sh)$/, '') // 去扩展名
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
 */
function extractAllCommandNames(raw: string): string[] {
  // 先按 &&、||、; 分割子命令
  // 注意：& 和 | 不是单词字符，不能用 \b 匹配，直接用 &&、|| 字面量
  const segments = raw.split(/(?:&&|\|\|)|;/)
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
function classifyCommand(cmdStr: string): 'safe' | 'install' | 'dangerous' {
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

toolRegistry.register(
  {
    name: 'execute_command',
    label: t('执行命令'),
    description:
      'Run any shell command. Use only when no dedicated tool exists (git, npm, builds). Prefer read_file, edit_file, search_* for files/text.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The command to execute (e.g. "dir", "git status", "node --version"). Standard shell syntax — &&/|| pipes, >nul redirects all work naturally.',
        },
        timeout: {
          type: 'number',
          description:
            'Timeout in seconds. The process will be forcefully killed if it exceeds this. Default: 30.',
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
      // 监听同意后的回调
      if (!cmdLocks.has(ctx.toolCallId)) {
        cmdLocks.add(ctx.toolCallId)
        toolInteractEvent.once('userAllowCmd', (sid, toolId, result) => {
          if (!(sessionId === sid && toolCallId === toolId)) {
            return
          }
          result.result = runCommand(cmdStr, cwd, timeoutMs, ctx).finally(
            () => {
              cmdLocks.delete(toolCallId)
            },
          )
        })
      }

      return new UserInteractionRequired('confirm_command', {
        command: cmdStr,
        risk,
        label: info.label,
        hint: info.hint,
      })
    }

    ctx.write(`> ${cmdStr}\n`)
    return runCommand(cmdStr, cwd, timeoutMs, ctx)
  }) as ToolExecutor,
)

const cmdLocks = new Set<string>()
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

/** 缓存的平台字符串，来自 Rust os_platform */
let _platform: string | undefined

/** 获取当前平台标识（'windows' | 'linux' | 'macos'） */
async function detectPlatform(): Promise<string> {
  if (_platform) return _platform
  try {
    _platform = await invoke<string>('os_platform')
  } catch {
    // navigator.platform 已废弃，改用 userAgent
    const ua = navigator.userAgent
    if (/Windows/i.test(ua)) _platform = 'windows'
    else if (/Mac/i.test(ua)) _platform = 'macos'
    else _platform = 'linux'
  }
  return _platform
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

  if (isWin && hasCmdSyntax(cmdStr)) {
    // ⚠️ 必须用 /s /c 而非 /c，因为 Tauri Rust 底层 CreateProcess 会把含空格的
    // cmdStr 包裹在 "..." 中，且将内部 " 转义为 \"。加上 /s 后 cmd.exe 会：
    // 1. 剥离 Rust 添加的外层引号
    // 2. 把 \" 还原为 "，使路径引号正确生效
    shellName = 'cmd'
    shellArgs = ['/s', '/c', cmdStr]
  } else if (isWin) {
    shellName = 'powershell'
    shellArgs = ['-Command', cmdStr]
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
      const timer = setTimeout(() => {
        killedByTimeout = true
        killProcessTree(shellName, child).catch(() => {})
        resolve(null)
      }, timeoutMs)

      // 如果 abortSignal 已经 aborted，上面的监听已经杀了进程
      // close 事件还是会触发，正常 resolve
      cmd.on(
        'close',
        (payload: { code: number | null; signal: number | null }) => {
          clearTimeout(timer)
          resolve(payload.code)
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
