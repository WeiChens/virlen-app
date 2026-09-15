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
