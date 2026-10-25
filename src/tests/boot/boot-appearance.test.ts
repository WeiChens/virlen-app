// @vitest-environment node
/**
 * 启动期外观缓存（`src/ui/theme/bootAppearance.ts`）的契约。
 *
 * 它只服务 `index.html` 里那块启动屏，但**索引键名与 index.html 的内联脚本是硬约定**
 * （那边不能 import，只能按字面量读），所以两件事必须一起守：
 * ① 读写的四类输入（正常 / 空串 / 脏值 / 缺键）都要回落到「内置靛蓝 + 系统深浅」；
 * ② 键名与 index.html 一致（`tests/boot/splash-style-contract.test.ts` 比字面量）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  BOOT_ACCENT_KEY,
  BOOT_THEME_KEY,
  readBootAppearance,
  resolveThemeMode,
  saveBootAppearance,
} from '@/ui/theme/bootAppearance'

beforeEach(() => {
  localStorage.clear()
})

describe('启动期外观缓存', () => {
  it('保存后能原样读回（主题色归一化成小写 #rrggbb）', () => {
    saveBootAppearance('#9333EA', 'dark')
    expect(readBootAppearance()).toEqual({ accent: '#9333ea', theme: 'dark' })
  })

  it('默认档（空串）不写 accent 键：启动屏回落到内置靛蓝', () => {
    saveBootAppearance('', 'light')
    expect(localStorage.getItem(BOOT_ACCENT_KEY)).toBeNull()
    expect(readBootAppearance()).toEqual({ accent: '', theme: 'light' })
  })

  it('非法颜色按默认档处理，不留一个脏键给下次启动', () => {
    localStorage.setItem(BOOT_ACCENT_KEY, 'not-a-color')
    saveBootAppearance('also-not-a-color', 'light')
    expect(localStorage.getItem(BOOT_ACCENT_KEY)).toBeNull()
    expect(readBootAppearance().accent).toBe('')
  })

  it('缺键 / 脏主题值回落到「无主题色 + 系统深浅」', () => {
    localStorage.setItem(BOOT_THEME_KEY, 'blue')
    const appearance = readBootAppearance()
    expect(appearance.accent).toBe('')
    expect(['light', 'dark']).toContain(appearance.theme)
  })

  it('system 档存的是**解析后**的两档（启动屏不需要再判断系统深浅）', () => {
    saveBootAppearance('#4f46e5', 'system')
    expect(localStorage.getItem(BOOT_THEME_KEY)).toBe(resolveThemeMode('system'))
  })

  it('强制档不被系统深浅影响', () => {
    expect(resolveThemeMode('light')).toBe('light')
    expect(resolveThemeMode('dark')).toBe('dark')
  })
})
