// @vitest-environment node
/**
 * 发图档位领域层：设置值归一化 + 等比缩放。
 *
 * 这套规则同时被前端 `hooks.ts::fileToDataUrl` 与 Rust `vision/encode.rs` 使用（铁律 1），
 * 所以断言写的是「行为口径」而不是某个调用方的实现细节。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_CONVERT_FORMAT,
  DEFAULT_IMAGE_MAX_DIMENSION,
  IMAGE_MAX_DIMENSIONS,
  fitWithin,
  normalizeImageFormat,
  normalizeMaxDimension,
} from '@/domain/image'

describe('image send profile', () => {
  it('defaults match the shipped settings', () => {
    expect(DEFAULT_IMAGE_CONVERT_FORMAT).toBe('jpeg')
    expect(DEFAULT_IMAGE_MAX_DIMENSION).toBe(1568)
  })

  it('normalizes junk settings back to the defaults', () => {
    expect(normalizeImageFormat('webp')).toBe('webp')
    expect(normalizeImageFormat('PNG')).toBe('png') // 大小写不敏感，与 Rust 一致
    expect(normalizeImageFormat(undefined)).toBe('jpeg')

    expect(normalizeMaxDimension(1024)).toBe(1024)
    expect(normalizeMaxDimension('2048')).toBe(2048)
    // 只接受三个档位：别的值一律回默认
    expect(IMAGE_MAX_DIMENSIONS).toEqual([1024, 1568, 2048])
    expect(normalizeMaxDimension(9999)).toBe(DEFAULT_IMAGE_MAX_DIMENSION)
    expect(normalizeMaxDimension(undefined)).toBe(DEFAULT_IMAGE_MAX_DIMENSION)
  })

  it('scales down to the longest edge and never upscales', () => {
    expect(fitWithin(3840, 2160, 1568)).toEqual({ width: 1568, height: 882 })
    // 长边是高度时同样按高度对齐
    expect(fitWithin(2160, 3840, 1568)).toEqual({ width: 882, height: 1568 })
    // 已经更小 → 原尺寸
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 })
    // 极端窄图不会缩成 0
    expect(fitWithin(4000, 3, 1024)).toEqual({ width: 1024, height: 1 })
  })
})
