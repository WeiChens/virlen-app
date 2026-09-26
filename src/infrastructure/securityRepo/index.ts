/**
 * securityRepo — 安全配置的持久化 Repository
 *
 * 存储分工（配置下沉 D3，详见 `docs/config-sink-plan.md`）：
 * - **「忽略沙盒命令」规则**（`sandboxIgnoreRules`）：
 *   **唯一权威源是 Rust 侧 `app_settings` 表**（同一个 `virlen.db`）——
 *   GUI（默认 Rust 引擎）与 CLI 读写同一份，判定在 `src-tauri/virlen-core/src/security/`，
 *   因此不需要「问 JS」（原内部交互 `sandbox_rule_check` 已删除）。
 *   localStorage 不保存该字段：只在浏览器 dev / 非 Tauri 环境降级使用（见下）。
 * - **路径配置**（whitelist / blacklist / skipEachDirs）：仍存 localStorage
 *   （同步读 → 首帧不闪空）。
 *
 * 启动同步（`hydrateSecurity`，幂等，`main.ts` 在窗口显示前调用）：
 * 1. 表里**有**该键 → 读进内存快照（`rulesSnapshot`）；
 * 2. 表里**没有** → 一次性迁移：把 localStorage 的历史副本写进表（老用户升级无感）。
 * 两条分支都会清掉 localStorage 里的规则字段 —— 因此「删掉表里的行」= 真正清空规则，
 * 不会被下一次启动迁回。
 *
 * ⚠️ 规则匹配有两份实现，由 golden 契约收敛（`src/tests/fixtures/sandbox-rules.golden.json`）：
 * - Rust + CLI：`src-tauri/virlen-core/src/security/rules.rs`（text / regex 原生 + js 内嵌 QuickJS）；
 * - 浏览器 dev / 设置页「测试」：`@/domain/security/sandbox-ignore-rules`。
 *
 * 非 Tauri 环境（浏览器 dev / vitest）：没有表可写 → 整体降级为 localStorage 持久化，
 * 保证 `pnpm dev` 下该功能仍可用（与配置下沉前的行为一致）。
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
   * 「忽略沙盒命令」规则：命中的命令免除「沙盒脱壳」审批（匹配逻辑见上）。
   *
   * 权威源是 `app_settings` 的 `sandboxIgnoreRules` 键（**不在 localStorage**）；
   * 由 `hydrateSecurity()` 在启动时读进内存快照，改动 debounce 回写
   * （退出前 `flushSecurityPersist()` 补一次）。
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
 * 规则的内存权威快照（仅 Tauri 环境使用）。
 *
 * `null` = 尚未从表里读过；`[]` = 表里就是空的（**不是**「还没读」）。
 * `load()` 是同步接口（首帧要能用），所以表的异步读取结果落在这里。
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

/**
 * localStorage 里可能残留的规则副本。
 *
 * 只要两处：① 非 Tauri（dev）环境的正常存储；② 下沉前的历史数据（一次性迁移用）。
 * Tauri 环境在 `hydrateSecurity()` 之后会被清掉。
 */
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
 * 启动时同步「忽略沙盒命令」规则（幂等；非 Tauri 环境直接返回）。
 *
 * 1. 表里**已有**该键 → 表为准（CLI 改过的规则在 GUI 里立即生效）；
 * 2. 表里**没有**该键 → 一次性迁移：把 localStorage 的历史副本写进表。
 *
 * 两者随后都清掉 localStorage 的规则字段，避免「删了表里的行又被迁回」。
 *
 * 消费方是 `securityStore.hydrate()`（`main.ts` 的 `securityConfig` 步骤），它还会刷新
 * store 的 observable，让设置页立即展示表里的值。
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
