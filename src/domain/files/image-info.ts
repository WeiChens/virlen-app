/**
 * 图片**文件头解析**（纯函数）：侧边栏图片预览那张「基本信息」卡片靠它。
 *
 * 为什么自己读字节而不是只看 `<img>`：
 * - `<img>` 只给得到 `naturalWidth/Height`（分辨率），**色彩模式与位深度拿不到**；
 * - 也不能靠 `canvas` 取像素反推：那只能知道「解码后的 RGBA」，永远 8 位/通道，
 *   16 位 PNG、CMYK JPEG 都会被说成 24 位 RGB（正好是用户最想区分的那几种）。
 *
 * 四条口径：
 * 1. **只读文件头**：PNG 读 IHDR、JPEG 跳到第一个 SOFn、GIF/BMP/ICO 读定长头、
 *    WebP 读 VP8/VP8L/VP8X、AVIF 扫 `ispe` / `pixi` box —— 都是几十字节到几百字节，
 *    不碰像素数据（64 MB 的图片打开也不卡）；
 * 2. **认不出就返回 null 字段**：宁可少一行「位深度」，也不猜。卡片只显示拿到的那几行；
 * 3. **色彩模式报「显示用的色彩模型」**：3 分量的 JPEG 报 RGB（内部是 YCbCr，
 *    但用户要看的是「这张图是 RGB 还是 CMYK / 灰度」），4 分量报 CMYK；
 * 4. **位深度同时给「每像素」与「每通道」**：用户举的例子（8 / 16 / 24 / 32 位）是**每像素**，
 *    PNG 的 IHDR 存的却是**每通道**（8 / 16），两者都在这里算好，展示层自己拼文案。
 */

/** 色彩模型（代码值，展示文案由 UI 层 t() 翻；`vector` = SVG 这种没有位深的概念） */
export type ImageColorMode =
  | 'rgb'
  | 'rgba'
  | 'gray'
  | 'gray-alpha'
  | 'indexed'
  | 'cmyk'
  | 'vector'

export interface ImageFileInfo {
  /** 格式名（`PNG` / `JPEG` / `GIF` / `BMP` / `WebP` / `AVIF` / `ICO` / `SVG`）；认不出为 null */
  format: string | null
  /** 编码时的像素宽 / 高（文件头里的值；认不出为 null） */
  width: number | null
  height: number | null
  /** 色彩模式；`indexed` = 用了调色板（GIF、索引色 PNG/BMP） */
  colorMode: ImageColorMode | null
  /** 每个通道的位数（RGB 8 位 → 8）；调色板 / 认不出时为 null */
  bitsPerChannel: number | null
  /** 每个像素的总位数（RGB 8×3 → 24）；认不出时为 null */
  bitsPerPixel: number | null
}

/** 认不出的格式 / 只有部分字段时用它当底 */
function info(partial: Partial<ImageFileInfo> = {}): ImageFileInfo {
  return {
    format: partial.format ?? null,
    width: partial.width ?? null,
    height: partial.height ?? null,
    colorMode: partial.colorMode ?? null,
    bitsPerChannel: partial.bitsPerChannel ?? null,
    bitsPerPixel: partial.bitsPerPixel ?? null,
  }
}

/** SVG 只有文本，没有位深；分辨率由 `<img>` 的自然尺寸给（可能是 viewBox 换算出来的） */
export function svgImageInfo(): ImageFileInfo {
  return info({ format: 'SVG', colorMode: 'vector' })
}

// ---------- 小工具：定长整数（越界一律当 0，解析函数自己再判长度） ----------

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
}

function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
}

function u24le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16)
}

function u32be(b: Uint8Array, o: number): number {
  return (
    ((b[o] ?? 0) * 0x1000000 + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0))
  )
}

function u32le(b: Uint8Array, o: number): number {
  return (
    (b[o] ?? 0) + ((b[o + 1] ?? 0) << 8) + ((b[o + 2] ?? 0) << 16) + (b[o + 3] ?? 0) * 0x1000000
  )
}

function i32le(b: Uint8Array, o: number): number {
  return u32le(b, o) | 0
}

/** 这 4 个字节是不是给定的 ASCII（`RIFF` / `ftyp` / `ispe` …） */
function asciiAt(b: Uint8Array, o: number, text: string): boolean {
  if (o + text.length > b.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (b[o + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** 在字节里找一段 ASCII（AVIF 的 `ispe` / `pixi` 埋在嵌套 box 里，逐个走 box 树不值当） */
function indexOfAscii(b: Uint8Array, text: string, from = 0): number {
  const last = b.length - text.length
  for (let i = Math.max(0, from); i <= last; i += 1) {
    if (asciiAt(b, i, text)) return i
  }
  return -1
}

// ---------- PNG ----------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readPng(b: Uint8Array): ImageFileInfo | null {
  if (b.length < 8 || !PNG_SIG.every((v, i) => b[i] === v)) return null
  // 8 字节签名 + 4 长度 + 4 类型 + IHDR 13 字节（宽 / 高 / 位深 / 颜色类型在最前面）
  if (b.length < 26) return info({ format: 'PNG' })
  const width = u32be(b, 16)
  const height = u32be(b, 20)
  const depth = b[24] ?? 0
  const colorType = b[25] ?? 0
  // IHDR 的位深是**每通道**：0 / 2 / 4 / 6 型都是这么算；3 型是调色板下标位数
  switch (colorType) {
    case 0:
      return info({ format: 'PNG', width, height, colorMode: 'gray', bitsPerChannel: depth, bitsPerPixel: depth })
    case 2:
      return info({ format: 'PNG', width, height, colorMode: 'rgb', bitsPerChannel: depth, bitsPerPixel: depth * 3 })
    case 3:
      // 索引色：像素存的是调色板下标（1 / 2 / 4 / 8 位），颜色本身在 PLTE 里（8 位/通道）
      return info({ format: 'PNG', width, height, colorMode: 'indexed', bitsPerChannel: null, bitsPerPixel: depth })
    case 4:
      return info({ format: 'PNG', width, height, colorMode: 'gray-alpha', bitsPerChannel: depth, bitsPerPixel: depth * 2 })
    case 6:
      return info({ format: 'PNG', width, height, colorMode: 'rgba', bitsPerChannel: depth, bitsPerPixel: depth * 4 })
    default:
      return info({ format: 'PNG', width, height })
  }
}

// ---------- JPEG ----------

/**
 * JPEG 的尺寸与分量数只看 SOFn（FFC0~FFCF，但要排掉 C4=DHT / C8=JPG / CC=DAC）。
 * 段之间靠 2 字节长度链跳；SOS（FFDA）之后的熵编码数据不再解析 —— 帧头必在它之前。
 */
function readJpeg(b: Uint8Array): ImageFileInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) {
      // 走到这里说明段长链错位了（截断 / 非标准文件）：别硬猜
      offset += 1
      continue
    }
    let marker = b[offset + 1] ?? 0
    // 标记前允许任意个 0xFF 填充字节
    while (marker === 0xff && offset + 2 < b.length) {
      offset += 1
      marker = b[offset + 1] ?? 0
    }
    // 无长度字段的标记：TEM、RSTn、SOI、EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break
      offset += 2
      continue
    }
    const length = u16be(b, offset + 2)
    if (length < 2) break
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader && offset + 10 <= b.length) {
      const precision = b[offset + 4] ?? 8
      const height = u16be(b, offset + 5)
      const width = u16be(b, offset + 7)
      const components = b[offset + 9] ?? 0
      // 3 分量 = YCbCr（显示为 RGB），4 分量 = CMYK / YCCK（Adobe 的不支持透明）
      const mode: ImageColorMode | null =
        components === 1 ? 'gray' : components === 3 ? 'rgb' : components === 4 ? 'cmyk' : null
      return info({
        format: 'JPEG',
        width,
        height,
        colorMode: mode,
        bitsPerChannel: precision || null,
        bitsPerPixel: mode && components > 0 ? precision * components : null,
      })
    }
    // SOS 之后是熵编码数据，帧头不可能再出现
    if (marker === 0xda) break
    offset += 2 + length
  }
  return info({ format: 'JPEG' })
}

// ---------- GIF ----------

function readGif(b: Uint8Array): ImageFileInfo | null {
  if (!asciiAt(b, 0, 'GIF8')) return null
  if (b.length < 13) return info({ format: 'GIF' })
  // 逻辑屏幕宽高（LE）；像素是 8 位调色板下标，所以「位深度」= 8
  return info({
    format: 'GIF',
    width: u16le(b, 6),
    height: u16le(b, 8),
    colorMode: 'indexed',
    bitsPerChannel: null,
    bitsPerPixel: 8,
  })
}

// ---------- BMP ----------

function readBmp(b: Uint8Array): ImageFileInfo | null {
  if (!asciiAt(b, 0, 'BM')) return null
  if (b.length < 30) return info({ format: 'BMP' })
  // BITMAPINFOHEADER 起（更老的 OS/2 头结构不同，字段偏移不一样，只认 40 字节以上的）
  const headerSize = u32le(b, 14)
  const width = i32le(b, 18)
  // 高度为负 = 自上而下存（绝对值才是像素高度）
  const height = Math.abs(i32le(b, 22))
  const bitCount = u16le(b, 28)
  const mode: ImageColorMode | null =
    bitCount === 32
      ? 'rgba'
      : bitCount === 24
        ? 'rgb'
        : bitCount === 16
          ? 'rgb'
          : bitCount > 0
            ? 'indexed'
            : null
  const perChannel = bitCount === 32 || bitCount === 24 ? 8 : null
  return info({
    format: 'BMP',
    width: width || null,
    height: height || null,
    colorMode: mode,
    // 16 位是 RGB555/565，没有「每通道 8 位」这回事：不给每通道，只给 16
    bitsPerChannel: headerSize >= 40 ? perChannel : null,
    bitsPerPixel: bitCount || null,
  })
}

// ---------- WebP ----------

/**
 * WebP 是 RIFF 容器，三种第一个 chunk：
 * - `VP8X`（带扩展特性：alpha / 动画 / ICC）：画布尺寸就在 chunk 里，**最省事**；
 * - `VP8L`（无损）：尺寸藏在 5 字节签名的位流里（14 位宽 + 14 位高 + 1 位 alpha）；
 * - `VP8 `（有损）：帧头 + 3 字节起始码之后是两个 14 位宽高。
 * 三种都固定 8 位/通道。
 */
function readWebp(b: Uint8Array): ImageFileInfo | null {
  if (!asciiAt(b, 0, 'RIFF') || !asciiAt(b, 8, 'WEBP')) return null
  const base = info({ format: 'WebP', bitsPerChannel: 8 })
  if (asciiAt(b, 12, 'VP8X') && b.length >= 30) {
    const flags = b[20] ?? 0
    // bit4 = alpha（Rsv:2 I L E X A R 的 A 位）
    const alpha = (flags & 0x10) !== 0
    const width = u24le(b, 24) + 1
    const height = u24le(b, 27) + 1
    return {
      ...base,
      width,
      height,
      colorMode: alpha ? 'rgba' : 'rgb',
      bitsPerPixel: alpha ? 32 : 24,
    }
  }
  if (asciiAt(b, 12, 'VP8L') && b.length >= 25 && b[20] === 0x2f) {
    const bits = u32le(b, 21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    const alpha = (bits & 0x10000000) !== 0
    return {
      ...base,
      width,
      height,
      colorMode: alpha ? 'rgba' : 'rgb',
      bitsPerPixel: alpha ? 32 : 24,
    }
  }
  if (asciiAt(b, 12, 'VP8 ') && b.length >= 30) {
    // 3 字节帧标签之后是 0x9d 0x01 0x2a 起始码，再往后两个 16 位里低 14 位是宽高
    const at = 26
    return {
      ...base,
      width: (u16le(b, at) & 0x3fff) || null,
      height: (u16le(b, at + 2) & 0x3fff) || null,
      colorMode: 'rgb',
      bitsPerPixel: 24,
    }
  }
  return base
}

// ---------- AVIF / HEIF ----------

/**
 * AVIF 是 ISO BMFF（`ftyp` + 一堆 box）。真正规的读法要走 box 树到 `meta/iprp/ipco`，
 * 但 `ispe`（图像尺寸）与 `pixi`（每通道位数）在整份容器里通常只出现一次 —— 直接按
 * ASCII 定位这两个 box 头，比实现一棵解析器划算得多（误判风险：值域检查兜住）。
 */
function readAvif(b: Uint8Array): ImageFileInfo | null {
  if (!asciiAt(b, 4, 'ftyp')) return null
  const brand = b.length >= 12 ? String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0) : ''
  const isAvif = brand.startsWith('avif') || brand.startsWith('avis')
  const isHeif = brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')
  if (!isAvif && !isHeif) return null
  const result = info({ format: isAvif ? 'AVIF' : 'HEIF' })

  const ispe = indexOfAscii(b, 'ispe')
  if (ispe >= 0 && ispe + 16 <= b.length) {
    // `ispe` 后面跟：version+flags（4）→ 宽（4）→ 高（4）
    const width = u32be(b, ispe + 8)
    const height = u32be(b, ispe + 12)
    // 值域检查：宽高不可能是 0 或上亿（否则大概率命中的是数据区里的同样 4 个字节）
    if (width > 0 && height > 0 && width < 0x10000 && height < 0x10000) {
      result.width = width
      result.height = height
    }
  }

  const pixi = indexOfAscii(b, 'pixi')
  if (pixi >= 0 && pixi + 10 <= b.length) {
    // `pixi` 后面跟：version+flags（4）→ 通道数（1）→ 每通道位数（每通道 1 字节）
    const channels = b[pixi + 8] ?? 0
    const perChannel = b[pixi + 9] ?? 0
    if (perChannel > 0 && perChannel <= 32) {
      result.bitsPerChannel = perChannel
      result.bitsPerPixel = channels > 0 ? perChannel * channels : null
    }
  }
  // HEIF/AVIF 的像素是 YUV 编的，但用户看的是 RGB 画面；只有 4 通道（含 alpha）时说明多一层
  if (result.bitsPerPixel) {
    result.colorMode = result.bitsPerChannel && result.bitsPerPixel / result.bitsPerChannel >= 4 ? 'rgba' : 'rgb'
  }
  return result
}

// ---------- ICO ----------

function readIco(b: Uint8Array): ImageFileInfo | null {
  if (b.length < 6 || b[0] !== 0 || b[1] !== 0) return null
  const type = u16le(b, 2)
  if (type !== 1 && type !== 2) return null
  const count = u16le(b, 4)
  if (count === 0) return info({ format: 'ICO' })
  // 每个目录项 16 字节：宽 / 高各 1 字节（0 表示 256）、颜色数、保留、平面数、位深、字节数、偏移
  let best: { area: number; width: number; height: number; bitCount: number } | null = null
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16
    if (at + 16 > b.length) break
    const width = b[at] === 0 ? 256 : (b[at] ?? 0)
    const height = b[at + 1] === 0 ? 256 : (b[at + 1] ?? 0)
    const bitCount = u16le(b, at + 6)
    const area = width * height
    // 取面积最大的那一档（ICO 里常含 16/32/48/256 多张图）
    if (!best || area > best.area) best = { area, width, height, bitCount }
  }
  if (!best) return info({ format: 'ICO' })
  const mode: ImageColorMode | null =
    best.bitCount === 32 ? 'rgba' : best.bitCount === 24 ? 'rgb' : 'indexed'
  return info({
    format: 'ICO',
    width: best.width,
    height: best.height,
    colorMode: mode,
    bitsPerChannel: best.bitCount >= 24 ? 8 : null,
    bitsPerPixel: best.bitCount || null,
  })
}

/**
 * 文件头 → 图片信息。认不出格式返回 null（卡片就只显示文件大小）；
 * 认得出但某个字段读不到时，那个字段是 null。
 */
export function readImageInfo(bytes: Uint8Array | null | undefined): ImageFileInfo | null {
  if (!bytes || bytes.length < 4) return null
  return (
    readPng(bytes) ??
    readJpeg(bytes) ??
    readGif(bytes) ??
    readWebp(bytes) ??
    readAvif(bytes) ??
    readIco(bytes) ??
    readBmp(bytes)
  )
}
