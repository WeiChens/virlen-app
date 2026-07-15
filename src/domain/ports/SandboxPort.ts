/**
 * SandboxPort — 安全沙盒执行端口
 *
 * 定义安全命令执行环境的抽象接口，屏蔽底层执行细节。
 *
 * 实现方案：
 * - 默认：@tauri-apps/plugin-shell（跨平台兜底）
 * - Windows：可替换为 wsbx（受限令牌 + ACL 沙盒）
 * - Linux：可替换为 unshare + mount namespace
 *
 * ── 使用示例 ──
 *
 * ```ts
 * const result = await sandbox.execute('git status', {
 *   cwd: '/project',
 *   timeoutMs: 10000,
 *   onStdout: (chunk) => ctx.write(chunk),
 *   onStderr: (chunk) => ctx.write(`[stderr] ${chunk}`),
 *   abortSignal: ctx.abortSignal,
 *   onKill: (kill) => toolOutputStore.register(id, { kill }),
 * })
 * ```
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

  /**
   * 注册外部终止回调。
   * 实现方在进程启动后调用此函数，将 kill 能力暴露给调用者，
   * 用于 UI 层的「取消」按钮或 toolOutputStore 的中断机制。
   */
  onKill?: (kill: () => Promise<void>) => void
}

/**
 * 安全沙盒执行端口
 *
 * 各平台可替换底层实现，接口保持一致：
 * - 默认：@tauri-apps/plugin-shell
 * - Windows 增强：wsbx（CreateRestrictedToken + ACL）
 * - Linux 增强：unshare + bind-mount readonly
 */
export interface SandboxPort {
  /** 当前运行平台 */
  readonly platform: 'windows' | 'macos' | 'linux'

  /**
   * 执行命令（自动选择 shell）
   *
   * 根据平台和命令语法自动选择最合适的 shell：
   * - Windows：含 cmd 特有语法（&&、||、>nul）→ cmd /c，否则 → powershell -Command
   * - macOS：zsh -c
   * - Linux：sh -c
   *
   * @param command  命令字符串（如 "dir /b"、"git status"）
   * @param options  执行选项
   */
  execute(command: string, options: CommandOptions): Promise<CommandResult>

  /**
   * 使用指定 shell 执行命令
   *
   * 当调用方需要精确控制 shell 和参数时使用。
   *
   * @param shell  shell 名称或路径（如 "cmd"、"powershell"、"sh"、"zsh"）
   * @param args   shell 参数（如 ["/c", "echo hello"]）
   * @param options 执行选项
   */
  executeRaw(
    shell: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult>
}
