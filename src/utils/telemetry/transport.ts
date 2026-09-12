/**
 * telemetry/transport — 导出 / 上报的传输层（§8）
 *
 * 只做「构建载荷 / 发 HTTP / 存 zip」三件事，不含埋点自身的事件记录，
 * 便于 index.ts 统一编排与记录 telemetry.* 事件。
 */
import type { TelemetryEvent } from './types'
import { SDK_VERSION } from './types'
import { getBaseAppVersion, getBasePlatform } from './common'

/** API 基础地址（与 constants.domain 保持一致，但不依赖 UI 层） */
export const API_BASE: string =
  (import.meta as any)?.env?.VITE_API_BASE_URL || 'https://virlen.cn'

/** 批量上报接口路径 */
export const UPLOAD_PATH = '/api/public/telemetry/batch'

export interface TelemetryBundle {
  device_id: string
  app_run_id: string
  app_version: string
  platform: string
  sdk_version: string
  exported_at: number
  event_count: number
  events: TelemetryEvent[]
}

/** 构建上传/导出载荷 */
export function buildBundlePayload(
  events: TelemetryEvent[],
  ids: { deviceId: string; appRunId: string },
): TelemetryBundle {
  return {
    device_id: ids.deviceId,
    app_run_id: ids.appRunId,
    app_version: getBaseAppVersion(),
    platform: getBasePlatform(),
    sdk_version: SDK_VERSION,
    exported_at: Date.now(),
    event_count: events.length,
    events,
  }
}

export interface PostResult {
  ok: boolean
  httpStatus: number
  message: string
  bytes: number
}

/** 上报超时（毫秒）：避免网络挂起导致 uploading 永久为 true、按钮卡死 */
export const UPLOAD_TIMEOUT_MS = 15000

/** POST 批量事件到 virlen.cn */
export async function postTelemetry(body: string): Promise<PostResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(API_BASE + UPLOAD_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    let ok = res.ok
    let message = ''
    try {
      const json: any = await res.json()
      if (typeof json?.code === 'number') ok = ok && json.code === 200
      message = json?.message || ''
    } catch {
      // 非 JSON 响应
    }
    return {
      ok,
      httpStatus: res.status,
      message,
      bytes: body.length,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 保存 zip 到用户选择的路径
 * @returns 保存路径；用户取消返回 ''；失败抛错
 */
export async function saveZip(
  data: Uint8Array,
  defaultName: string,
): Promise<string> {
  // Tauri 环境：文件对话框 + 写文件
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const chosen = await save({
      defaultPath: defaultName,
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    })
    if (!chosen) return ''
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(chosen, data)
    return chosen
  } catch {
    // 浏览器降级：触发下载
    return browserDownload(data, defaultName)
  }
}

/** 浏览器环境触发文件下载（返回一个虚拟路径标识） */
function browserDownload(data: Uint8Array, fileName: string): string {
  const blob = new Blob([data as unknown as BlobPart], {
    type: 'application/zip',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return fileName
}

/** 生成默认导出文件名 */
export function defaultExportName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `virlen-telemetry-${stamp}.zip`
}
