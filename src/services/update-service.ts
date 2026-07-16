/**
 * update-service — 版本更新检查服务
 *
 * 调用后端 API POST /api/public/versions/check-update 检查更新，
 * 供桌面客户端启动时或手动检查更新使用。
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
