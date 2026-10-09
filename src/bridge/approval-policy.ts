/**
 * approval-policy —— 授权审批的**分级判定**（单一真源，见 docs/phone-control-bridge.md §16.2）。
 *
 * ⚠️ 分级只决定「手机批准前是否需二次确认」，**不决定「谁能批」**。当前档位（宽松）：手机可批全部授权
 *（含脱壳 / 危险命令），故 high 不是权限门槛、而是「摩擦门槛」。判严代价是多一次确认、判松代价是少一道
 * 摩擦，两种错误不对称 → **未知一律从严**。
 *
 * 判定依据全部来自电脑侧既有契约（domain/permission、Rust classify.rs），不新增枚举。
 */
import type { ApprovalTier } from 'virlen-remote'

/** 已知权限集合（与 `domain/permission/index.ts` 的注册表**一一对应**；漏登记 = 该权限在手机侧被静默判为「未知」→ 从严）。 */
export const KNOWN_PERMS: ReadonlySet<string> = new Set([
  'terminal.normal.execute',
  'terminal.install.execute',
  'terminal.dangerous.execute',
  'script.execute',
  // 后台服务（常驻进程）：与普通终端命令同档（低摩擦）——它已由桌面端权限（默认 ask）拦截，
  // 手机侧要防的只是「AI 自作主张要求脱壳 / 跑了危险命令」，那两条各自已判 high。
  'terminal.background.execute',
  'sandbox.command.execute',
  'sandbox.script.execute',
])

/** 恒判高风险的权限（即使 risk 为 safe —— 脚本正文 / 脱壳门禁本身即高危面）。 */
const ALWAYS_HIGH_PERMS: ReadonlySet<string> = new Set([
  'terminal.dangerous.execute',
  'script.execute',
  'sandbox.command.execute',
  'sandbox.script.execute',
])

export interface ApprovalDescriptor {
  kind: 'choice' | 'authorization'
  permName?: string
  /** 电脑侧的风险分类（`safe` / `install` / `dangerous`，与 `classify.rs` 对齐）。 */
  risk?: string
  /** AI 申请不使用沙盒执行（Rust / TS 回退路径都会标记）。 */
  sandboxBypass?: boolean
  presentation?: 'modal' | 'terminal'
}

export interface ApprovalPolicy {
  tier: ApprovalTier
  /** 判定理由（写进审计，便于事后解释「为什么这次要二次确认」）。 */
  reason: string
}

/** 判定一次交互的分级。 */
export function classifyApproval(d: ApprovalDescriptor): ApprovalPolicy {
  // AI 提问不是安全边界（它无法凭自身造成副作用）→ 不设摩擦
  if (d.kind === 'choice') return { tier: 'low', reason: 'AI 提问（非安全边界）' }

  if (d.presentation === 'terminal') {
    return { tier: 'high', reason: '终端内确认：手机只能原样放行，不能编辑命令' }
  }
  if (d.sandboxBypass === true) {
    return { tier: 'high', reason: '申请不使用沙盒执行' }
  }
  if (d.risk === 'dangerous') {
    return { tier: 'high', reason: '命令风险等级 dangerous' }
  }

  const perm = d.permName ?? ''
  if (!perm) return { tier: 'high', reason: '缺少权限标识（从严）' }
  if (ALWAYS_HIGH_PERMS.has(perm)) return { tier: 'high', reason: `高危权限：${perm}` }
  // 未知权限 = 新增权限没在本文件登记 → 从严（否则新权限会静默降级为「一次点击即放行」）
  if (!KNOWN_PERMS.has(perm)) return { tier: 'high', reason: `未知权限（从严）：${perm}` }

  return { tier: 'low', reason: perm }
}
