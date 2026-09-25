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
 * 命中「忽略沙盒命令」规则（设置 → 安全）时**免脱壳审批并强制无沙盒执行**（不必 AI 申请）；
 * 命中弹窗时返回 UserInteractionRequired('confirm_command')，禁止时直接抛错。
 *
 * ⚠️ 规则语义与 Rust 原生路径（`native_tools/execute/execute_command.rs`）对齐：
 *    匹配用同一个 `securityService.matchSandboxIgnoreRule`（Rust 侧经内部交互
 *    `sandbox_rule_check` 问到同一函数），改一边必须同步另一边（铁律 1）。
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
import { track } from '@/utils/telemetry'
import {
  SANDBOX_BYPASS_HINT,
  SANDBOX_RULE_BYPASS_HINT,
  classifyCommand,
  getRiskInfo,
  registerPendingApproval,
  runCommand,
} from './common'

// 工具描述（含三平台变体）已收敛到权威源（机制 C）：
// src-tauri/src/agent/tool_defs/definitions.json —— 见 docs/rust-engine.md §12。
// 此处不再保留描述文本，避免与契约静默分叉。

toolRegistry.register(
    'execute_command',
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
    const aiRequestedBypass = ['off', 'none'].includes(
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
    // ⚠️ 只针对 AI 的**显式申请**：命中「忽略沙盒命令」规则时只读模式**静默忽略规则**
    //   （命令继续走沙盒），不把一条本来能跑的命令变成报错。
    if (aiRequestedBypass && sandboxMode === 'readonly') {
      // ⚠️ 模型侧文案：固定英文，与 Rust 原生实现（native_tools/execute/execute_command.rs）逐字对齐
      throw new Error(
        'The sandbox is in read-only mode, so bypassing it to run a command is not allowed; switch the sandbox mode in settings first (or use a regular terminal)',
      )
    }
    // 「忽略沙盒命令」规则（设置 → 安全）：命中即**免脱壳审批 + 强制无沙盒执行** ——
    // 即使 AI 没传 sandbox:"off" 也生效（这正是该功能的目的：npm/pnpm 安装、vitest 等
    // 高频命令不必每次点授权）。
    // ⚠️ 只在沙盒**启用**时匹配：off 时无沙盒可脱；readonly 时脱壳被禁止。
    const ruleHit =
      sandboxMode === 'on'
        ? await securityService.matchSandboxIgnoreRule(cmdStr)
        : null
    const bypassSandbox = aiRequestedBypass || !!ruleHit
    if (ruleHit) {
      // 留痕（只记工具名 / 原因，不记命令正文与规则名，遵循 §9）
      track('tool.sandbox.bypass', {
        tool_name: 'execute_command',
        status: 'auto_rule',
      })
    }
    // 申请绕过沙盒且沙盒启用 → 额外过「沙盒脱壳」权限（与风险权限取更严格者）
    const configuredEscape =
      bypassSandbox && sandboxMode !== 'off'
        ? await securityService.getPermissionDecision(PERM_SANDBOX_COMMAND)
        : undefined
    // 命中规则 → 用户已用规则预先授权脱壳（ask 视作 allow）；⚠️ deny 仍然优先：
    // 规则不能推翻「沙盒脱壳」权限的显式禁止（与 Rust 侧 apply_rule_clearance 对齐）
    const escapeDecision =
      ruleHit && configuredEscape === 'ask' ? 'allow' : configuredEscape
    // deny 优先；终端内确认强制至少 ask（安全底线）
    const decision = resolveCommandDecision(base, {
      escapeDecision,
      confirmTerminal,
    })

    if (decision === 'deny') {
      // 禁止：不执行、不弹窗，返回拒绝文本给模型（标明是哪个权限拦下的）
      const deniedPerm =
        escapeDecision === 'deny' ? PERM_SANDBOX_COMMAND : permName
      // 只报**权限 name**（与设置页一一对应的稳定 key）：语言无关，
      // 且与 Rust 原生实现逐字对齐（两处都不得再回落到本地化的权限中文名）
      throw new Error(
        `Operation denied by the permission settings: ${deniedPerm}`,
      )
    }

    if (decision === 'ask') {
      const info = getRiskInfo(risk)
      // 追加沙盒脱壳警告：命中规则时说明「为什么没申请也脱壳了」，AI 申请时用原警告
      const hint = ruleHit
        ? [info.hint, tpl(SANDBOX_RULE_BYPASS_HINT, { rule: ruleHit.name })]
            .filter(Boolean)
            .join('\n')
        : bypassSandbox
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
    t('执行命令'),
)
