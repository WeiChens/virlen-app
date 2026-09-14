/**
 * telemetry/transport — 导出的传输层（§8）
 *
 * 只做「构建载荷 / 存 zip」两件事，不含埋点自身的事件记录，
 * 便于 index.ts 统一编排与记录 telemetry.* 事件。
 */
import type { TelemetryEvent } from './types'
import { SDK_VERSION } from './types'
import { getBaseAppVersion, getBasePlatform } from './common'

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

/** 构建导出载荷 */
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
