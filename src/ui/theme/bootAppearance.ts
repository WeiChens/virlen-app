/**
 * 启动期外观缓存 —— **只为 `index.html` 里那块启动屏服务，不是设置源**。
 *
 * 为什么需要：启动屏要早于一切 JS 出现（窗口在 Rust 的 setup 里就 show），而主题色 / 深浅档
 * 的权威值在 `app_settings` 表里，要等 `hydrateSettings()` 的一次 IPC 才能读到。缓存是
 * 「上次启动已知的值」，只为把那几十到几百毫秒的「默认靛蓝 + 系统深浅」换成用户的颜色。
 *
 * 三条约束：
 * ① 权威源仍是 `app_settings`：`main.ts` 水合后一定用真值覆盖（`bootSplash.applyAppearance`），
 *    缓存只影响启动画面，任何业务读设置的路径都不碰它；
 * ② 缓存过期（用户改色后没重启）最多让下一次启动屏慢半秒跟上 —— 写入点在设置变更处，不轮询；
 * ③ ⚠️ 键名与格式被 `index.html` 的内联脚本**按字面量**读取（那边不能 import），改名必须
 *    同步那一段（`tests/boot/splash-style-contract.test.ts` 守）。
 */
import { normalizeHex } from './accentPalette'

/** 主题色缓存键（值是 `#rrggbb`；默认档不写这个键） */
export const BOOT_ACCENT_KEY = 'virlen-boot-accent'
/** 深浅档缓存键（值是 `light` / `dark`，**已解析**，不存 `system`） */
export const BOOT_THEME_KEY = 'virlen-boot-theme'

export type BootThemeMode = 'light' | 'dark'
/** 设置里的主题取值（与 `settingStore.theme` 同型） */
export type SettingsTheme = 'light' | 'dark' | 'system'

/** 系统深浅（非浏览器 / 无 matchMedia 时按亮色） */
function systemTheme(): BootThemeMode {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

/**
 * 设置里的三档 → 实际生效的两档。
 * `useTheme` 与启动屏共用这一份（别再各写一次 `theme === 'system' ? …`）。
 */
export function resolveThemeMode(theme: SettingsTheme): BootThemeMode {
  if (theme === 'system') return systemTheme()
  return theme
}

export interface BootAppearance {
  /** 品牌基色；空串 = 用内置默认（`DEFAULT_ACCENT`） */
  accent: string
  theme: BootThemeMode
}

/**
 * 读缓存。读不到 / 脏值时对应字段回落到默认（主题色空串、深浅跟系统）。
 * `localStorage` 不可用（隐私模式 / 非浏览器）一律当没有缓存。
 */
export function readBootAppearance(): BootAppearance {
  const fallback: BootAppearance = { accent: '', theme: systemTheme() }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const storedTheme = localStorage.getItem(BOOT_THEME_KEY)
    const theme: BootThemeMode =
      storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : fallback.theme
    return {
      accent: normalizeHex(localStorage.getItem(BOOT_ACCENT_KEY) ?? '') ?? '',
      theme,
    }
  } catch {
    return fallback
  }
}

/**
 * 写缓存（幂等）。写入点只有两个：设置变更（`useAccentColor` / `useTheme` 的 reaction）
 * 与启动水合完成 —— 都不在拖动预览路径上，不会把 localStorage 写爆。
 */
export function saveBootAppearance(
  accentColor: string,
  theme: SettingsTheme,
): void {
  if (typeof localStorage === 'undefined') return
  try {
    const hex = normalizeHex(accentColor)
    // 默认档（空串 / 非法值）不写键：启动屏用内置靛蓝，比留一个可能是脏值的键更稳
    if (hex) localStorage.setItem(BOOT_ACCENT_KEY, hex)
    else localStorage.removeItem(BOOT_ACCENT_KEY)
    localStorage.setItem(BOOT_THEME_KEY, resolveThemeMode(theme))
  } catch {
    // 隐私模式等：缓存写不进去就算了，启动屏退回默认色
  }
}
