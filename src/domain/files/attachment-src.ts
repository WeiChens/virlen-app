/**
 * 图片附件引用（`attachment://<sha256>.<ext>`）—— 纯函数，无 IO。
 *
 * 数据库里 `messages.content` 的图片块**只保存这个引用**，字节在附件目录
 * （`<数据目录>/attachments/<sha256>.<ext>`，内容寻址、天然去重）。
 * 这样主库 / WAL / 备份 / 分页 IPC 都不再被 base64 撑大。
 *
 * 两端必须逐字一致：
 * - Rust 侧 `virlen-core/src/attachment.rs`（`PREFIX` / 文件名白名单）
 * - 本文件（`ATTACHMENT_PREFIX` / `ATTACHMENT_SCHEME`）
 *
 * 渲染时把引用翻译成自定义协议 URL（`virlen-attachment`），由 webview 直接当 `<img src>` 用；
 * 协议处理器在 `src-tauri/src/commands/attachment.rs`。
 */

/** 库里的引用前缀（Rust `attachment::PREFIX` 同值） */
export const ATTACHMENT_PREFIX = 'attachment://'

/** 自定义协议名（Rust `attachment::SCHEME` 同值） */
export const ATTACHMENT_SCHEME = 'virlen-attachment'

/** 附件名形状：64 位小写 hex + 认识的图片扩展名（与 Rust `is_safe_name` 同一套） */
const NAME_RE = /^[0-9a-f]{64}\.(?:png|jpg|webp|gif|bmp|avif|svg)$/

/** 这是不是一个附件引用（只有前缀不算，名字形状也要对） */
export function isAttachmentRef(url: string): boolean {
  return attachmentName(url) !== ''
}

/** 取出附件名（`attachment://a.png` → `a.png`）；不是合法引用返回 `''` */
export function attachmentName(url: string): string {
  const raw = (url ?? '').trim()
  if (!raw.toLowerCase().startsWith(ATTACHMENT_PREFIX)) return ''
  const name = raw.slice(ATTACHMENT_PREFIX.length)
  return NAME_RE.test(name) ? name : ''
}

/**
 * Windows / Android 的 Tauri 自定义协议是 `http://<scheme>.localhost/...`，
 * 其它平台是 `<scheme>://localhost/...`（Tauri 2 的既定形态，与 `preview-asset.ts` 同一口径）。
 */
function isWindowsLike(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Windows|Android/i.test(navigator.userAgent)
}

/** 附件名 → 自定义协议 URL（喂给 `<img src>` / `fetch`） */
export function attachmentProtocolUrl(name: string): string {
  const encoded = encodeURIComponent(name)
  return isWindowsLike()
    ? `http://${ATTACHMENT_SCHEME}.localhost/${encoded}`
    : `${ATTACHMENT_SCHEME}://localhost/${encoded}`
}

/**
 * 任意图片地址 → 可直接渲染的地址。
 *
 * 只有附件引用需要翻译；`http(s)` / `data:` / `blob:` / 本地路径**一律原样返回**
 * （本地路径由 `LocalImage` 读盘，别在这里抢它的活）。
 */
export function imageDisplaySrc(url: string): string {
  const name = attachmentName(url)
  return name ? attachmentProtocolUrl(name) : url
}
