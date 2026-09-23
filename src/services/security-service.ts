/**
 * security-service — Application 层安全策略服务
 *
 * 职责：
 *  - 编排安全相关业务流程（工作区解析、权限校验、默认安全配置初始化）
 *  - 协调 Domain（securityPort）与 Infrastructure（securityRepo）
 *
 * ⚠️ 不直接访问 UI Store（securityStore），通过 Repo 读写持久化数据。
 */
import {
  sessionStore,
  resolveDefaultWorkspace,
  settingsState,
} from '@/ui/store'
import { securityRepo } from '@/infrastructure/securityRepo'
import { SecurityService } from './port'
import { securityPort } from '@/domain/security'
import {
  findMatchingSandboxRule,
  type SandboxIgnoreRule,
} from '@/domain/security/sandbox-ignore-rules'
import {
  getPermissionDecision as getPermDecision,
  type PermissionDecision,
} from '@/domain/permission'
import { getPlatform } from '@/utils/common'

class SecurityServiceImpl implements SecurityService {
  async getPermissionDecision(name: string): Promise<PermissionDecision> {
    return getPermDecision(settingsState.value.permissions, name)
  }
  async getSkipEachDirs(): Promise<string[]> {
    return [...securityRepo.load().skipEachDirs]
  }

  /**
   * 「忽略沙盒命令」规则匹配（设置 → 安全 → 忽略沙盒命令）。
   *
   * 命中 → 该命令**免除「沙盒脱壳」审批**且**强制以「不使用沙盒」方式执行**
   * （与 Rust 原生路径经桥问到的是同一个实现，见 `domain/security/sandbox-ignore-rules`）。
   * 匹配异常一律返回 null（不脱壳），由匹配器内部保证。
   */
  async matchSandboxIgnoreRule(command: string): Promise<SandboxIgnoreRule | null> {
    if (!command || !command.trim()) return null
    return findMatchingSandboxRule(
      securityRepo.load().sandboxIgnoreRules,
      command,
    )
  }
  async getWorkspace(sessionId?: string): Promise<string> {
    if (sessionId) {
      const session = sessionStore.getSession(sessionId)
      if (session?.workspace) {
        return session.workspace.replace(/\\/g, '/').replace(/\/+$/, '')
      }
    }
    if (!settingsState.value.defaultWorkspace) {
      const defaultWorkspace = await resolveDefaultWorkspace()
      settingsState.setValue('defaultWorkspace', defaultWorkspace)
      return defaultWorkspace
    }
    return settingsState.value.defaultWorkspace
  }
  async isPathAllowed(
    targetPath: string,
    mode: 'r' | 'w' | 'all',
    sessionId?: string,
  ): Promise<{ allowed: boolean; reason: string }> {
    const workspace = await this.getWorkspace(sessionId)
    const config = securityRepo.load()
    return securityPort.isPathAllowed(
      targetPath,
      mode,
      workspace,
      config.blacklist,
      config.whitelist,
    )
  }
  /**
   * 相对路径相对 workspace，绝对路径走安全校验。
   * @param inputPath
   * @param mode
   * @param sessionId
   * @returns
   */
  async resolveSafePath(
    inputPath: string,
    mode: 'r' | 'w' | 'all',
    sessionId?: string,
  ): Promise<string> {
    const workspace = await this.getWorkspace(sessionId)
    if (!workspace) {
      throw new Error('resolveSafePath: workspace 是必填参数')
    }
    if (!inputPath) return workspace

    let absolute: string
    if (
      inputPath.startsWith('/') ||
      inputPath.startsWith('\\') ||
      /^[A-Za-z]:/.test(inputPath)
    ) {
      absolute = inputPath
    } else {
      absolute =
        workspace +
        (workspace.endsWith('/') || workspace.endsWith('\\') ? '' : '/') +
        inputPath.replace(/\\/g, '/')
    }

    const config = securityRepo.load()
    const result = await securityPort.isPathAllowed(
      absolute,
      mode,
      workspace,
      config.blacklist ?? [],
      config.whitelist ?? [],
    )
    if (!result.allowed) {
      throw new Error(result.reason)
    }

    return absolute
  }

  /**
   * 初始化默认安全配置（仅首次运行时生效）
   */
  async initDefaultSecurity(): Promise<void> {
    const config = securityRepo.load()
    if (config.whitelist.length > 0 || config.blacklist.length > 0) {
      return
    }

    const platform = await getPlatform()
    const rawBlacklist = securityPort.getDefaultBlacklist(platform)
    const rawWhitelist = securityPort.getDefaultWhitelist(platform)

    // 自动将 SKILLs 目录加入白名单（只读）
    try {
      const { appDataDir } = await import('@tauri-apps/api/path')
      const appDir = (appDataDir as any)().then((d: string) =>
        d.replace(/\\/g, '/').replace(/\/+$/, ''),
      )
      rawWhitelist.push(`${await appDir}/skills`)
    } catch {
      // 非 Tauri 环境跳过
    }

    config.blacklist = [...new Set([...config.blacklist, ...rawBlacklist])]
    config.whitelist = [...new Set([...config.whitelist, ...rawWhitelist])]
    securityRepo.save(config)
  }
}

export const securityService: SecurityService = new SecurityServiceImpl()
