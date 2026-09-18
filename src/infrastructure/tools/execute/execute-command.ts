/**
 * execute_command — 执行一条 shell 命令，自动超时杀进程
 *
 * shell 选择策略（见 ./common.ts runCommand）：
 * - Windows: Windows PowerShell 5.1（powershell.exe，不再混用 cmd）
 * - macOS: zsh
 * - Linux: sh
 *
 * 审批：跟随 settings.commandApprovalMode，命中时返回 UserInteractionRequired('confirm_command')。
 */
import { toolRegistry } from '@/domain/tools'
import {
  UserInteractionRequired,
  type ToolContext,
  type ToolExecutor,
  type ToolResult,
} from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { securityService } from '@/services/security-service'
import {
  classifyCommand,
  getRiskInfo,
  platformSnapshot,
  registerPendingApproval,
  runCommand,
} from './common'

/** 沙盒模式通用说明（三平台共用尾部）。 */
const SANDBOX_NOTE =
  '结果首行是「终端环境」提示，报告沙盒模式——' +
  '「写隔离」（只能在 workspace/白名单可写根内写入，区外写入会被拒绝）、' +
  '「只读」（不可写）、或「无沙盒」（完整权限）。退出码 >= 2 表示命令执行失败。'

/** 申请绕过沙盒时追加到审批弹窗的警告（中文即 i18n key，英文见 en-US.json）。 */
const SANDBOX_BYPASS_HINT =
  '⚠️ 该命令申请「不使用沙盒」执行：不受写隔离与受限令牌限制，可写入任意路径。' +
  '仅当该命令确实需要管道 stdio（如 vitest / vite / jest / node-gyp）时允许。'

/** sandbox 参数描述（LLM 面向）：什么时候该申请绕过沙盒。 */
const SANDBOX_PARAM_NOTE =
  '默认不传（继承设置里的沙盒模式）。传 "off" 表示**申请**不使用沙盒执行，' +
  '仅用于沙盒下必然失败的场景：命令的子进程需要用管道 stdio 拉起孙进程' +
  '（vitest / vite / jest / ts-node / node-gyp / child_process.exec* 等），' +
  '沙盒的受限令牌会让那次 spawn 直接报 EPERM（日志形如 "spawn EPERM"）。' +
  '该请求必须经用户弹窗批准（不受 commandApprovalMode 影响）；沙盒为只读模式时会被直接拒绝。'

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
        sandbox: {
          type: 'string',
          enum: ['off'],
          description: SANDBOX_PARAM_NOTE,
        },
        confirm: {
          type: 'string',
          enum: ['terminal'],
          description:
            '传 "terminal" 表示「先在终端里由用户确认再执行」：命令会显示成一行**可编辑**的命令，' +
            '用户改完按 Enter 才真正执行，按 Esc 取消。适合需要用户拍板、可能被改写的命令' +
            '（如 npm login / gh auth login 这类需要登录或输入的命令）。' +
            '执行仍走同一条沙盒路径（用户写的命令 ≠ 免检命令）；仅 Windows 桌面端支持，' +
            '不可用时自动回落为审批弹窗。',
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

    // sandbox: 'off' → 申请「不使用沙盒」执行（与 Rust 原生路径同语义）。
    // ⚠️ 安全：一律强制审批，不受 commandApprovalMode 影响（不允许静默绕过）。
    const bypassSandbox = ['off', 'none'].includes(
      String(args.sandbox ?? '').toLowerCase(),
    )
    // confirm: 'terminal' → 请求「终端内确认」（与 Rust 原生路径同语义）。
    // TS 引擎路径无 PTY → 强制走审批弹窗（语义不丢；PTY 化见 docs/pty-research.md §7 #14）。
    const confirmTerminal =
      String(args.confirm ?? '').toLowerCase() === 'terminal'

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
    if (bypassSandbox) needsApproval = true
    // 终端内确认同样必须经过人工确认（不能因为指定了终端呈现就绕过审批）
    if (confirmTerminal) needsApproval = true
    if (needsApproval) {
      const info = getRiskInfo(risk)
      const hint = bypassSandbox
        ? [info.hint, t(SANDBOX_BYPASS_HINT)].filter(Boolean).join('\n')
        : info.hint
      const { sessionId, toolCallId } = ctx
      // 注册本次审批（approvalId 唯一标识），用户确认后由常驻监听器精确执行
      const approvalId = registerPendingApproval({
        sessionId,
        toolCallId,
        run: () => runCommand(cmdStr, cwd, timeoutMs, ctx),
      })

      const payload: Record<string, any> = {
        approvalId,
        command: cmdStr,
        risk,
        label: info.label,
        hint,
        tips: args.tips,
      }
      // 申请绕过沙盒时带上标记（与 Rust 原生路径一致，仅作留痕；警告文案已在 hint 里）
      if (bypassSandbox) payload.sandboxBypass = true
      // 终端内确认请求：Rust 原生路径会据此下发 presentation；TS 路径无 PTY → 这里仍是弹窗
      if (confirmTerminal) payload.confirm = 'terminal'

      return new UserInteractionRequired('confirm_command', payload)
    }

    ctx.write(`> ${cmdStr}\n`)
    return runCommand(cmdStr, cwd, timeoutMs, ctx)
  }) as ToolExecutor,
)
