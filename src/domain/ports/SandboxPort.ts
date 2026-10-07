/**
 * SandboxPort — 安全沙盒执行端口（屏蔽底层执行细节）。
 *
 * 实现：默认 @tauri-apps/plugin-shell；Windows 可换 wsbx（受限令牌 + ACL），Linux 可换 unshare + namespace。
 */

/**
 * 命令执行结果
 */
export interface CommandResult {
  /** 标准输出（UTF-8） */
  stdout: string
  /** 标准错误（UTF-8） */
  stderr: string
  /** 退出码，null 表示被超时终止 */
  exitCode: number | null
  /** 是否超时 */
  timedOut: boolean
  /** 是否被外部终止（用户取消） */
  killed: boolean
}

/**
 * 命令执行选项
 */
export interface CommandOptions {
  /** 工作目录 */
  cwd: string

  /** 超时时间（毫秒），默认 30000 */
  timeoutMs?: number

  /** 额外环境变量 */
  env?: Record<string, string>

  /** stdout 实时回调（每收到一块数据） */
  onStdout?: (chunk: string) => void

  /** stderr 实时回调（每收到一块数据） */
  onStderr?: (chunk: string) => void

  /** 中断信号 — signal.aborted 时自动终止进程 */
  abortSignal?: AbortSignal

  /** 注册外部终止回调：实现方启动进程后调用它，把 kill 能力暴露给「取消」按钮 / toolOutputStore。 */
  onKill?: (kill: () => Promise<void>) => void
}

/** 安全沙盒执行端口（各平台实现可替换，接口不变）。 */
export interface SandboxPort {
  /** 当前运行平台 */
  readonly platform: 'windows' | 'macos' | 'linux'

  /**
   * 执行命令（自动选 shell）：Windows 含 cmd 语法（&& / || / >nul）→ cmd /c，否则 → powershell -Command；
   * macOS → zsh -c；Linux → sh -c。
   */
  execute(command: string, options: CommandOptions): Promise<CommandResult>

  /** 用指定 shell 与参数执行命令（调用方需精确控制时用）。 */
  executeRaw(
    shell: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult>
}
