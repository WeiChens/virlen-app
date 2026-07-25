/**
 * update-service — 版本更新检查服务
 *
 * 调用后端 API POST /api/public/versions/check-update 检查更新，
 * 供桌面客户端启动时或手动检查更新使用。
 *
 * 支持「忽略当前版本」和「7日内不再提示」两种用户偏好。
 */
import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { domain } from '@/ui/constants'
import type {
  ICheckUpdateRequest,
  ICheckUpdateResponse,
  IApiResponse,
  UpdatePlatform,
} from '@/types'

/** localStorage 键名 */
const STORAGE_KEY_IGNORED_VERSION = 'virlen_ignored_version'
const STORAGE_KEY_SNOOZE_UNTIL = 'virlen_update_snooze_until'

/** 7 天的毫秒数 */
const SNOOZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 设置被忽略的版本号（用户点击「忽略当前版本」时调用）
 */
export function setIgnoredVersion(version: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_IGNORED_VERSION, version)
  } catch {
    // localStorage 不可用时静默失败
  }
}

/**
 * 获取被忽略的版本号
 */
export function getIgnoredVersion(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_IGNORED_VERSION)
  } catch {
    return null
  }
}

/**
 * 设置 7 日内不再提示（记录当前时间 + 7 天的时间戳）
 */
export function setSnooze(): void {
  try {
    const snoozeUntil = Date.now() + SNOOZE_DURATION_MS
    localStorage.setItem(STORAGE_KEY_SNOOZE_UNTIL, String(snoozeUntil))
  } catch {
    // localStorage 不可用时静默失败
  }
}

/**
 * 获取免打扰到期时间戳，如果已过期则返回 null
 */
export function getSnoozeUntil(): number | null {
  try {
    const val = localStorage.getItem(STORAGE_KEY_SNOOZE_UNTIL)
    if (!val) return null
    const snoozeUntil = Number(val)
    if (isNaN(snoozeUntil)) return null
    // 如果已过期，清理并返回 null
    if (Date.now() >= snoozeUntil) {
      localStorage.removeItem(STORAGE_KEY_SNOOZE_UNTIL)
      return null
    }
    return snoozeUntil
  } catch {
    return null
  }
}

/**
 * 判断是否应该显示更新弹窗
 *
 * 检查逻辑：
 * 1. 如果最新版本已被用户忽略 → 不弹窗
 * 2. 如果用户设置了 7 日免打扰且尚未到期 → 不弹窗
 * 3. 否则 → 弹窗
 */
export function shouldShowUpdate(updateInfo: ICheckUpdateResponse): boolean {
  const latestVersion = updateInfo.latest_version?.version
  if (!latestVersion) return false

  // 检查是否被用户忽略
  const ignoredVersion = getIgnoredVersion()
  if (ignoredVersion === latestVersion) {
    console.log(`[UpdateService] 版本 ${latestVersion} 已被用户忽略，跳过弹窗`)
    return false
  }

  // 检查 7 日免打扰
  const snoozeUntil = getSnoozeUntil()
  if (snoozeUntil !== null) {
    const remainingDays = Math.ceil((snoozeUntil - Date.now()) / (1000 * 60 * 60 * 24))
    console.log(`[UpdateService] 免打扰还剩 ${remainingDays} 天，跳过弹窗`)
    return false
  }

  return true
}

/** Tauri Rust 返回的平台名映射到 API 平台名 */
const PLATFORM_MAP: Record<string, UpdatePlatform> = {
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
  android: 'android',
  ios: 'ios',
}

/**
 * 获取当前操作系统平台
 */
async function getPlatform(): Promise<UpdatePlatform> {
  try {
    const platform = await invoke<string>('os_platform')
    return PLATFORM_MAP[platform] || 'windows'
  } catch {
    // 降级：通过 UserAgent 判断
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('win')) return 'windows'
    if (ua.includes('mac')) return 'macos'
    if (ua.includes('linux')) return 'linux'
    return 'windows'
  }
}

/**
 * 检查更新
 *
 * @returns 检查结果，如果网络错误或 API 不可用则返回 null
 */
export async function checkUpdate(): Promise<ICheckUpdateResponse | null> {
  try {
    const [currentVersion, platform] = await Promise.all([
      getVersion(),
      getPlatform(),
    ])

    const body: ICheckUpdateRequest = {
      platform,
      current_version: currentVersion,
    }

    const apiUrl = `${domain}/api/public/versions/check-update`

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      console.warn(`[UpdateService] 检查更新失败: HTTP ${response.status}`)
      return null
    }

    const result: IApiResponse<ICheckUpdateResponse> = await response.json()

    if (result.code !== 200 || !result.data) {
      console.warn(`[UpdateService] 检查更新失败: ${result.message}`)
      return null
    }

    return result.data
  } catch (err) {
    console.warn('[UpdateService] 检查更新出错:', err)
    return null
  }
}
