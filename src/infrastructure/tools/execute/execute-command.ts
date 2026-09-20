/**
 * execute_command — 执行一条 shell 命令，自动超时杀进程
 *
 * shell 选择策略（见 ./common.ts runCommand）：
 * - Windows: Windows PowerShell 5.1（powershell.exe，不再混用 cmd）
 * - macOS: zsh
 * - Linux: sh
 *
 * 审批：按权限三态（settings.permissions[terminal.*]：允许 / 每次弹窗 / 禁止）决策；
 * 申请绕过沙盒（sandbox:"off"）时另过「沙盒脱壳·命令执行」权限（与风险权限取更严格者）；
 * 命中弹窗时返回 UserInteractionRequired('confirm_command')，禁止时直接抛错。
 */
import { toolRegistry } from '@/domain/tools'
import {
  UserInteractionRequired,
  type ToolContext,
  type ToolExecutor,
  type ToolResult,
} from '@/domain/tools/types'
import { t, tpl } from '@/ui/i18n'
import { securityService } from '@/services/security-service'
import {
  PERM_SANDBOX_COMMAND,
  permissionForRisk,
  permissionLabel,
  resolveCommandDecision,
} from '@/domain/permission'
import { settingsState } from '@/ui/store'
import {
  SANDBOX_BYPASS_HINT,
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

/** sandbox 参数描述（LLM 面向）：什么时候该申请绕过沙盒。 */
const SANDBOX_PARAM_NOTE =
  '默认不传（继承设置里的沙盒模式）。传 "off" 表示**申请**不使用沙盒执行，' +
  '仅用于沙盒下必然失败的场景：命令的子进程需要用管道 stdio 拉起孙进程' +
  '（vitest / vite / jest / ts-node / node-gyp / child_process.exec* 等），' +
  '沙盒的受限令牌会让那次 spawn 直接报 EPERM（日志形如 "spawn EPERM"）。' +
  '该请求须经「沙盒脱壳」权限授权（默认弹窗确认，可设为允许/禁止）；沙盒为只读模式时会被直接拒绝。'

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
    // ⚠️ 安全：该请求过「沙盒脱壳」权限门禁（与命令风险权限取更严格者；默认弹窗，
    //   用户可设为 allow 静默脱壳 / deny 直接禁止）；readonly 模式直接拒绝。
    const bypassSandbox = ['off', 'none'].includes(
      String(args.sandbox ?? '').toLowerCase(),
    )
    // confirm: 'terminal' → 请求「终端内确认」（与 Rust 原生路径同语义）。
    // TS 引擎路径无 PTY → 强制走审批弹窗（语义不丢；PTY 化见 docs/pty-research.md §7 #14）。
    const confirmTerminal =
      String(args.confirm ?? '').toLowerCase() === 'terminal'

    // 风险分类 → 权限 name → 权限三态决策（allow / ask / deny）
    const risk = classifyCommand(cmdStr)
    const permName = permissionForRisk(risk)
    const base = await securityService.getPermissionDecision(permName)
    // 沙盒实际启用与否：off 时「申请绕过」没有意义（本来就不进沙盒），不参与脱壳门禁
    const sandboxMode = settingsState.value.sandboxMode ?? 'on'
    // 只读模式禁止绕过沙盒（否则只读保护会被绕过；与 Rust 原生路径一致）
    if (bypassSandbox && sandboxMode === 'readonly') {
      throw new Error(
        t(
          '沙盒处于只读模式，不支持绕过沙盒执行命令；请先在设置中切换沙盒模式（或改用常规终端）',
        ),
      )
    }
    // 申请绕过沙盒且沙盒启用 → 额外过「沙盒脱壳」权限（与风险权限取更严格者）
    const escapeDecision =
      bypassSandbox && sandboxMode !== 'off'
        ? await securityService.getPermissionDecision(PERM_SANDBOX_COMMAND)
        : undefined
    // deny 优先；终端内确认强制至少 ask（安全底线）
    const decision = resolveCommandDecision(base, {
      escapeDecision,
      confirmTerminal,
    })

    if (decision === 'deny') {
      // 禁止：不执行、不弹窗，返回拒绝文本给模型（标明是哪个权限拦下的）
      const deniedPerm =
        escapeDecision === 'deny' ? PERM_SANDBOX_COMMAND : permName
      throw new Error(
        tpl('操作已被权限设置禁止：$__perm__', {
          perm: t(permissionLabel(deniedPerm)),
        }),
      )
    }

    if (decision === 'ask') {
      const info = getRiskInfo(risk)
      const hint = bypassSandbox
        ? [info.hint, t(SANDBOX_BYPASS_HINT)].filter(Boolean).join('\n')
        : info.hint
      // 触发本次确认的权限：若仅因「沙盒脱壳」（基础允许、脱壳询问）→ 展示脱壳权限，
      // 让用户知道要放行的是哪条权限；否则展示命令风险权限（与 Rust 原生路径一致）。
      const shownPerm =
        bypassSandbox && base === 'allow' && escapeDecision === 'ask'
          ? PERM_SANDBOX_COMMAND
          : permName
      const { sessionId, toolCallId } = ctx
      // 注册本次审批（approvalId 唯一标识），用户确认后由常驻监听器精确执行
      const approvalId = registerPendingApproval({
        sessionId,
        toolCallId,
        run: () =>
          runCommand(cmdStr, cwd, timeoutMs, ctx, 'execute_command', {
            bypassSandbox,
          }),
      })

      const payload: Record<string, any> = {
        approvalId,
        // 通用授权字段（弹窗展示）：权限唯一 key + 权限名 + 说明 + 内容
        permName: shownPerm,
        title: t(permissionLabel(shownPerm)),
        subTitle: args.tips,
        desc: cmdStr,
        hint,
        risk,
      }
      // 申请绕过沙盒时带上标记（与 Rust 原生路径一致，仅作留痕；警告文案已在 hint 里）
      if (bypassSandbox) payload.sandboxBypass = true
      // 终端内确认请求：Rust 原生路径会据此下发 presentation；TS 路径无 PTY → 这里仍是弹窗
      if (confirmTerminal) payload.confirm = 'terminal'

      return new UserInteractionRequired('confirm_command', payload)
    }

    ctx.write(`> ${cmdStr}\n`)
    return runCommand(cmdStr, cwd, timeoutMs, ctx, 'execute_command', {
      bypassSandbox,
    })
  }) as ToolExecutor,
)
