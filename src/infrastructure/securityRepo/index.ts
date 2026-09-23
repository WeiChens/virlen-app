import { getLocal, setLocal } from '@/utils/localStorage'
import type { SimpleRepo } from '@/infrastructure/repo'
import type { SandboxIgnoreRule } from '@/domain/security/sandbox-ignore-rules'

/** 安全配置原始数据（属于 Domain 概念） */
export interface SecurityConfig {
  whitelist: string[]
  blacklist: string[]
  skipEachDirs: string[]
  /**
   * 「忽略沙盒命令」规则：命中的命令免除「沙盒脱壳」审批
   * （匹配逻辑见 `@/domain/security/sandbox-ignore-rules`）
   */
  sandboxIgnoreRules: SandboxIgnoreRule[]
}

export const defaultSecurityConfig: SecurityConfig = {
  whitelist: [],
  blacklist: [],
  skipEachDirs: [
    'node_modules',
    '.git',
    'dist',
    '.next',
    'build',
    '.cache',
    'target',
  ],
  sandboxIgnoreRules: [],
}

const STORAGE_KEY = 'virlen-security'

/** localStorage 实现 */
class SecurityRepoImpl implements SimpleRepo<SecurityConfig> {
  load(): SecurityConfig {
    const raw = getLocal<SecurityConfig>(defaultSecurityConfig, STORAGE_KEY)
    // ⚠️ getLocal 只做「整体」回退，不做字段级合并：老用户的存量配置没有新字段，
    //    这里统一补默认值（sandboxIgnoreRules 缺失时为空数组，而非 undefined）。
    return {
      ...defaultSecurityConfig,
      ...raw,
      sandboxIgnoreRules: Array.isArray(raw?.sandboxIgnoreRules)
        ? raw.sandboxIgnoreRules
        : [],
    }
  }

  save(config: SecurityConfig): void {
    setLocal(STORAGE_KEY, config)
  }
}

export const securityRepo: SimpleRepo<SecurityConfig> = new SecurityRepoImpl()
