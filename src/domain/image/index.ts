/**
 * 发图档位：发给模型前要不要缩放、转成什么格式。
 *
 * 口径与 Rust `agent/native_tools/vision/encode.rs` **逐字对齐**（铁律 1）：用户直接发的图走这里
 * （`hooks.ts::fileToDataUrl`），工具把图交给模型走 Rust —— 两条路径必须是同一套规则，否则同一张图
 * 会因入口不同发出去两个大小。
 *
 * 为什么按「最长边」而不是像素总数：视觉模型按最长边分档，1920×1920 的像素阈值会让 4000×800 的宽图
 * 原样漏过去（像素数够小、但长边远超阈值）。
 */

export type ImageConvertFormat = 'jpeg' | 'png' | 'webp'

/** 有损质量（JPEG q / WebP q 同一档，与 Rust `QUALITY` 同值） */
export const IMAGE_QUALITY = 0.82

/** 允许的最长边档位（设置页只给这三个选项） */
export const IMAGE_MAX_DIMENSIONS = [1024, 1568, 2048] as const

/** 默认最长边：1568 是视觉模型的分档上限，再大只是白花 token */
export const DEFAULT_IMAGE_MAX_DIMENSION = 1568

/** 默认格式：截图转 JPEG 体积最小 */
export const DEFAULT_IMAGE_CONVERT_FORMAT: ImageConvertFormat = 'jpeg'

export const IMAGE_CONVERT_FORMATS: ImageConvertFormat[] = ['jpeg', 'png', 'webp']

/** 设置值 → 格式（大小写不敏感；认不出来的一律按 JPEG，与 Rust 默认一致） */
export function normalizeImageFormat(raw: unknown): ImageConvertFormat {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (IMAGE_CONVERT_FORMATS as string[]).includes(v)
    ? (v as ImageConvertFormat)
    : DEFAULT_IMAGE_CONVERT_FORMAT
}

/** 设置值 → 最长边（非法值回落到默认） */
export function normalizeMaxDimension(raw: unknown): number {
  const n = Number(raw)
  return (IMAGE_MAX_DIMENSIONS as readonly number[]).includes(n)
    ? n
    : DEFAULT_IMAGE_MAX_DIMENSION
}

/** 等比缩到「最长边 ≤ max」，只缩不放（与 Rust `fit` 同算法） */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= max || longest <= 0) return { width, height }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
