/**
 * clipboard — 剪贴板读写与「另存为」的公共实现
 *
 * 为什么单独抽出来：正文复制、图片右键「复制图片 / 另存为」、文件 chip「复制路径」、
 * 终端「复制/粘贴」都要这套逻辑，各处自己写会分叉（尤其图片字节的获取方式）。
 *
 * 本文件**不依赖 i18n / Toast / store**（utils 层不该反向依赖 ui）：
 * 返回值告诉调用方成功与否，提示文案由调用方决定。
 *
 * 图片字节的来源分三种：
 *   - `data:` —— 用户粘贴的图片（项目里图片附件就是 base64 dataURL），本地解码；
 *   - `blob:` —— 页面内生成的临时地址，直接 fetch；
 *   - 远端 `http(s):` —— 必须走 `plugin-http`：WebView 里直接 fetch 会被 CORS 拦，
 *     而 Rust 侧发请求没有同源限制（capabilities 已放行 http/https）。
 */

/** 复制纯文本；失败返回 false（调用方决定要不要提示） */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard?.writeText(text)
    return true
  } catch {
    // 无 API / 非用户激活 → 退 execCommand
  }
  return legacyCopyText(text)
}

/** execCommand('copy') 兜底（需要临时 textarea + 选区） */
function legacyCopyText(text: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    // 放到视口外，避免复制瞬间页面跳动
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/** base64 → 字节 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** 字节 → base64（分块，避免大图触发参数上限） */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 从 dataURL 头部取出 MIME（`data:image/png;base64,xxx` → `image/png`） */
function mimeFromDataUrl(src: string): string | undefined {
  const match = /^data:([^;,]+)/.exec(src)
  return match?.[1]
}

/** 图片 MIME：优先 dataURL 头部，其次按扩展名猜，兜底 image/png */
export function imageMimeOf(src: string): string {
  const fromData = mimeFromDataUrl(src)
  if (fromData) return fromData
  const path = src.split('?')[0].toLowerCase()
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.bmp')) return 'image/bmp'
  return 'image/png'
}

/** 文件扩展名（另存为对话框用），与 `imageMimeOf` 同源判断 */
export function imageExtOf(src: string): string {
  const mime = imageMimeOf(src)
  return (
    {
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
    }[mime] ?? 'png'
  )
}

/**
 * 取图片原始字节（dataURL 本地解码 / blob 与远端走 fetch）。
 * 远端走 `plugin-http`：WebView 内 fetch 会撞 CORS，Rust 侧不会。
 */
export async function readImageBytes(src: string): Promise<Uint8Array> {
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    if (comma < 0) throw new Error('invalid data url')
    const meta = src.slice(0, comma)
    const payload = src.slice(comma + 1)
    if (meta.includes(';base64')) return base64ToBytes(payload)
    // 极少数非 base64 的 dataURL（如 svg+xml 明文）按 URL 解码
    return new TextEncoder().encode(decodeURIComponent(payload))
  }
  if (src.startsWith('blob:')) {
    const resp = await fetch(src)
    return new Uint8Array(await resp.arrayBuffer())
  }
  const { fetch: httpFetch } = await import('@tauri-apps/plugin-http')
  const resp = await httpFetch(src)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return new Uint8Array(await resp.arrayBuffer())
}

/**
 * 把图片写进系统剪贴板。
 *
 * 两条路，先原生后浏览器：
 *   1. Tauri 命令 `write_clipboard_image`（Windows: 解码后写 CF_DIB）——
 *      不依赖 WebView 的剪贴板权限，行为确定；
 *   2. `navigator.clipboard.write(ClipboardItem)` —— 浏览器/未实现平台（macOS/Linux）
 *      的兜底，WebView2 下是否放行取决于运行时权限。
 *
 * @returns 是否复制成功（两条路都失败 → false，调用方给用户一个提示）
 */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  const bytes = await readImageBytes(src)
  const mime = imageMimeOf(src)

  // 1) 原生：走 Rust 写 CF_DIB
  try {
    await invokeWriteImage(bytesToBase64(bytes))
    return true
  } catch {
    // 非 Windows / 命令未注册 / 解码失败 → 走浏览器兜底
  }

  // 2) 浏览器异步剪贴板
  try {
    const ClipboardItemCtor = (globalThis as any).ClipboardItem
    if (!ClipboardItemCtor || !navigator.clipboard?.write) return false
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
    await navigator.clipboard.write([
      new ClipboardItemCtor({ [mime]: blob }),
    ])
    return true
  } catch {
    return false
  }
}

/** 调 Rust 写图片剪贴板（单独抽出：格式由 Rust 侧从字节头部自行判定，故只传 base64） */
async function invokeWriteImage(base64: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('write_clipboard_image', { base64 })
}

/**
 * 图片「另存为」：弹保存对话框 → 写盘。
 *
 * @returns 保存到的路径；用户取消返回 ''（非错误）
 */
export async function saveImageAs(
  src: string,
  defaultName: string,
): Promise<string> {
  const bytes = await readImageBytes(src)
  const ext = imageExtOf(src)
  const name = defaultName.endsWith(`.${ext}`)
    ? defaultName
    : `${defaultName}.${ext}`
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const chosen = await save({
      defaultPath: name,
      filters: [{ name: 'Image', extensions: [ext] }],
    })
    if (!chosen) return ''
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(chosen, bytes)
    return chosen
  } catch {
    // 浏览器 dev 环境没有对话框/写盘能力 → 退化成下载
    return browserDownload(bytes, name, imageMimeOf(src))
  }
}

/** 浏览器环境触发下载（返回虚拟路径标识，与 telemetry/transport.ts 同款兜底） */
function browserDownload(
  data: Uint8Array,
  fileName: string,
  mime: string,
): string {
  const blob = new Blob([data as unknown as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return fileName
}

/** 生成「图片-时间戳」形式的默认文件名（另存为对话框预填） */
export function defaultImageName(prefix = 'image'): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
