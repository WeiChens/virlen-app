import { getLocal, setLocal } from '@/utils/localStorage'
import type { SimpleRepo } from '@/infrastructure/repo'

/** 安全配置原始数据（属于 Domain 概念） */
export interface SecurityConfig {
  whitelist: string[]
  blacklist: string[]
  skipEachDirs: string[]
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
}

const STORAGE_KEY = 'virlen-security'

/** localStorage 实现 */
class SecurityRepoImpl implements SimpleRepo<SecurityConfig> {
  load(): SecurityConfig {
    return getLocal<SecurityConfig>(defaultSecurityConfig, STORAGE_KEY)
  }

  save(config: SecurityConfig): void {
    setLocal(STORAGE_KEY, config)
  }
}

export const securityRepo: SimpleRepo<SecurityConfig> = new SecurityRepoImpl()
