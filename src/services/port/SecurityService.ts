import type { PermissionDecision } from '@/domain/permission'
import type { SandboxIgnoreRule } from '@/domain/security/sandbox-ignore-rules'

export interface SecurityService {
  getWorkspace(sessionId?: string): Promise<string>

  isPathAllowed(
    targetPath: string,
    mode: 'r' | 'w' | 'all',
    sessionId?: string,
  ): Promise<{ allowed: boolean; reason: string }>

  /** 解析并校验路径是否有指定权限 */
  resolveSafePath(
    inputPath: string,
    mode: 'r' | 'w' | 'all',
    sessionId?: string,
  ): Promise<string>

  getPermissionDecision(name: string): Promise<PermissionDecision>

  /**
   * 「忽略沙盒命令」规则匹配（设置 → 安全）：命中 → 免除「沙盒脱壳」审批，并强制以不使用沙盒方式执行。
   * ⚠️ TS 侧匹配实现只有一份（@/domain/security/sandbox-ignore-rules）：回退路径与设置页「测试」都走它，不重实现。
   */
  matchSandboxIgnoreRule(command: string): Promise<SandboxIgnoreRule | null>

  getSkipEachDirs(): Promise<string[]>
  initDefaultSecurity(): Promise<void>
}
