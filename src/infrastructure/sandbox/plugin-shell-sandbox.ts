/**
 * PluginShellSandbox — 基于 @tauri-apps/plugin-shell 的沙盒实现
 *
 * 使用 Tauri 的 shell 插件执行命令，是跨平台兜底方案。
 * 不提供额外的 OS 级隔离（如受限令牌、ACL），安全依赖上层风险分类。
 *
 * 🔄 可替换性：当 Windows 切换到 wsbx 时，只需新建一个实现 SandboxPort 的类，
 *    在工厂函数中按平台返回对应实例即可。
 */

import { Command, Child } from '@tauri-apps/plugin-shell'
import { invoke } from '@tauri-apps/api/core'
import { getSkillsDirPath } from '@/skill/skillStore'
import type {
  SandboxPort,
  CommandResult,
  CommandOptions,
} from '@/domain/ports/SandboxPort'

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 同步猜测平台（基于 UA，构造函数中用）
 */
function guessPlatformSync(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  return 'linux'
}

/**
 * 跨平台杀进程树
 */
async function killProcessTree(shellName: string, child: Child): Promise<void> {
  try {
    await invoke('kill_process_tree', { pid: child.pid })
  } catch (e) {
    console.warn('kill_process_tree failed, falling back to child.kill():', e)
    await child.kill()
  }
}

// ─── 实现 ──────────────────────────────────────────────────

export class PluginShellSandbox implements SandboxPort {
  readonly platform: 'windows' | 'macos' | 'linux'

  /**
   * @param platform 明确指定平台；不传则从 UA 自动检测
   */
  constructor(platform?: 'windows' | 'macos' | 'linux') {
    this.platform = platform ?? guessPlatformSync()
  }

  async execute(
    command: string,
    options: CommandOptions,
  ): Promise<CommandResult> {
    const { platform } = this
    const isWin = platform === 'windows'
    const isLinux = platform === 'linux'
    const isMac = platform === 'macos'

    // ── 选择 shell ──
    let shell: string
    let args: string[]

    if (isWin) {
      // Windows 统一走 Windows PowerShell 5.1（powershell.exe），不再混用 cmd
      shell = 'powershell'
      args = ['-NoProfile', '-Command', command]
    } else if (isMac) {
      // macOS Catalina+ 默认 shell 为 zsh
      shell = 'zsh'
      args = ['-c', command]
    } else if (isLinux) {
      shell = 'sh'
      args = ['-c', command]
    } else {
      shell = 'sh'
      args = ['-c', command]
    }

    return this.executeRaw(shell, args, options)
  }

  async executeRaw(
    shell: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    const {
      cwd,
      timeoutMs = 30000,
      env: extraEnv,
      onStdout,
      onStderr,
      abortSignal,
      onKill,
    } = options

    // ── 构建环境变量 ──
    const env: Record<string, string> = {
      PYTHONIOENCODING: 'utf-8',
      ...extraEnv,
    }

    // 注入 SKILL_ROOT（标记技能目录路径，供子进程只读保护）
    try {
      const skillsDir = await getSkillsDirPath()
      env.SKILL_ROOT = skillsDir
    } catch {
      // 非 Tauri 环境或无 skills 目录时跳过
    }

    // ── 创建命令 ──
    const cmd = Command.create(shell, args, { cwd, env })

    // ── 输出收集 + 实时回调 ──
    const output = { stdout: '', stderr: '' }

    cmd.stdout.on('data', (data: string) => {
      output.stdout += data
      onStdout?.(data)
    })

    cmd.stderr.on('data', (data: string) => {
      output.stderr += data
      onStderr?.(data)
    })

    // ── 启动进程 ──
    const child = await cmd.spawn()

    // 暴露 kill 给外部（如 toolOutputStore 的取消按钮）
    const kill = async () => {
      await killProcessTree(shell, child)
    }
    onKill?.(kill)

    // ── 超时 + 中断处理 ──
    let killedByUser = false
    let killedByTimeout = false

    const onAbort = () => {
      killedByUser = true
      killProcessTree(shell, child).catch(() => {})
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    // ── 等待进程结束 ──
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
        // 否则工具返回「已超时」但子进程还活着。
        try {
          await killProcessTree(shell, child)
        } catch {
          // ignore — settle 由 close/兜底定时器接管
        }
        // 若进程树没被杀干净（极端情况），最多再等 5s 兜底返回，避免工具卡死
        const closeTimer = setTimeout(() => settle(null), 5000)
        cmd.on('close', (payload: { code: number | null }) => {
          clearTimeout(closeTimer)
          settle(payload.code)
        })
      }, timeoutMs)

      cmd.on('close', (payload: { code: number | null }) => {
        settle(payload.code)
      })
    })

    // 清理 abort 监听，避免内存泄漏
    abortSignal?.removeEventListener('abort', onAbort)

    return {
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode,
      timedOut: killedByTimeout,
      killed: killedByUser,
    }
  }
}
