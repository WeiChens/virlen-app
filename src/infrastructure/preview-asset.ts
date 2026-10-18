/**
 * HTML 预览的本地资源通道（Rust 自定义协议 `virlen-preview`）。
 *
 * 前端只做三件事：登记 token、拼协议 URL、撤销。
 * ⚠️ 安全闸（token / 路径 / 类型 / 大小 / 并发）**全在 Rust**（`src-tauri/src/commands/preview.rs`）；
 * 这里不做任何「路径修正」—— 前端越聪明，越容易把校验绕过去。
 */
import { invoke } from '@tauri-apps/api/core'

/** 必须与 Rust `preview::SCHEME` 逐字一致 */
export const PREVIEW_SCHEME = 'virlen-preview'

/**
 * Windows / Android 的 Tauri 自定义协议是 `http://<scheme>.localhost/...`，
 * 其他平台是 `<scheme>://localhost/...`（Tauri 2 的既定形态）。
 */
function isWindowsLike(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Windows|Android/i.test(navigator.userAgent)
}

/** token（+ 文件所在的子目录）→ 协议基址（末尾带 `/`，`<base href>` 可直接拼相对路径） */
export function previewBaseUrl(token: string, relativeDir = ''): string {
  // 逐段编码：目录名里可能有空格 / 中文，`?` `#` 不编码会被当成 query / fragment
  // （协议侧 `decode_relative` 会先去掉 query，再逐段校验）
  const dir = relativeDir
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const prefix = isWindowsLike()
    ? `http://${PREVIEW_SCHEME}.localhost/`
    : `${PREVIEW_SCHEME}://localhost/`
  return `${prefix}${token}/${dir ? `${dir}/` : ''}`
}

/** 随机 token（只允许字母数字与 `-`；Rust 侧同样按这个形状校验） */
export function newPreviewToken(): string {
  const webCrypto = globalThis.crypto
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID()
  }
  // 老 webview 兜底：长度与字符集仍满足 Rust 的校验
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

/** 登记根目录（同一 token 重复调用 = 更新 allowScripts） */
export async function allowPreviewRoot(
  token: string,
  root: string,
  allowScripts: boolean,
): Promise<void> {
  await invoke('preview_allow_root', { token, root, allowScripts })
}

/** 撤销登记；失败静默（面板关闭时的清理不该再弹错） */
export async function revokePreviewRoot(token: string): Promise<void> {
  await invoke('preview_revoke_root', { token }).catch(() => {})
}
