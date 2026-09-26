/**
 * settingsRepo — 应用设置的持久化 Repository（**配置下沉 D3**）
 *
 * 存储在 **Rust 侧 `app_settings` 表**（`src-tauri/virlen-core/src/session_db/settings.rs`），
 * 与会话库共用同一个 `virlen.db` —— 因此 GUI 与未来的 CLI 读写的是**同一份配置**。
 *
 * 分工（详见 `docs/config-sink-plan.md`）：
 * - `app_settings` 表：**权威源** —— 启动水合、改动回写；
 * - localStorage：**已退出**（S3 收尾）—— 不再写（Tauri 下写入被丢弃，见
 *   `ui/store/settingStore.ts` 的 `settingsLocalStorage`），仅保留「读兼容」（历史副本）
 *   供同步初值；表就绪后历史副本即被删除（`dropLegacyLocalSnapshot`）。
 *   非 Tauri（浏览器 dev / vitest）没有表可写 → 仍用 localStorage 持久化。
 *
 * ⚠️ 键名与 `SettingsStore` 字段同名同层，两侧不建映射表（避免字段漂移）。
 * 保留键以 `__` 开头（`__schemaVersion` / `__migratedFrom`），业务键不得使用该前缀。
 *
 * 非 Tauri 环境（浏览器 dev / vitest）自动降级为空实现：读回 `{}`、写入静默丢弃、不抛错。
 */
import { invoke } from '@tauri-apps/api/core'

/** 保留键前缀（Rust 侧同约定，见 `session_db/settings.rs` 文件头） */
export const RESERVED_PREFIX = '__'
/** 配置**结构**版本键（与 Rust `SETTINGS_SCHEMA_VERSION_KEY` 同名） */
export const SETTINGS_SCHEMA_VERSION_KEY = '__schemaVersion'
/** 迁移来源键（与 Rust `SETTINGS_MIGRATED_FROM_KEY` 同名） */
export const SETTINGS_MIGRATED_FROM_KEY = '__migratedFrom'
/** 当前配置结构版本（新增/改名字段时递增，并写迁移分支） */
export const SETTINGS_SCHEMA_VERSION = 1

type SettingsMap = Record<string, unknown>

export interface SettingsRepo {
  /** 是否有真实的持久化后端（非 Tauri 环境为 false） */
  isAvailable(): boolean
  /** 读取全部设置（键 → 值） */
  loadAll(): Promise<SettingsMap>
  /** 写入/覆写若干键（只动传入的键） */
  save(entries: SettingsMap): Promise<void>
  /** **仅当表为空**时导入（首启从 localStorage 迁移）；返回是否真的写入 */
  importIfEmpty(entries: SettingsMap): Promise<boolean>
}

/** Tauri 环境判定（与 `main.ts` 的引擎运行环境判定同一口径） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

class TauriSettingsRepo implements SettingsRepo {
  isAvailable(): boolean {
    return true
  }

  async loadAll(): Promise<SettingsMap> {
    return (await invoke<SettingsMap>('cmd_settings_get_all')) ?? {}
  }

  async save(entries: SettingsMap): Promise<void> {
    // 命令内部是单事务 upsert；这里不做节流（调用方已 debounce）
    await invoke('cmd_settings_upsert', { entries })
  }

  async importIfEmpty(entries: SettingsMap): Promise<boolean> {
    return await invoke<boolean>('cmd_settings_import', { entries })
  }
}

/** 非 Tauri 环境（浏览器 dev / vitest）：全部空操作，不抛错 */
class NoopSettingsRepo implements SettingsRepo {
  isAvailable(): boolean {
    return false
  }

  async loadAll(): Promise<SettingsMap> {
    return {}
  }

  async save(_entries: SettingsMap): Promise<void> {
    // 有意静默：无后端时不应打断前端自动保存
  }

  async importIfEmpty(_entries: SettingsMap): Promise<boolean> {
    return false
  }
}

const tauri = new TauriSettingsRepo()
const noop = new NoopSettingsRepo()

/** 按运行环境**每次调用现判**（测试里可切换 `window.__TAURI_INTERNALS__`） */
export const settingsRepo: SettingsRepo = {
  isAvailable: () => (isTauri() ? tauri.isAvailable() : false),
  loadAll: () => (isTauri() ? tauri.loadAll() : noop.loadAll()),
  save: (entries) => (isTauri() ? tauri.save(entries) : noop.save(entries)),
  importIfEmpty: (entries) =>
    isTauri() ? tauri.importIfEmpty(entries) : noop.importIfEmpty(entries),
}

/**
 * 从表里读回的键值中**挑出 `SettingsStore` 认识的键**（纯函数）。
 *
 * 过滤三类：保留键（`__` 前缀）、未知键（前端已删除的设置项）、`undefined`。
 * 目的是让「表里有历史遗留键」不会污染 store —— 新增设置项时无需清库。
 */
export function pickKnownSettings(
  stored: SettingsMap,
  knownKeys: Iterable<string>,
): SettingsMap {
  const known = new Set(knownKeys)
  const out: SettingsMap = {}
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (key.startsWith(RESERVED_PREFIX)) continue
    if (!known.has(key)) continue
    if (value === undefined) continue
    out[key] = value
  }
  return out
}
