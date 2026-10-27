/**
 * 3D 模型的**本地贴图**：面板只拿到一个文件的字节，而贴图往往是同目录下的另一个文件。
 *
 * 为什么必须自己找（`model-loaders.ts` 口径 5 的另一半）：
 * - `FBXLoader` 把 `Video` 节点里的 `RelativeFilename` 用 `split('\\').pop()` **只留文件名**，
 *   再交给 `TextureLoader` 相对页面基址去取；webview 的基址是应用页面，`heli_albedo_1024.png`
 *   必然 404。`LoadingManager.onError` 被静默，`dropUnloadedTextures` 随后把 `map` 摘掉，
 *   模型就只剩纯色 —— 用户看到的就是「没有贴图」。
 * - `.glb` / 内嵌贴图的 `.fbx` 不走这里：字节就在文件里，loader 自己会处理（`Content` → blob）。
 *
 * 四步（`loadModelTextures`）：
 * 1. **扫**：模型字节里出现的图片路径（`textures\heli_albedo_1024.png`）。FBX 的
 *    `RelativeFilename` / `FileName`、DAE 的 `<init_from>` 都是可以被扫到的明文字符串。
 *    二进制 FBX 的字符串长度前缀只有一个字节、名字后面紧跟着下一个节点的名字，所以扫描
 *    只认「扩展名之前的那一段字节」，不依赖任何分隔符（见 `scanTexturePaths`）。
 * 2. **找**：`模型目录/引用路径`；不行就**逐段去掉开头**（导出机上的绝对路径
 *    `\helicopter\textures\x.png`、多层目录）；还不行就按**文件名**在模型目录里递归找
 *    （贴图文件夹被改名）。所有候选都以模型目录为起点 —— 不会跑去扫整块磁盘。
 * 3. **读**：字节 → blob URL（`TextureLoader` / `TGALoader` / `DDSLoader` 都能吃）。
 * 4. **换**：`LoadingManager.setURLModifier` 把 loader 要的 URL 换成 blob URL。modifier 是
 *    **同步**的，所以读盘必须全部在 `parse` 之前做完（`loadModelTextures` 是 async）。
 *
 * 找不到怎么办：一个字都不改（`urlFor` 原样返回），404 仍然被静默、失效槽仍然被摘掉 ——
 * 「少一层皮」永远好过「一片全黑」。
 */
import * as tauriFs from '@tauri-apps/plugin-fs'
import { extensionOf } from '@/domain/files/preview'
import {
  budgetTextureDiagnostic,
  tooLargeTextureDiagnostic,
  type DiagnosticReport,
} from './model-diagnostics'

/**
 * 认识的贴图扩展名：前六种 `TextureLoader`（`<img>`）直接解，`tga` / `dds` 交给 three 的
 * 专用 loader（由 `model-loaders.ts` 按需 `addHandler`）。其余格式（`exr` / `hdr` …）
 * 浏览器里根本没有解码器，扫出来也画不出来，不如不读盘。
 */
export const TEXTURE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'tga',
  'dds',
] as const

/** 单次扫描最多认这么多条引用（真实模型十几张就到顶了；防止误命中的垃圾串把它撑爆） */
const MAX_REFS = 64

/** 文件名的字节数上限（Windows 的路径上限之外，也挡住「向左一直吃到二进制垃圾」） */
const MAX_NAME_BYTES = 260

/** 一次解析最多探测多少个候选路径（每去一层目录段试一个，防病态路径） */
const MAX_PROBES = 160

/** 「按文件名在模型目录里找」的边界：最多看这么多个目录 / 条目 */
const MAX_SCAN_DIRS = 24
const MAX_SCAN_ENTRIES = 600

/**
 * 单张贴图上限（与 HTML 预览协议的 `MAX_BYTES` 同一个数字）：再大读进来也画不动，
 * 只会把 webview 的内存吃掉 —— 当它不存在，模型照画。
 */
const MAX_TEXTURE_BYTES = 32 * 1024 * 1024

/** 一次解析的贴图总预算：几十张 8K 贴图的模型不该把整个 webview 撞死 */
const MAX_TOTAL_BYTES = 192 * 1024 * 1024

/** 贴图文件扩展名 → blob 的 MIME（`TGALoader` / `DDSLoader` 自己解字节，不看它） */
export function textureMimeOf(path: string): string {
  switch (extensionOf(path)) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'webp':
      return 'image/webp'
    case 'tga':
      return 'image/x-tga'
    case 'dds':
      return 'image/vnd-ms.dds'
    default:
      return 'application/octet-stream'
  }
}

/** 这个文件名是不是一张「我们解得开」的贴图 */
export function isTextureName(name: string): boolean {
  return (TEXTURE_EXTENSIONS as readonly string[]).includes(extensionOf(name))
}

/** 文件名里允许出现的字节（数字 / 字母 / `_ - . 空格 \ / $ ~`） */
function isNameByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f || // _
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x20 || // 空格
    byte === 0x5c || // \
    byte === 0x2f || // /
    byte === 0x24 || // $
    byte === 0x7e // ~
  )
}

/** `at` 处是不是某个贴图扩展名（大小写不敏感）；是就返回它的长度，否则 0 */
function matchTextureExtension(bytes: Uint8Array, at: number): number {
  for (const extension of TEXTURE_EXTENSIONS) {
    if (at + extension.length > bytes.length) continue
    let hit = true
    for (let i = 0; i < extension.length; i += 1) {
      const byte = bytes[at + i]
      const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
      if (lower !== extension.charCodeAt(i)) {
        hit = false
        break
      }
    }
    if (hit) return extension.length
  }
  return 0
}

function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
  let text = ''
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i])
  return text
}

/**
 * 扫出模型字节里引用的贴图路径（保持原始形态，两种分隔符都可能出现）。
 *
 * 不看节点名、不看格式：只在每个 `.` 上试匹配扩展名，命中后**向左**吃文件名允许的字节。
 * 这样二进制 FBX（字符串前面是长度字节、后面紧跟下一个节点名）与 ASCII FBX / DAE
 * （`"textures/x.png"`、`<init_from>textures/x.png</init_from>`）走同一套逻辑，
 * 名字之后再有什么字符都不影响结果。
 */
export function scanTexturePaths(bytes: Uint8Array, limit = MAX_REFS): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  let index = bytes.indexOf(0x2e) // '.'
  while (index >= 0 && found.length < limit) {
    const length = matchTextureExtension(bytes, index + 1)
    if (length === 0) {
      index = bytes.indexOf(0x2e, index + 1)
      continue
    }
    // 扩展名占 `1 + length` 个字节（`index` 指向那个点）
    const end = index + 1 + length
    let start = index
    while (start > 0 && index - start < MAX_NAME_BYTES && isNameByte(bytes[start - 1])) {
      start -= 1
    }
    if (start < index) {
      const path = decodeAscii(bytes, start, end)
      const key = path.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        found.push(path)
      }
    }
    // 同一个字符串里不会再有第二个贴图扩展名：跳过整段，别把 `x.png` 的 `png` 再当一次名字
    index = bytes.indexOf(0x2e, end)
  }
  return found
}

/** 文件名（两种分隔符都认） */
export function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** 父目录（POSIX 风格、末尾无斜杠；没有父目录返回空串） */
export function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

/**
 * 词法归一：统一分隔符、吃掉 `.` / `..`、去掉多余斜杠（**不碰磁盘**，所以也不解符号链接）。
 * 盘符（`C:`）与开头的 `/` 保留 —— 候选路径要能原样交给 `readFile`。
 */
export function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(unified)?.[0] ?? ''
  const rest = unified.slice(drive.length)
  const absolute = rest.startsWith('/')
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else if (!absolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }
  return `${drive}${absolute ? '/' : ''}${segments.join('/')}`
}

/**
 * 一个引用在磁盘上可能是哪几个路径（按可信度排序）。
 *
 * 逐段去掉开头是有讲究的：导出机写进文件的 `\helicopter\textures\x.png`、
 * `D:\project\tex\x.png` 都是**别的机器上的位置**，但它的尾部往往正是模型目录下的相对路径
 * （`textures/x.png` / `x.png`），所以顺序是「原样 → 少一段 → 再少一段」。
 * 引用里的 `..` 由 `normalizePath` 词法解析（贴图放在上一层 `textures/` 很常见）；
 * 其余候选一律以 `modelDir` 为起点，不会跑去扫整块磁盘。
 */
export function texturePathCandidates(modelDir: string, reference: string): string[] {
  const dir = normalizePath(modelDir)
  const segments = reference
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  const candidates: string[] = []
  const seen = new Set<string>()
  for (let drop = 0; drop < segments.length; drop += 1) {
    // 第一档保留 `..`（交给 `normalizePath` 词法解析：贴图常放在上一层的 `textures/`）；
    // 之后的几档是「少一段目录」的猜测，`..` 在那里已经没有意义了
    const tail =
      drop === 0 ? segments : segments.slice(drop).filter((segment) => segment !== '..')
    if (tail.length === 0) continue
    const candidate = normalizePath(`${dir}/${tail.join('/')}`)
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }
  return candidates
}

/** 目录里的一项（`directory` 与 plugin-fs 的 `isDirectory` 同义） */
export interface TextureDirEntry {
  name: string
  directory: boolean
}

/** 贴图解析要用的四个动作（用例换成假的，不碰磁盘） */
export interface TextureFileIo {
  /** 读不到（不存在 / 没权限 / 是目录）一律返回 null，不抛 */
  read(path: string): Promise<Uint8Array | null>
  /** 列目录失败返回 null */
  list(path: string): Promise<TextureDirEntry[] | null>
  /** 字节 → 可直接塞给 loader 的 URL */
  createUrl(bytes: Uint8Array, mime: string): string
  revoke(url: string): void
}

/** 默认 IO：plugin-fs 读盘 + `URL.createObjectURL`（与面板的媒体走同一套） */
export function tauriTextureFileIo(): TextureFileIo {
  return {
    async read(path) {
      try {
        return await tauriFs.readFile(path)
      } catch {
        return null
      }
    },
    async list(path) {
      try {
        const entries = await tauriFs.readDir(path)
        return entries.map((entry) => ({
          name: String(entry.name ?? ''),
          directory: !!entry.isDirectory,
        }))
      } catch {
        return null
      }
    },
    createUrl(bytes, mime) {
      // Blob 只接 ArrayBuffer：底层可能是 SharedArrayBuffer 或带偏移，拷一份干净的
      const buffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(buffer).set(bytes)
      return URL.createObjectURL(new Blob([buffer], { type: mime }))
    },
    revoke(url) {
      URL.revokeObjectURL(url)
    },
  }
}

/** 解析结果：URL 改写器 + 统计 + 释放 */
export interface ModelTextures {
  /**
   * 「找到的」贴图数。两种口径（同一张图只算一次，按文件名去重）：
   * - `parse` 之后：loader **按磁盘路径来问过**的名字里，我们真给出去几张；
   * - `parse` 之前（还没有人来问）：按扫描到的引用找出了几张。
   */
  readonly found: number
  /** 与 `found` 同一口径的「一共几张」（`found < total` = 有缺的，面板据此提示） */
  readonly total: number
  /**
   * loader 真正**按磁盘路径问过**的贴图数：内嵌贴图（FBX 的 `Content`）拿到的是 `data:` / `blob:`，
   * 根本不经过这里；扫到的假引用也不会算进来。`parse` 之后才有值 ——
   * **0 表示这个模型没有外部贴图**，面板就不该显示「0 / N」吓人。
   */
  readonly requested: number
  /** 解析到的扩展名（小写）：`tga` / `dds` 要额外注册 three 的 loader */
  extensions: Set<string>
  /**
   * loader 要过、但磁盘上没找到的贴图名（`parse` 之后才有值）：面板只报「2 / 3」时用户
   * 没法去补文件，名字才是可行动的。顺序同上传顺序，最多只取前几个展示。
   */
  readonly missing: readonly string[]
  /** loader 要的 URL → blob URL（认不出来的原样返回） */
  urlFor(url: string): string
  /** 放掉所有 blob URL（换模型 / 关面板时） */
  dispose(): void
}

/**
 * 按文件名在模型目录里找（广度优先、深度不限但受目录 / 条目上限约束）。
 *
 * 只在「引用路径一个都没命中」时才用：贴图文件夹被改名（`tex/` → `textures/`）、或者
 * 引用写的是别的机器上的目录。只收 `wanted` 里点名的文件名，别的一张都不读。
 */
async function indexTextures(
  modelDir: string,
  io: TextureFileIo,
  wanted: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  const queue = [normalizePath(modelDir)]
  let directories = 0
  let entries = 0
  while (queue.length > 0 && directories < MAX_SCAN_DIRS && entries < MAX_SCAN_ENTRIES) {
    const current = queue.shift() as string
    directories += 1
    const list = await io.list(current)
    if (!list) continue
    for (const entry of list) {
      entries += 1
      if (entries > MAX_SCAN_ENTRIES) break
      if (entry.directory) {
        queue.push(`${current}/${entry.name}`)
        continue
      }
      const name = entry.name.toLowerCase()
      if (!wanted.has(name) || index.has(name) || !isTextureName(name)) continue
      index.set(name, `${current}/${entry.name}`)
    }
  }
  return index
}

/**
 * 模型字节 + 磁盘路径 → 贴图 URL 改写器。没有磁盘路径 / 一张引用都没扫到时返回 null
 * （调用方据此决定要不要动 `LoadingManager`）。
 *
 * ⚠️ 扫到了引用、但**磁盘上一张都没有**时**仍然返回结果**（`found: 0`）：面板要把
 * 「引用 3 张、找到 0 张」显示出来 —— 否则用户只看到一片纯色，连原因都没有。
 *
 * ⚠️ 必须在 `loader.parse()` **之前** await 完：`setURLModifier` 的回调是同步的。
 *
 * `report` 只收「用户能看懂且能行动」的两类：单张贴图过大、以及总量超出预算被跳过
 * （读不到不算 —— 定位候选路径本来就会大量落空，那是正常流程）。
 */
export async function loadModelTextures(
  bytes: Uint8Array,
  modelPath: string,
  io: TextureFileIo = tauriTextureFileIo(),
  report?: DiagnosticReport,
): Promise<ModelTextures | null> {
  if (!modelPath) return null
  const references = scanTexturePaths(bytes)
  if (references.length === 0) return null

  const modelDir = dirOf(modelPath)
  if (!modelDir) return null

  /** 小写文件名 → blob URL（loader 拿到的就是文件名，FBXLoader 会把目录剥掉） */
  const byName = new Map<string, string>()
  /** 小写完整相对路径 → blob URL（DAE / 3DS 可能给全路径） */
  const byReference = new Map<string, string>()
  /** 小写绝对路径 → blob URL（同一张图被多个材质引用时只读一次） */
  const byPath = new Map<string, string | null>()
  const urls: string[] = []
  let totalBytes = 0
  let budgetReported = false
  const extensions = new Set<string>()
  /** loader 可能来问的文件名（小写）—— 也是「总共几张」的口径 */
  const wanted = new Set<string>()

  const remember = async (path: string): Promise<string | null> => {
    const key = path.toLowerCase()
    const cached = byPath.get(key)
    if (cached !== undefined) return cached
    const data = await io.read(path)
    // 太大 / 超预算（或读不到）：记成 null，同一张图不会被反复试
    const tooLarge = !!data && data.byteLength > MAX_TEXTURE_BYTES
    const overBudget = !!data && !tooLarge && totalBytes + data.byteLength > MAX_TOTAL_BYTES
    if (tooLarge) {
      report?.(tooLargeTextureDiagnostic(baseNameOf(path), data.byteLength))
    } else if (overBudget && !budgetReported) {
      // 预算只报一次（后面那一批会全部落空，逐张报只会把列表刷满）
      budgetReported = true
      report?.(budgetTextureDiagnostic(baseNameOf(path), data.byteLength))
    }
    const accepted =
      !!data && data.byteLength > 0 && !tooLarge && !overBudget
    const url = accepted ? io.createUrl(data, textureMimeOf(path)) : null
    if (url) {
      totalBytes += data.byteLength
      urls.push(url)
      extensions.add(extensionOf(path))
    }
    byPath.set(key, url)
    return url
  }

  for (const reference of references) {
    const name = baseNameOf(reference).toLowerCase()
    if (!name) continue
    wanted.add(name)
  }
  if (wanted.size === 0) return null

  let probes = 0
  for (const reference of references) {
    const name = baseNameOf(reference).toLowerCase()
    if (!name || byName.has(name)) continue
    for (const candidate of texturePathCandidates(modelDir, reference)) {
      if (probes >= MAX_PROBES) break
      probes += 1
      const url = await remember(candidate)
      if (!url) continue
      byName.set(name, url)
      byReference.set(normalizePath(reference).toLowerCase(), url)
      break
    }
  }

  // 还有没找到的：按文件名在模型目录（含子目录）里再找一遍
  if (byName.size < wanted.size) {
    const index = await indexTextures(modelDir, io, wanted)
    for (const [name, path] of index) {
      if (byName.has(name)) continue
      const url = await remember(path)
      if (url) byName.set(name, url)
    }
  }

  /** loader 按磁盘路径来问过的文件名（内嵌贴图的 `data:` / `blob:` 不算） */
  const requested = new Set<string>()
  const countRequestedFound = (): number => {
    let count = 0
    for (const name of requested) if (byName.has(name)) count += 1
    return count
  }

  let disposed = false
  return {
    // 有人来问过（= 真的开始解析了）就用「loader 要的」这一档口径：
    // 内嵌贴图与扫到的假引用都不会把「找到 / 引用」弄成 0 / 3
    get found() {
      return requested.size > 0 ? countRequestedFound() : byName.size
    },
    get total() {
      return requested.size > 0 ? requested.size : wanted.size
    },
    get requested() {
      return requested.size
    },
    get missing() {
      const list: string[] = []
      for (const name of requested) if (!byName.has(name)) list.push(name)
      return list
    },
    extensions,
    urlFor(url) {
      const trimmed = url.trim()
      if (!trimmed) return trimmed
      // data:/blob: 是 three 自己造的（内嵌贴图），http(s) 是作者写的网络贴图：一律不动
      if (/^(data|blob|https?):/i.test(trimmed)) return trimmed
      const name = baseNameOf(trimmed).toLowerCase()
      requested.add(name)
      const direct = byReference.get(normalizePath(trimmed).toLowerCase())
      if (direct) return direct
      return byName.get(name) ?? trimmed
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const value of urls) io.revoke(value)
    },
  }
}
