/**
 * 安全配置持久化。规则**唯一权威源是 Rust app_settings 表**（GUI / CLI 共用，判定在 virlen-core），
 * 路径配置仍存 localStorage（同步读 → 首帧不闪空）；非 Tauri 环境整体降级为 localStorage。
 * ⚠️ 规则匹配两份实现（`virlen-core/src/security/rules.rs` ↔ `domain/security/sandbox-ignore-rules`），
 * 由 `tests/fixtures/sandbox-rules.golden.json` 收敛。
 */
import { getLocal, setLocal } from '@/utils/localStorage'
import type { SimpleRepo } from '@/infrastructure/repo'
import type { SandboxIgnoreRule } from '@/domain/security/sandbox-ignore-rules'
import { settingsRepo } from '@/infrastructure/settingsRepo'

/** 安全配置原始数据（属于 Domain 概念） */
export interface SecurityConfig {
  whitelist: string[]
  blacklist: string[]
  skipEachDirs: string[]
  /**
   * 「忽略沙盒命令」规则：命中则免去脱壳审批。不在 localStorage，启动 hydrate 进 `rulesSnapshot`，
   * 改动 debounce 回写（退出前 `flushSecurityPersist()` 补一次）。
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
/** 规则在 `app_settings` 里的键名（与字段同名同层，两侧不建映射表） */
export const SANDBOX_RULES_SETTINGS_KEY = 'sandboxIgnoreRules'
/** 落库 debounce：连续拖拽排序 / 连点开关只写一次 */
const RULES_SAVE_DEBOUNCE_MS = 400

/**
 * 规则的内存权威快照（仅 Tauri）：`null` = 尚未读过，`[]` = 表里就是空的。
 * `load()` 是同步接口（首帧要能用），故表的异步结果落在这里。
 */
let rulesSnapshot: SandboxIgnoreRule[] | null = null

/** 待落库的规则（仅在 Tauri 环境累积） */
let pendingRules: SandboxIgnoreRule[] | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 只从 localStorage 读三个路径配置（规则不在 localStorage） */
function readLocalPaths(): Pick<
  SecurityConfig,
  'whitelist' | 'blacklist' | 'skipEachDirs'
> {
  const raw = getLocal<Partial<SecurityConfig> | null>(null, STORAGE_KEY)
  const pick = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) ? (v as string[]) : [...fallback]
  return {
    whitelist: pick(raw?.whitelist, defaultSecurityConfig.whitelist),
    blacklist: pick(raw?.blacklist, defaultSecurityConfig.blacklist),
    skipEachDirs: pick(raw?.skipEachDirs, defaultSecurityConfig.skipEachDirs),
  }
}

/** localStorage 里可能残留的规则副本：非 Tauri 环境的正常存储 / 下沉前的历史数据（一次性迁移）。 */
function readLocalRules(): SandboxIgnoreRule[] {
  const raw = getLocal<Partial<SecurityConfig> | null>(null, STORAGE_KEY)
  return Array.isArray(raw?.sandboxIgnoreRules)
    ? (raw.sandboxIgnoreRules as SandboxIgnoreRule[])
    : []
}

/** 从 localStorage 摘掉规则字段（单一源：规则只归表） */
function stripRulesFromLocal(): void {
  const raw = getLocal<Record<string, unknown> | null>(null, STORAGE_KEY)
  if (!raw || typeof raw !== 'object') return
  if (!(SANDBOX_RULES_SETTINGS_KEY in raw)) return
  const next = { ...raw }
  delete next[SANDBOX_RULES_SETTINGS_KEY]
  setLocal(STORAGE_KEY, next)
}

class SecurityRepoImpl implements SimpleRepo<SecurityConfig> {
  load(): SecurityConfig {
    const paths = readLocalPaths()
    if (!settingsRepo.isAvailable()) {
      // 非 Tauri：没有表 → 规则仍由 localStorage 承载（dev 可用性优先）
      return { ...paths, sandboxIgnoreRules: readLocalRules() }
    }
    // Tauri：规则只认内存快照（来自表）；hydrate 之前为空
    return { ...paths, sandboxIgnoreRules: rulesSnapshot ?? [] }
  }

  save(config: SecurityConfig): void {
    const rules = Array.isArray(config.sandboxIgnoreRules)
      ? config.sandboxIgnoreRules
      : []

    if (!settingsRepo.isAvailable()) {
      // 非 Tauri（浏览器 dev / vitest）：没有表可写 → 保持 localStorage 持久化
      setLocal(STORAGE_KEY, { ...config, sandboxIgnoreRules: rules })
      return
    }

    // Tauri：规则**只进表** —— localStorage 只留路径配置（避免出现第二份权威）
    const { sandboxIgnoreRules: _omitted, ...paths } = config
    setLocal(STORAGE_KEY, paths)
    rulesSnapshot = rules
    pendingRules = rules
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSecurityPersist, RULES_SAVE_DEBOUNCE_MS)
  }
}

export const securityRepo: SimpleRepo<SecurityConfig> = new SecurityRepoImpl()

/** 把待写规则立刻落库（debounce 到期 / 退出前调用） */
export function flushSecurityPersist(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const rules = pendingRules
  pendingRules = null
  if (rules === null) return
  settingsRepo.save({ [SANDBOX_RULES_SETTINGS_KEY]: rules }).catch((e) => {
    console.warn('[security] 写入 Rust 侧 app_settings 的忽略沙盒规则失败:', e)
  })
}

/**
 * 启动时同步规则（幂等；非 Tauri 直接返回）：表里有该键 → 以表为准，没有 → 一次性迁移 localStorage 副本；
 * 两分支随后都清除 localStorage 的规则字段，避免「删了表里的行又被迁回」。
 */
export async function hydrateSecurity(): Promise<void> {
  if (!settingsRepo.isAvailable()) return
  try {
    const stored = await settingsRepo.loadAll()
    const fromTable = stored[SANDBOX_RULES_SETTINGS_KEY]
    if (Array.isArray(fromTable)) {
      rulesSnapshot = fromTable as SandboxIgnoreRule[]
    } else {
      // 表里没有 → 迁一次存量（历史数据仍可能躺在 localStorage 里）
      rulesSnapshot = readLocalRules()
      await settingsRepo.save({ [SANDBOX_RULES_SETTINGS_KEY]: rulesSnapshot })
    }
    stripRulesFromLocal()
  } catch (e) {
    // 表读不到（后端不可用等）→ 降级用本地副本，规则不至于整段失效
    rulesSnapshot = readLocalRules()
    console.warn(
      '[security] 读取 Rust 侧 app_settings 的忽略沙盒规则失败，继续使用本地副本:',
      e,
    )
  }
}
