/**
 * download-service — 下载并启动安装包
 *
 * 使用浏览器原生 fetch 流式下载（支持实时进度），
 * 下载完成后通过 invoke 传给 Rust 写入磁盘，
 * 最后启动安装包。
 */
import { invoke } from '@tauri-apps/api/core'
import { downloadDir, tempDir } from '@tauri-apps/api/path'

export type DownloadStatus = 'idle' | 'downloading' | 'done' | 'error'

export interface DownloadProgress {
  status: DownloadStatus
  /** 已下载字节数 */
  loaded: number
  /** 总字节数（0 表示未知） */
  total: number
  /** 进度百分比（0~100） */
  percent: number
  /** 错误信息 */
  error?: string
  /** 下载完成后的文件路径 */
  filePath?: string
}

export type ProgressCallback = (progress: DownloadProgress) => void

/**
 * 从 URL 下载文件并保存到下载目录
 *
 * @param url 下载链接
 * @param fileName 保存的文件名
 * @param onProgress 进度回调
 * @returns 最终保存的完整文件路径
 */
export async function downloadAndInstall(
  url: string,
  fileName: string,
  onProgress: ProgressCallback,
): Promise<string> {
  // 确定保存路径
  let dir: string
  try {
    dir = await downloadDir()
  } catch {
    dir = await tempDir()
  }
  const filePath = `${dir}/${fileName}`

  // 初始状态
  onProgress({ status: 'downloading', loaded: 0, total: 0, percent: 0 })

  // === 浏览器原生 fetch 流式下载 ===
  let response: Response
  try {
    response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
  } catch (err: any) {
    const errorMsg = `下载失败: ${err.message || err}`
    onProgress({ status: 'error', loaded: 0, total: 0, percent: 0, error: errorMsg })
    throw new Error(errorMsg)
  }

  const contentLength = response.headers.get('Content-Length')
  const total = contentLength ? parseInt(contentLength, 10) : 0

  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      chunks.push(value)
      loaded += value.length

      onProgress({
        status: 'downloading',
        loaded,
        total,
        percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
      })
    }
  } catch (err: any) {
    const errorMsg = `下载中断: ${err.message || err}`
    onProgress({
      status: 'error',
      loaded, total,
      percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
      error: errorMsg,
    })
    throw new Error(errorMsg)
  }

  // === 合并分片为单个 Uint8Array ===
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const fullBuffer = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    fullBuffer.set(chunk, offset)
    offset += chunk.length
  }

  // === 通过 invoke 传给 Rust 写入磁盘 ===
  try {
    await invoke('save_file_to_path', { buffer: fullBuffer, path: filePath })
  } catch (err: any) {
    const errorMsg = `文件保存失败: ${err?.message || err || '未知错误'}`
    onProgress({ status: 'error', loaded: totalLength, total: totalLength, percent: 100, error: errorMsg })
    throw new Error(errorMsg)
  }

  // 完成
  onProgress({ status: 'done', loaded: totalLength, total: totalLength, percent: 100, filePath })
  return filePath
}

/**
 * 运行安装包
 *
 * @param filePath 安装包路径
 */
export async function launchInstaller(filePath: string): Promise<void> {
  try {
    const { openPath } = await import('@tauri-apps/plugin-opener')
    await openPath(filePath)
  } catch (err: any) {
    console.error('[DownloadService] 启动安装包失败:', err)
    throw err
  }
}
