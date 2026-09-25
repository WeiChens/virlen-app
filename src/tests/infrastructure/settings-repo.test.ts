/**
 * settingsRepo 契约测试（配置下沉 D3）
 *
 * 钉住四件事：
 *  1. 非 Tauri 环境（浏览器 dev / vitest）**自动降级为空实现**，不抛错、不写盘；
 *  2. Tauri 环境的命令名与载荷形状（`cmd_settings_get_all` / `cmd_settings_upsert` / `cmd_settings_import`）；
 *  3. `pickKnownSettings` 的过滤规则（保留键 / 未知键 / `undefined`）；
 *  4. 保留键常量与 Rust 侧同名（`session_db/settings.rs`），避免两侧各写一套字面量。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  pickKnownSettings,
  RESERVED_PREFIX,
  settingsRepo,
  SETTINGS_MIGRATED_FROM_KEY,
  SETTINGS_SCHEMA_VERSION_KEY,
} from '@/infrastructure/settingsRepo'

/** 切换「是否处于 Tauri 环境」（`settingsRepo` 每次调用现判，故此开关生效） */
function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>
  if (on) w.__TAURI_INTERNALS__ = {}
  else delete w.__TAURI_INTERNALS__
}

afterEach(() => {
  setTauri(false)
  vi.mocked(invoke).mockReset()
})

describe('非 Tauri 环境（空实现）', () => {
  it('isAvailable=false 且读回空对象、写入不抛错', async () => {
    setTauri(false)
    expect(settingsRepo.isAvailable()).toBe(false)
    await expect(settingsRepo.loadAll()).resolves.toEqual({})
    await expect(settingsRepo.save({ language: 'en-US' })).resolves.toBeUndefined()
    await expect(settingsRepo.importIfEmpty({ language: 'en-US' })).resolves.toBe(false)
    // 只断言「没有触碰 settings 命令」：同环境下其它模块（如取平台名）可能也调 invoke
    const settingsCalls = vi
      .mocked(invoke)
      .mock.calls.map((c) => String(c[0]))
      .filter((name) => name.startsWith('cmd_settings_'))
    expect(settingsCalls).toEqual([])
  })
})

describe('Tauri 环境（Rust app_settings 表）', () => {
  it('loadAll → cmd_settings_get_all，null 兜底为空对象', async () => {
    setTauri(true)
    expect(settingsRepo.isAvailable()).toBe(true)

    vi.mocked(invoke).mockResolvedValueOnce({ language: 'en-US' } as never)
    await expect(settingsRepo.loadAll()).resolves.toEqual({ language: 'en-US' })
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('cmd_settings_get_all')

    vi.mocked(invoke).mockResolvedValueOnce(null as never)
    await expect(settingsRepo.loadAll()).resolves.toEqual({})
  })

  it('save → cmd_settings_upsert，载荷为 { entries }', async () => {
    setTauri(true)
    vi.mocked(invoke).mockResolvedValueOnce(undefined as never)
    await settingsRepo.save({ sandboxMode: 'readonly' })
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('cmd_settings_upsert', {
      entries: { sandboxMode: 'readonly' },
    })
  })

  it('importIfEmpty → cmd_settings_import，透传 Rust 的布尔结果', async () => {
    setTauri(true)
    vi.mocked(invoke).mockResolvedValueOnce(true as never)
    await expect(settingsRepo.importIfEmpty({ language: 'zh-CN' })).resolves.toBe(true)
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith('cmd_settings_import', {
      entries: { language: 'zh-CN' },
    })
  })
})

describe('pickKnownSettings（表值 → store）', () => {
  const known = ['language', 'sandboxMode', 'permissions']

  it('保留已知键，丢弃保留键 / 未知键 / undefined', () => {
    const out = pickKnownSettings(
      {
        language: 'en-US',
        sandboxMode: 'on',
        permissions: { 'terminal.normal.execute': 'ask' },
        // 下面三项都应被丢弃
        [SETTINGS_SCHEMA_VERSION_KEY]: 1,
        [SETTINGS_MIGRATED_FROM_KEY]: 'localStorage',
        removedSetting: true,
        maxTokens: undefined,
      },
      known,
    )
    expect(out).toEqual({
      language: 'en-US',
      sandboxMode: 'on',
      permissions: { 'terminal.normal.execute': 'ask' },
    })
  })

  it('空值 / null 输入不抛错', () => {
    expect(pickKnownSettings({}, known)).toEqual({})
    expect(
      pickKnownSettings(null as unknown as Record<string, unknown>, known),
    ).toEqual({})
  })
})

describe('保留键约定', () => {
  it('保留键以 __ 开头（与 Rust 侧一致）', () => {
    expect(RESERVED_PREFIX).toBe('__')
    expect(SETTINGS_SCHEMA_VERSION_KEY.startsWith(RESERVED_PREFIX)).toBe(true)
    expect(SETTINGS_MIGRATED_FROM_KEY.startsWith(RESERVED_PREFIX)).toBe(true)
  })
})
