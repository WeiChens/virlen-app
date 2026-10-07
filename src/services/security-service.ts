/**
 * security-service — Application 层安全策略服务。
 * 编排安全业务流程（工作区解析 / 权限校验 / 默认配置初始化），协调 Domain(securityPort) 与
 * Infrastructure(securityRepo)；不直接访问 UI Store（securityStore）。
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
   * 「忽略沙盒命令」规则匹配（设置 → 安全）：命中 → 免除「沙盒脱壳」审批，并强制以不使用沙盒方式执行。
   *
   * ⚠️ 消费方只剩没有 Rust 可用的路径（tools/execute/*.ts、设置页「测试」、保存期的 compileSandboxRule）；
   * Rust 与 CLI 的判定在 virlen-core/src/security/（同一份 golden 契约）。匹配异常一律返 null（不脱壳）。
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
  /** 相对路径相对 workspace 拼接；绝对路径直接走安全校验。 */
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

  /** 初始化默认安全配置（仅首次运行时生效）。 */
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
