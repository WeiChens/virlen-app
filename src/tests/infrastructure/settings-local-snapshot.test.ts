/**
 * 设置「不再写 localStorage」契约（S3 收尾 —— 清理回滚信道）
 *
 * 背景（详见 `docs/config-sink-plan.md` §3.6 / §5）：配置下沉（D3）后权威源是
 * Rust 侧 `app_settings` 表；localStorage 里那份 `_storage_state_virlen-settings`
 * 曾是「同步初值 + 回滚信道」。问题在于它是**整份** `settingsState.value`
 * （含 `providers[].apiKey` / `searchProviders[].apiKey` 等密钥明文）——
 * 等于密钥在库与 localStorage 各存一份（风险 R3），且容易出现「改表了但界面还是旧值」。
 *
 * 本文件钉住四件事（模拟 Tauri，与产品默认路径一致）：
 *  1. 老版本遗留的副本仍能被**同步读到**（兼容，水合前不空窗）；
 *  2. 表就绪后**删除**该副本 —— 之后 `getItem` 为 null，密钥明文不再残留；
 *  3. 此后任何设置变更都**不再写回** localStorage（`setItem` 丢弃），值只进表；
 *  4. 表读不到时**保留**副本（后端故障兜底）；非 Tauri（浏览器 dev）仍照写。
 *
 * ※ `settingsState` 是模块级单例，每个用例都要 `vi.resetModules()` 重新加载；
 *   `@tauri-apps/api/core` 的 `invoke` 已在 `src/tests/setup.ts` 里 mock。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const SETTINGS_KEY = '_storage_state_virlen-settings'

interface TauriCtx {
  store: typeof import('@/ui/store/settingStore')
  /** 收到的 upsert 载荷（按调用顺序） */
  upserts: Array<Record<string, unknown>>
  /** 收到的 import 载荷（首启导入表） */
  imports: Array<Record<string, unknown>>
}

/** 切到「模拟 Tauri」并重新加载 settingStore（表内容 = `stored`；`'db-down'` 模拟读失败） */
async function setupTauri(
  stored: Record<string, unknown> | 'db-down',
): Promise<TauriCtx> {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  vi.resetModules()
  let table: Record<string, unknown> = stored === 'db-down' ? {} : { ...stored }
  const upserts: Array<Record<string, unknown>> = []
  const imports: Array<Record<string, unknown>> = []

  const core = await import('@tauri-apps/api/core')
  vi.mocked(core.invoke).mockImplementation((async (
    cmd: string,
    args?: { entries?: Record<string, unknown> },
  ) => {
    if (cmd === 'cmd_settings_get_all') {
      if (stored === 'db-down') throw new Error('db down')
      return { ...table }
    }
    if (cmd === 'cmd_settings_upsert') {
      const entries = args?.entries ?? {}
      upserts.push(entries)
      table = { ...table, ...entries }
      return undefined
    }
    if (cmd === 'cmd_settings_import') {
      // 与 Rust 侧同语义：仅当表为空才导入，返回是否真的写入
      const entries = args?.entries ?? {}
      imports.push(entries)
      if (Object.keys(table).length > 0) return false
      table = { ...entries }
      return true
    }
    return undefined
  }) as never)

  const store = await import('@/ui/store/settingStore')
  return { store, upserts, imports }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  localStorage.clear()
  vi.resetModules()
})

describe('设置 · localStorage 不再作为权威源（S3 收尾）', () => {
  it('遗留副本可读 → 表就绪后删除 → 之后变更不再写回 localStorage', async () => {
    // 老版本遗留的整份副本（注意含密钥明文 —— 正是要清掉的东西）
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        language: 'en-US',
        providers: [{ id: 'p1', apiKey: 'sk-legacy-plaintext' }],
      }),
    )
    const { store, upserts } = await setupTauri({ language: 'zh-CN' })

    // ① 兼容读：水合前拿到的就是副本里的值（同步初值，不空窗）
    expect(store.settingsState.value.language).toBe('en-US')

    await store.hydrateSettings()

    // ② 表为准，且副本（连同密钥明文）被清掉
    expect(store.settingsState.value.language).toBe('zh-CN')
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()

    // ③ 变更只进表，不再写回 localStorage
    store.settingsState.setValue('language', 'en-US')
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()

    store.flushSettingsPersist()
    await new Promise((r) => setTimeout(r, 0))
    expect(upserts[upserts.length - 1]?.language).toBe('en-US')
  })

  it('表为空（首启）→ 本地设置整份导入表，并清掉副本', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ language: 'en-US' }))
    const { store, imports } = await setupTauri({})

    await store.hydrateSettings()

    // 首启导入走 `cmd_settings_import`（不是 upsert）
    expect(imports).toHaveLength(1)
    expect(imports[0].language).toBe('en-US')
    // 导入成功（表已就绪）→ 副本清掉
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
  })

  it('表读不到 → 保留本地副本（后端故障兜底）', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ language: 'en-US' }))
    const { store } = await setupTauri('db-down')

    await store.hydrateSettings()

    expect(store.settingsState.value.language).toBe('en-US')
    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull()
  })

  it('非 Tauri（浏览器 dev / vitest）仍写 localStorage —— 没有表可写，不能丢持久化', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'dark' }))
    vi.resetModules()
    const store = await import('@/ui/store/settingStore')

    // isAvailable() === false → hydrate 直接返回，不动 localStorage
    await store.hydrateSettings()
    expect(store.settingsState.value.theme).toBe('dark')

    // `StorageState` 的落盘是 debounce 的（1000ms）→ 用假定时器推进
    vi.useFakeTimers()
    try {
      store.settingsState.setValue('theme', 'light')
      vi.advanceTimersByTime(1200)
      expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}').theme).toBe(
        'light',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
