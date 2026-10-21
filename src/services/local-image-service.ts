/**
 * 本地图片 → `<img>` 能用的 blob URL。
 *
 * 为什么要绕这一圈（而不是把路径直接塞进 `src`）：webview 加载不了 `file:`（没开 asset 协议，
 * CSP 也是 null），只有 `blob:` / `data:` / `http(s)` 能渲染。所以本地路径必须读成字节再造 URL。
 *
 * 四条口径：
 * 1. **必须过安全校验**：与侧边栏 / 右侧文件面板同一套 `resolveSafePath`，黑名单目录直接拒 ——
 *    Markdown 正文是模型产出的，不能拿它当「读任意文件的许可证」；
 * 2. **只认图片**：按扩展名判定（`previewKindOf`，SVG 单独放行）。`<img>` 里的 SVG 不执行脚本，
 *    所以能安全地当图片渲染；
 * 3. **缓存 blob URL**：Markdown 流式渲染会把同一张图反复挂载 / 卸载（「前缀冻结」把内容从
 *    尾部树搬到前缀树 = 换了一棵 React 树），每次重读磁盘既慢又会闪一下骨架；
 * 4. **上限 32 MB**：整份读进内存再转 blob，再大就把 webview 拖死了 —— 宁可显示一个失败条。
 */
import { invoke } from '@tauri-apps/api/core'
import * as tauriFs from '@tauri-apps/plugin-fs'
import { securityService } from '@/services/security-service'
import { extensionOf, mimeOf, previewKindOf } from '@/domain/files/preview'

/** 单张图片上限：与「看一眼」这个用途匹配，再大就不该在聊天区里展开 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** 缓存条数上限（按最近使用淘汰）：一屏消息里的图片数量远小于它 */
const CACHE_LIMIT = 64

export type LocalImageErrorCode = 'not-image' | 'too-large' | 'not-found' | 'not-file'

export class LocalImageError extends Error {
  constructor(
    readonly code: LocalImageErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LocalImageError'
  }
}

export interface LoadedImage {
  /** `blob:` URL（卸载时不 revoke：缓存负责回收，见文件头） */
  url: string
  mime: string
  /** 文件名（「另存为」的默认名前缀） */
  name: string
  /** 绝对路径（「复制路径」「在文件管理器中显示」要用） */
  absolutePath: string
}

/** Rust `stat_path` 的返回（不存在时为 null） */
interface PathStat {
  exists: boolean
  is_file: boolean
  size: number
}

/** key 用「调用方给的原路径 + 会话」：组件首帧能同步查缓存，不必先异步解析出绝对路径 */
const cache = new Map<string, LoadedImage>()

function cacheKeyOf(path: string, sessionId?: string): string {
  return `${sessionId ?? ''}\u0000${path}`
}

function baseNameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path
}

/** 按扩展名判断能不能当图片渲染（SVG 不在 `previewKindOf` 的图片表里：它平时是可编辑文本） */
export function isImageName(name: string): boolean {
  return previewKindOf(name) === 'image' || extensionOf(name) === 'svg'
}

function revokeUrl(url: string): void {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

/** 放进缓存并淘汰最久没用的（被淘汰的 blob URL 必须 revoke，否则内存不会回收） */
function remember(key: string, image: LoadedImage): void {
  const existing = cache.get(key)
  if (existing) {
    // 并发加载同一张图：保留先到的那份，后到的 URL 立刻回收
    if (existing.url !== image.url) revokeUrl(image.url)
    return
  }
  cache.set(key, image)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) return
    const evicted = cache.get(oldest)
    cache.delete(oldest)
    if (evicted) revokeUrl(evicted.url)
  }
}

/** 命中缓存时把它挪到队尾（Map 保持插入顺序 = LRU） */
function touch(key: string, image: LoadedImage): LoadedImage {
  cache.delete(key)
  cache.set(key, image)
  return image
}

/** 同步查缓存：组件首帧直接拿到 URL，跨 React 树搬迁时不闪骨架 */
export function peekCachedImage(path: string, sessionId?: string): LoadedImage | undefined {
  const key = cacheKeyOf(path, sessionId)
  const hit = cache.get(key)
  return hit ? touch(key, hit) : undefined
}

/** 清空缓存（换工作目录 / 测试用；正常使用不需要调） */
export function clearLocalImageCache(): void {
  for (const image of cache.values()) revokeUrl(image.url)
  cache.clear()
}

/**
 * 读一张本地图片并转成 blob URL。路径可以是绝对路径，也可以是**相对工作目录**的路径。
 *
 * 失败一律抛 `LocalImageError`（带 code，便于界面按类型给文案）；
 * 安全校验失败抛的是 `resolveSafePath` 的原始错误（原因已经够具体，直接显示）。
 */
export async function loadLocalImage(
  path: string,
  sessionId?: string,
): Promise<LoadedImage> {
  const key = cacheKeyOf(path, sessionId)
  const cached = cache.get(key)
  if (cached) return touch(key, cached)

  const absolutePath = await securityService.resolveSafePath(path, 'r', sessionId)
  const name = baseNameOf(absolutePath)

  if (!isImageName(name)) {
    throw new LocalImageError('not-image', `不是图片：${absolutePath}`)
  }

  const stat = await invoke<PathStat | null>('stat_path', { path: absolutePath })
  if (!stat?.exists) {
    throw new LocalImageError('not-found', `文件不存在：${absolutePath}`)
  }
  if (!stat.is_file) {
    throw new LocalImageError('not-file', `不是文件：${absolutePath}`)
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new LocalImageError('too-large', `图片超过 32 MB：${absolutePath}`)
  }

  const bytes = await tauriFs.readFile(absolutePath)
  const mime = extensionOf(name) === 'svg' ? 'image/svg+xml' : mimeOf(name)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const image: LoadedImage = { url, mime, name, absolutePath }

  remember(key, image)
  return image
}
