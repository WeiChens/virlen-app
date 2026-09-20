import type { PermissionDecision } from '@/domain/permission'

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

  getSkipEachDirs(): Promise<string[]>
  initDefaultSecurity(): Promise<void>
}
