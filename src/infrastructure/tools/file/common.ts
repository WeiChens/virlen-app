/**
 * file — 文件操作分类公共函数（分类 id: file）
 *
 * 供本分类下的文件工具复用：
 * - read_file / write_file / edit_file / delete_file / copy_move_file
 * - list_files / file_info / mkdir
 */
import * as tauriFs from '@tauri-apps/plugin-fs'

/**
 * 格式化字节大小（B / KB / MB / GB / TB）
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * 当前是否具备 Tauri 文件系统能力。
 * 浏览器 dev / 单测环境下为 false，各工具据此返回各自的降级提示。
 */
export function isTauriFsAvailable(): boolean {
  return !!tauriFs
}

/**
 * 计算内容归一化（LF-only）后的 hash10（SHA-256 前 10 位），与 Rust 端 compute_hash10 一致
 */
export async function computeContentHash10(content: string): Promise<string> {
  // 归一化：\r\n → \n，与 Rust 端 normalize_content 保持一致
  const normalized = content.replace(/\r\n/g, '\n')
  const encoder = new TextEncoder()
  const data = encoder.encode(normalized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const full = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  // 截断为前 10 位 hex，与 Rust 端 compute_hash10 对齐
  return full.slice(0, 10)
}
