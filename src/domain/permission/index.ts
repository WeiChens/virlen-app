/**
 * permission — 权限注册表与三态决策（领域层，纯逻辑）
 *
 * 设计：把「需要用户授权的操作」抽象成带命名空间的权限 name，
 * 每种权限有 允许(allow) / 每次弹窗(ask) / 禁止(deny) 三态。
 * 终端命令按风险分类映射到 terminal.*，脚本执行映射到 script.execute；
 * 「沙盒脱壳」（AI 申请不使用沙盒执行，sandbox:"off"）另有独立门禁
 * sandbox.command.execute / sandbox.script.execute，与命令风险权限**取更严格者**。
 * 取代了旧的全局枚举 `commandApprovalMode`（过粗，无法单独控制某类操作）。
 *
 * ⚠️ 本文件的常量与决策语义与 Rust 侧
 * `virlen-core/src/agent/native_tools/execute/common/classify.rs` 逐字对齐（铁律 1），
 * 改一边必须同步改另一边。
 */

/** 三态权限决策 */
export type PermissionDecision = 'allow' | 'ask' | 'deny'

/** 命令风险分类（与 classifyCommand 输出对齐） */
export type CommandRisk = 'safe' | 'install' | 'dangerous'

export interface PermissionDef {
  /** 权限 name（命名空间，跨 TS / Rust 的稳定契约） */
  name: string
  /** 中文名（中文即 i18n key） */
  label: string
  /** 说明（中文即 i18n key） */
  description: string
  /** 新用户默认决策 */
  default: PermissionDecision
}

/** 终端命令权限 name */
export const PERM_TERMINAL_NORMAL = 'terminal.normal.execute'
export const PERM_TERMINAL_INSTALL = 'terminal.install.execute'
export const PERM_TERMINAL_DANGEROUS = 'terminal.dangerous.execute'
/** 脚本命令权限 name */
export const PERM_SCRIPT = 'script.execute'
/** 沙盒脱壳（申请不使用沙盒执行）权限 name —— 命令执行 */
export const PERM_SANDBOX_COMMAND = 'sandbox.command.execute'
/** 沙盒脱壳（申请不使用沙盒执行）权限 name —— 脚本执行 */
export const PERM_SANDBOX_SCRIPT = 'sandbox.script.execute'

/** 权限注册表（新增权限只需在这里加一项；旧用户缺失项会自动补默认值） */
export const PERMISSIONS: PermissionDef[] = [
  {
    name: PERM_TERMINAL_NORMAL,
    label: '终端正常命令执行',
    description: '安全命令（git status / ls 等）执行前是否需要确认',
    default: 'allow',
  },
  {
    name: PERM_TERMINAL_INSTALL,
    label: '终端安装命令执行',
    description: '安装类命令（npm / pip / cargo 等）执行前是否需要确认',
    default: 'ask',
  },
  {
    name: PERM_TERMINAL_DANGEROUS,
    label: '终端危险命令执行',
    description: '高危命令（删除 / 修改系统等）执行前是否需要确认',
    default: 'ask',
  },
  {
    name: PERM_SCRIPT,
    label: '脚本命令执行',
    description: '创建并执行脚本文件前是否需要确认',
    default: 'ask',
  },
  {
    name: PERM_SANDBOX_COMMAND,
    label: '沙盒脱壳·命令执行',
    description:
      'AI 申请「不使用沙盒」执行命令时（如需要管道 stdio 的 vitest / vite / jest 等）是否需要确认；' +
      '与命令风险权限取更严格者',
    default: 'ask',
  },
  {
    name: PERM_SANDBOX_SCRIPT,
    label: '沙盒脱壳·脚本执行',
    description:
      'AI 申请「不使用沙盒」执行脚本时是否需要确认；与脚本执行权限取更严格者',
    default: 'ask',
  },
]

/** 权限 name → 决策 的映射（持久化在 settings.permissions） */
export type PermissionMap = Record<string, PermissionDecision>

const DECISIONS: PermissionDecision[] = ['allow', 'ask', 'deny']

function isDecision(v: unknown): v is PermissionDecision {
  return DECISIONS.includes(v as PermissionDecision)
}

/** 严格度：allow(0) < ask(1) < deny(2) —— 用于「取更严格者」合并两项权限 */
function strictness(d: PermissionDecision): number {
  return d === 'deny' ? 2 : d === 'ask' ? 1 : 0
}

/** 风险分类 → 权限 name */
export function permissionForRisk(risk: CommandRisk): string {
  switch (risk) {
    case 'install':
      return PERM_TERMINAL_INSTALL
    case 'dangerous':
      return PERM_TERMINAL_DANGEROUS
    default:
      return PERM_TERMINAL_NORMAL
  }
}

/** 取某权限的决策；缺失 / 非法值时回退注册表默认值 */
export function getPermissionDecision(
  permissions: PermissionMap | undefined,
  name: string,
): PermissionDecision {
  const v = permissions?.[name]
  if (isDecision(v)) return v
  return PERMISSIONS.find((p) => p.name === name)?.default ?? 'ask'
}

/** 按注册表补全缺失项（新增权限时老用户自动获得默认值） */
export function withDefaultPermissions(
  permissions: PermissionMap | undefined,
): PermissionMap {
  const out: PermissionMap = {}
  for (const p of PERMISSIONS) {
    out[p.name] = getPermissionDecision(permissions, p.name)
  }
  return out
}

/** 权限中文名（找不到时回退 name 本身） */
export function permissionLabel(name: string): string {
  return PERMISSIONS.find((p) => p.name === name)?.label ?? name
}

/**
 * 最终决策（严格度递进）：
 * - `deny` 永远优先（任何理由都不能放宽）；
 * - 申请绕过沙盒（`escapeDecision` 为「沙盒脱壳」权限决策）→ 与基础决策**取更严格者**
 *   （脱壳权限默认 `ask`；用户可设为 `allow` 静默脱壳、`deny` 直接禁止）；
 * - 终端内确认（`confirmTerminal`）→ 强制至少 `ask`（安全底线，不被 `allow` 静默放行）。
 *
 * `escapeDecision` 为 `undefined` 表示本次未申请绕过沙盒（不参与合并）。
 */
export function resolveCommandDecision(
  base: PermissionDecision,
  opts?: {
    escapeDecision?: PermissionDecision
    confirmTerminal?: boolean
  },
): PermissionDecision {
  let d = base
  if (opts?.escapeDecision && strictness(opts.escapeDecision) > strictness(d)) {
    d = opts.escapeDecision
  }
  if (d === 'deny') return 'deny'
  if (opts?.confirmTerminal) return 'ask'
  return d
}

/**
 * 旧 `commandApprovalMode`（全局枚举）→ 新权限表（一次性迁移用）。
 * 返回 `null` 表示没有可迁移的旧值（新用户 → 直接用注册表默认）。
 */
export function migrateApprovalMode(
  mode: string | undefined,
): PermissionMap | null {
  const mapMode = (m: string) => {
    switch (m) {
      case 'all':
        return { normal: 'ask', install: 'ask', dangerous: 'ask' } as const
      case 'risky':
        return { normal: 'allow', install: 'allow', dangerous: 'ask' } as const
      case 'install':
        return { normal: 'allow', install: 'ask', dangerous: 'ask' } as const
      case 'none':
        return { normal: 'allow', install: 'allow', dangerous: 'allow' } as const
      default:
        return null
    }
  }
  if (!mode) return null
  const r = mapMode(mode)
  if (!r) return null
  return {
    [PERM_TERMINAL_NORMAL]: r.normal,
    [PERM_TERMINAL_INSTALL]: r.install,
    [PERM_TERMINAL_DANGEROUS]: r.dangerous,
    [PERM_SCRIPT]: 'ask',
  }
}
