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
 * 单独成文件（而非挂在 `TerminalBlock.tsx`）：`TerminalBlock ⇄ XtermTerminal` 已互为依赖，
 * 徽标被两者共用，放这里可避免新增循环。
 */
const SANDBOX_LABELS: Record<
  string,
  { label: string; title: string; danger?: boolean }
> = {
  write_isolation: {
    label: '沙盒·写隔离',
    title: '命令在沙盒内运行：仅工作目录与白名单目录可写（写隔离）。',
  },
  readonly: {
    label: '沙盒·只读',
    title: '命令在沙盒内以只读方式运行：无法写入任何文件。',
  },
  no_sandbox_bypass: {
    label: '无沙盒·已授权',
    title:
      '命令未使用沙盒运行（已批准脱壳）：不受写隔离与受限令牌限制，可写入任意路径。',
    danger: true,
  },
  no_sandbox_disabled: {
    label: '无沙盒',
    title: '命令未使用沙盒运行（设置中已关闭沙盒）：可写入任意路径。',
    danger: true,
  },
  no_sandbox_degraded: {
    label: '无沙盒·已降级',
    title: '命令未使用沙盒运行（沙盒不可用，已降级为完全权限）。',
    danger: true,
  },
  no_sandbox_rule: {
    label: '无沙盒·忽略规则',
    title:
      '命令命中「忽略沙盒命令」规则，已按规则以「不使用沙盒」方式执行：可写入任意路径。',
    danger: true,
  },
  no_sandbox: {
    label: '无沙盒',
    title: '命令未使用沙盒运行（完全权限）。',
    danger: true,
  },
}

export function SandboxBadge({ kind }: { kind?: string }) {
  if (!kind) return null
  const info = SANDBOX_LABELS[kind]
  if (!info) return null
  return (
    <span
      className={`terminal-sandbox-badge${info.danger ? ' is-danger' : ''}`}
      title={t(info.title)}>
      {t(info.label)}
    </span>
  )
}
