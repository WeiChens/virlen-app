/**
 * 图片文件头解析（`domain/files/image-info`）—— 侧边栏图片预览「基本信息」卡片的数据源。
 *
 * 守的是「读得对」而不是「读得全」：每种格式给一份**手工拼的最小字节**，验格式名、尺寸、
 * 色彩模式、每像素 / 每通道位数；认不出的字节必须返回 null（卡片少一行，而不是显示错值）。
 */
import { describe, expect, it } from 'vitest'
import { readImageInfo, svgImageInfo } from '@/domain/files/image-info'

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff]
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u16be(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff]
}

/** 从 `bytes` 生成一段 ASCII 数组（`ftyp` / `IHDR` 这些） */
function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0))
}

/** PNG：签名 + IHDR（宽 / 高 / 位深 / 颜色类型在固定偏移上） */
function png(width: number, height: number, depth: number, colorType: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...ascii('IHDR'),
    ...u32be(width), ...u32be(height),
    depth, colorType, 0, 0, 0,
    ...u32be(0), ...ascii('IEND'),
  ])
}

/** JPEG：SOI + 一个 SOFn（精度 / 高 / 宽 / 分量数）+ EOI */
function jpeg(width: number, height: number, components: number, precision = 8): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, ...u16be(17), precision, ...u16be(height), ...u16be(width), components,
    // 每个分量 3 字节（不用真给，长度字段才是解析的边界）
    0x01, 0x11, 0x00,
    0xff, 0xd9,
  ])
}

describe('PNG', () => {
  it('8 位 RGB → 24 位/像素', () => {
    const info = readImageInfo(png(1920, 1080, 8, 2))!
    expect(info).toMatchObject({
      format: 'PNG',
      width: 1920,
      height: 1080,
      colorMode: 'rgb',
      bitsPerChannel: 8,
      bitsPerPixel: 24,
    })
  })

  it('16 位 RGBA → 64 位/像素', () => {
    expect(readImageInfo(png(64, 64, 16, 6))).toMatchObject({
      colorMode: 'rgba',
      bitsPerChannel: 16,
      bitsPerPixel: 64,
    })
  })

  it('调色板（颜色类型 3）：位深是索引位数，没有每通道的概念', () => {
    expect(readImageInfo(png(32, 32, 4, 3))).toMatchObject({
      colorMode: 'indexed',
      bitsPerChannel: null,
      bitsPerPixel: 4,
    })
  })

  it('灰度 / 灰度 + Alpha', () => {
    expect(readImageInfo(png(8, 8, 8, 0))).toMatchObject({ colorMode: 'gray', bitsPerPixel: 8 })
    expect(readImageInfo(png(8, 8, 8, 4))).toMatchObject({
      colorMode: 'gray-alpha',
      bitsPerPixel: 16,
    })
  })
})

describe('JPEG', () => {
  it('3 分量 = RGB（内部是 YCbCr，报的是显示色彩模型）', () => {
    expect(readImageInfo(jpeg(1920, 1080, 3))).toMatchObject({
      format: 'JPEG',
      width: 1920,
      height: 1080,
      colorMode: 'rgb',
      bitsPerChannel: 8,
      bitsPerPixel: 24,
    })
  })

  it('4 分量 = CMYK（32 位/像素）', () => {
    expect(readImageInfo(jpeg(800, 600, 4))).toMatchObject({
      colorMode: 'cmyk',
      bitsPerPixel: 32,
    })
  })

  it('单分量 = 灰度', () => {
    expect(readImageInfo(jpeg(400, 300, 1))).toMatchObject({
      colorMode: 'gray',
      bitsPerPixel: 8,
    })
  })

  it('截断（只有 SOI）仍是 JPEG，但不给尺寸', () => {
    const info = readImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))!
    expect(info.format).toBe('JPEG')
    expect(info.width).toBeNull()
    expect(info.colorMode).toBeNull()
  })
})

describe('GIF / BMP', () => {
  it('GIF 是 8 位调色板', () => {
    const bytes = new Uint8Array([
      ...ascii('GIF89a'),
      ...u16le(320), ...u16le(240),
      0xf7, 0, 0,
    ])
    expect(readImageInfo(bytes)).toMatchObject({
      format: 'GIF',
      width: 320,
      height: 240,
      colorMode: 'indexed',
      bitsPerPixel: 8,
    })
  })

  it('BMP 24 位 / 32 位 / 负高度（自上而下存）', () => {
    const bmp = (width: number, height: number, bitCount: number) =>
      new Uint8Array([
        ...ascii('BM'),
        ...u32le(0), ...u32le(0), ...u32le(54),
        ...u32le(40),
        ...u32le(width), ...u32le(height),
        ...u16le(1), ...u16le(bitCount),
        ...u32le(0), ...u32le(0), 0, 0, 0, 0, 0, 0, 0, 0,
      ])

    expect(readImageInfo(bmp(800, 600, 24))).toMatchObject({
      format: 'BMP',
      width: 800,
      height: 600,
      colorMode: 'rgb',
      bitsPerPixel: 24,
    })
    expect(readImageInfo(bmp(800, 600, 32))).toMatchObject({ colorMode: 'rgba', bitsPerPixel: 32 })
    // 负高度用无符号写进去就是补码：`Math.abs` 之后才是像素高度
    expect(readImageInfo(bmp(800, -600, 8))).toMatchObject({
      height: 600,
      colorMode: 'indexed',
      bitsPerPixel: 8,
    })
  })
})

describe('WebP', () => {
  it('VP8L（无损）：14 位宽高 + alpha 标记', () => {
    const bits = (1919 | (1079 << 14) | (1 << 28)) >>> 0
    const bytes = new Uint8Array([
      ...ascii('RIFF'), ...u32le(30), ...ascii('WEBP'),
      ...ascii('VP8L'), ...u32le(10), 0x2f, ...u32le(bits),
    ])
    expect(readImageInfo(bytes)).toMatchObject({
      format: 'WebP',
      width: 1920,
      height: 1080,
      colorMode: 'rgba',
      bitsPerChannel: 8,
      bitsPerPixel: 32,
    })
  })

  it('VP8X：画布尺寸 + alpha 标志位', () => {
    const bytes = new Uint8Array([
      ...ascii('RIFF'), ...u32le(30), ...ascii('WEBP'),
      ...ascii('VP8X'), ...u32le(10),
      0x10, 0, 0, 0,
      ...[1919 & 0xff, (1919 >> 8) & 0xff, (1919 >> 16) & 0xff],
      ...[1079 & 0xff, (1079 >> 8) & 0xff, (1079 >> 16) & 0xff],
    ])
    expect(readImageInfo(bytes)).toMatchObject({
      width: 1920,
      height: 1080,
      colorMode: 'rgba',
      bitsPerPixel: 32,
    })
  })
})

describe('AVIF / ICO', () => {
  it('AVIF：ispe 给尺寸、pixi 给每通道位数', () => {
    const head = [...ascii('....ftypavif'), ...u32be(0), ...ascii('ispe'), ...u32be(0), ...u32be(1024), ...u32be(768)]
    const tail = [...u32be(0), ...ascii('pixi'), ...u32be(0), 3, 8, 8, 8]
    const info = readImageInfo(new Uint8Array([...head, ...tail]))!
    expect(info).toMatchObject({
      format: 'AVIF',
      width: 1024,
      height: 768,
      colorMode: 'rgb',
      bitsPerChannel: 8,
      bitsPerPixel: 24,
    })
  })

  it('ICO：取面积最大的那一档', () => {
    const entry = (width: number, height: number, bitCount: number) => [
      width === 256 ? 0 : width,
      height === 256 ? 0 : height,
      0,
      0,
      ...u16le(1),
      ...u16le(bitCount),
      ...u32le(0),
      ...u32le(0),
    ]
    const bytes = new Uint8Array([
      0, 0, 1, 0, ...u16le(2),
      ...entry(16, 16, 32),
      ...entry(256, 256, 8),
    ])
    expect(readImageInfo(bytes)).toMatchObject({
      format: 'ICO',
      width: 256,
      height: 256,
      colorMode: 'indexed',
      bitsPerPixel: 8,
    })
  })
})

describe('认不出的时候', () => {
  it('未知字节 / 空字节一律 null（卡片只显示文件大小）', () => {
    expect(readImageInfo(new Uint8Array(16))).toBeNull()
    expect(readImageInfo(new Uint8Array(0))).toBeNull()
    expect(readImageInfo(null)).toBeNull()
  })

  it('SVG 没有位深，只有格式与「矢量」', () => {
    expect(svgImageInfo()).toEqual({
      format: 'SVG',
      width: null,
      height: null,
      colorMode: 'vector',
      bitsPerChannel: null,
      bitsPerPixel: null,
    })
  })
})
