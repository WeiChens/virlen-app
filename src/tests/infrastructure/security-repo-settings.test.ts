/**
 * securityRepo · 「忽略沙盒命令」规则的**单一源**（Rust `app_settings` 表）契约
 *
 * S7 起规则只存 Rust 侧 `app_settings`（键 `sandboxIgnoreRules`），localStorage 不再保存
 * —— 默认引擎（Rust）与 CLI 读的是同一份，判定在 `src-tauri/virlen-core/src/security/`。
 *
 * 这里钉住 4 件容易被改坏的事（**模拟 Tauri** 环境，与产品默认路径一致）：
 *  1. 表里有规则 → `load()` 返回表值，且 localStorage 里的规则字段被清掉；
 *  2. 表里没有该键 → 一次性迁移 localStorage 的历史副本进表（老用户升级无感）；
 *  3. 表里是**空数组** → 视为「已清空」，**不**被迁回
 *     （旧的「键缺失就迁回」写法会让用户觉得「还是以 localStorage 为准」）；
 *  4. `save()` → 规则只进表；localStorage 里不再出现规则字段。
 *
 * ※ 模块级状态（内存快照 / 落库 debounce）要求每个用例重新加载模块；
 *   `@tauri-apps/api/core` 的 `invoke` 已在 `src/tests/setup.ts` 里 mock。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SandboxIgnoreRule } from '@/domain/security/sandbox-ignore-rules'

const STORAGE_KEY = 'virlen-security'

interface TauriCtx {
  repo: typeof import('@/infrastructure/securityRepo')
  /** 收到的 upsert 载荷（按调用顺序） */
  upserts: Array<Record<string, unknown>>
}

/** 切到「模拟 Tauri」并重新加载被测模块（表内容 = `stored`） */
async function setupTauri(stored: Record<string, unknown>): Promise<TauriCtx> {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  vi.resetModules()
  let table = { ...stored }
  const upserts: Array<Record<string, unknown>> = []

  const core = await import('@tauri-apps/api/core')
  vi.mocked(core.invoke).mockImplementation((async (
    cmd: string,
    args?: { entries?: Record<string, unknown> },
  ) => {
    if (cmd === 'cmd_settings_get_all') return { ...table }
    if (cmd === 'cmd_settings_upsert') {
      const entries = args?.entries ?? {}
      upserts.push(entries)
      table = { ...table, ...entries }
      return undefined
    }
    if (cmd === 'cmd_settings_import') return false
    return undefined
  }) as never)

  const repo = await import('@/infrastructure/securityRepo')
  return { repo, upserts }
}

/** 读 localStorage 里的原始安全配置对象 */
function localRaw(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
}

/** 造一条最小可用规则（只关心 id） */
function rule(id: string): SandboxIgnoreRule {
  return {
    id,
    name: id,
    enabled: true,
    kind: 'text',
    pattern: 'x',
    caseSensitive: false,
    textMode: 'exact',
  } as SandboxIgnoreRule
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  localStorage.clear()
  vi.resetModules()
})

describe('securityRepo · 规则单一源（app_settings）', () => {
  it('表里有规则 → load() 返回表值，且清掉 localStorage 里的规则字段', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ whitelist: ['C:/w'], sandboxIgnoreRules: [rule('stale')] }),
    )
    const t = await setupTauri({ sandboxIgnoreRules: [rule('from-table')] })

    await t.repo.hydrateSecurity()

    const cfg = t.repo.securityRepo.load()
    expect(cfg.sandboxIgnoreRules.map((r) => r.id)).toEqual(['from-table'])
    // 路径配置仍来自 localStorage
    expect(cfg.whitelist).toEqual(['C:/w'])
    // 单一源：本地不再保留规则副本
    expect('sandboxIgnoreRules' in localRaw()).toBe(false)
    expect(t.upserts).toHaveLength(0)
  })

  it('表里没有该键 → 把 localStorage 存量迁进表，并清掉本地副本', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sandboxIgnoreRules: [rule('legacy')] }),
    )
    const t = await setupTauri({ language: 'zh-CN' })

    await t.repo.hydrateSecurity()

    expect(t.upserts).toHaveLength(1)
    expect(t.upserts[0].sandboxIgnoreRules).toEqual([rule('legacy')])
    expect('sandboxIgnoreRules' in localRaw()).toBe(false)
    expect(t.repo.securityRepo.load().sandboxIgnoreRules.map((r) => r.id)).toEqual([
      'legacy',
    ])
  })

  it('表里是空数组 → 视为「已清空」，不被迁回', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sandboxIgnoreRules: [rule('stale')] }),
    )
    const t = await setupTauri({ sandboxIgnoreRules: [] })

    await t.repo.hydrateSecurity()

    expect(t.upserts).toHaveLength(0)
    expect(t.repo.securityRepo.load().sandboxIgnoreRules).toEqual([])
    expect('sandboxIgnoreRules' in localRaw()).toBe(false)
  })

  it('save() → 规则只进表；localStorage 里不出现规则字段', async () => {
    const t = await setupTauri({ sandboxIgnoreRules: [] })
    await t.repo.hydrateSecurity()

    t.repo.securityRepo.save({
      whitelist: ['C:/w'],
      blacklist: [],
      skipEachDirs: [],
      sandboxIgnoreRules: [rule('x')],
    })
    t.repo.flushSecurityPersist()
    // 落库是异步的（settingsRepo.save 返回 Promise）
    await new Promise((r) => setTimeout(r, 0))

    const last = t.upserts[t.upserts.length - 1]
    expect(last?.sandboxIgnoreRules).toEqual([rule('x')])
    expect(localRaw().whitelist).toEqual(['C:/w'])
    expect('sandboxIgnoreRules' in localRaw()).toBe(false)
    // 内存快照即时更新 → 同一进程内 load() 立刻可见
    expect(t.repo.securityRepo.load().sandboxIgnoreRules.map((r) => r.id)).toEqual(['x'])
  })

  it('securityStore.hydrate() 刷新 observable —— 设置页拿到的是表值', async () => {
    // 本地镜像里放一条「旧值」：修复前 UI 读到它就是这条（看起来「还是 localStorage」）
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sandboxIgnoreRules: [rule('stale-local')] }),
    )
    const t = await setupTauri({ sandboxIgnoreRules: [rule('from-table')] })
    const { securityStore } = await import('@/ui/store/securityStore')

    // hydrate 之前：Tauri 下 `load()` 只认内存快照（还没读表）→ 空
    expect(securityStore.sandboxIgnoreRules).toEqual([])

    await securityStore.hydrate()

    expect(securityStore.sandboxIgnoreRules.map((r) => r.id)).toEqual(['from-table'])
    expect('sandboxIgnoreRules' in localRaw()).toBe(false)
    // setup 返回值未用（只为重置模块 + 注入表内容）
    expect(t.repo.securityRepo.load().sandboxIgnoreRules.map((r) => r.id)).toEqual([
      'from-table',
    ])
  })
})
