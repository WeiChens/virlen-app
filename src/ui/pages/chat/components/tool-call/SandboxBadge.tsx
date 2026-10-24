import { t } from '@/ui/i18n'

/**
 * 终端块 header 的「沙盒模式」徽标（header-left）。
 *
 * 数据来源 = **Rust 侧判定的实际模式**（与模型侧首行 `env_note` 同源，只是结构化、可本地化）：
 *   - 运行中：经 `agent:tool-env` 事件写入 `toolOutputStore` 条目；
 *   - 完成态：后端权威字段 `uiData.sandbox`。
 *
 * 取值契约（Rust `runner/mod.rs` 的 `attach_sandbox` / `emit_sandbox_env`）：
 *   write_isolation | readonly | no_sandbox_bypass | no_sandbox_disabled | no_sandbox_degraded | no_sandbox
 *
 * **只画「在沙盒里」的那两种**（`write_isolation` / `readonly`）；`no_sandbox*` 一律不画。
 * 「没沙盒」是常态而不是异常 —— 设置里关掉沙盒、命中忽略规则、AI 申请脱壳、用户终端本来
 * 就不进沙盒，全落在这一档；四档再各配一枚红标，界面很快就成一片红，谁都不看了。真正需要人
 * 当场注意的脱壳，在**审批弹窗**那一刻已经拦过一次（那一步必须点过）。
 *
 * 单独成文件（而非挂在 `TerminalBlock.tsx`）：`TerminalBlock ⇄ XtermTerminal` 已互为依赖，
 * 徽标被两者共用，放这里可避免新增循环。
 */
const SANDBOX_LABELS: Record<string, { label: string; title: string }> = {
  write_isolation: {
    label: '沙盒·写隔离',
    title: '命令在沙盒内运行：仅工作目录、白名单目录与系统临时目录可写（写隔离）。',
  },
  readonly: {
    label: '沙盒·只读',
    title: '命令在沙盒内以只读方式运行：无法写入任何文件。',
  },
}

export function SandboxBadge({ kind }: { kind?: string }) {
  if (!kind) return null
  const info = SANDBOX_LABELS[kind]
  if (!info) return null
  return (
    <span className="terminal-sandbox-badge" title={t(info.title)}>
      {t(info.label)}
    </span>
  )
}
