import type { PermissionDecision } from '@/domain/permission'
import type { SandboxIgnoreRule } from '@/domain/security/sandbox-ignore-rules'

export interface SecurityService {
  getWorkspace(sessionId?: string): Promise<string>

  isPathAllowed(
    targetPath: string,
    mode: 'r' | 'w' | 'all',
    sessionId?: string,
  ): Promise<{ allowed: boolean; reason: string }>

  /**
   * 校验路径是否有指定权限
   * @param inputPath 解析并校验路径
   * @param mode
   * @param sessionId
   */
  resolveSafePath(
    inputPath: string,
    mode: 'r' | 'w' | 'all',
    sessionId?: string,
  ): Promise<string>

  getPermissionDecision(name: string): Promise<PermissionDecision>

  /**
   * 「忽略沙盒命令」规则匹配（设置 → 安全 → 忽略沙盒命令）。
   *
   * 命中 → 该命令**免除「沙盒脱壳」审批**并**强制以「不使用沙盒」方式执行**
   * （即 AI 不必显式传 `sandbox:"off"`）。
   * ⚠️ TS 侧匹配实现只有一份（`@/domain/security/sandbox-ignore-rules`）—— 回退路径与
   * 设置页「测试」都走它，不重实现（规则含用户自写的 `js` 函数）。
   */
  matchSandboxIgnoreRule(command: string): Promise<SandboxIgnoreRule | null>

  getSkipEachDirs(): Promise<string[]>
  initDefaultSecurity(): Promise<void>
}
