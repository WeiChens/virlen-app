/**
 * 图片查看器的视图变换（缩放锚点 / 旋转归一 / 平移钳制）。
 *
 * 这几条公式错了不会报错，只会在界面上表现为「越放大目标越跑」「转成竖图后只能拖一半」，
 * 所以全部钉成用例。
 */
import { describe, expect, it } from 'vitest'
import {
  actualSizeScale,
  clampPan,
  fitRatio,
  IMAGE_MAX_SCALE,
  IMAGE_MIN_SCALE,
  rotateView,
  scalePercent,
  stepScale,
  zoomAt,
} from '@/domain/files/image-view'

describe('stepScale', () => {
  it('按倍率放大 / 缩小', () => {
    expect(stepScale(1, 1)).toBeCloseTo(1.25)
    expect(stepScale(1.25, -1)).toBeCloseTo(1)
  })

  it('夹在上下限内', () => {
    expect(stepScale(IMAGE_MAX_SCALE, 1)).toBe(IMAGE_MAX_SCALE)
    expect(stepScale(IMAGE_MIN_SCALE, -1)).toBe(IMAGE_MIN_SCALE)
  })
})

describe('zoomAt', () => {
  it('锚点下的图像点保持不动（绕指针缩放，不是绕中心）', () => {
    const next = zoomAt({ scale: 1, rotate: 0, x: 0, y: 0 }, { x: 100, y: 40 }, 2)
    expect(next.scale).toBe(2)
    // 图像点 p = (P - t) / s = (100, 40)；缩放后它的屏幕位置必须还是 (100, 40)
    const px = (100 - 0) / 1
    const py = (40 - 0) / 1
    expect(next.x + px * next.scale).toBeCloseTo(100)
    expect(next.y + py * next.scale).toBeCloseTo(40)
  })

  it('已平移的视图同样保持锚点（用相对量验证，避免把公式抄一遍）', () => {
    const before = { scale: 2, rotate: 0, x: -60, y: 30 }
    const pointer = { x: 120, y: -80 }
    const next = zoomAt(before, pointer, 3)
    const p = {
      x: (pointer.x - before.x) / before.scale,
      y: (pointer.y - before.y) / before.scale,
    }
    expect(next.x + p.x * next.scale).toBeCloseTo(pointer.x)
    expect(next.y + p.y * next.scale).toBeCloseTo(pointer.y)
  })

  it('夹到上下限，且超出范围时返回原对象', () => {
    const view = { scale: IMAGE_MAX_SCALE, rotate: 0, x: 0, y: 0 }
    expect(zoomAt(view, { x: 0, y: 0 }, 100)).toBe(view)
  })

  it('旋转角原样保留', () => {
    expect(zoomAt({ scale: 1, rotate: 90, x: 0, y: 0 }, { x: 0, y: 0 }, 2).rotate).toBe(90)
  })
})

describe('rotateView', () => {
  it('顺时针累加并归一', () => {
    expect(rotateView({ scale: 1, rotate: 0, x: 0, y: 0 }).rotate).toBe(90)
    expect(rotateView({ scale: 1, rotate: 270, x: 0, y: 0 }).rotate).toBe(0)
    expect(rotateView({ scale: 1, rotate: 0, x: 0, y: 0 }, -90).rotate).toBe(270)
  })
})

describe('clampPan', () => {
  const view = (patch: Partial<{ scale: number; rotate: number; x: number; y: number }>) => ({
    scale: 1,
    rotate: 0,
    x: 0,
    y: 0,
    ...patch,
  })

  it('图片比容器小时强制居中（拖不动）', () => {
    const next = clampPan(view({ x: 300, y: -300 }), { width: 200, height: 100 }, { width: 400, height: 400 })
    expect(next).toMatchObject({ x: 0, y: 0 })
  })

  it('放大后按「(显示尺寸 − 容器) / 2」限制', () => {
    // 200×100 @4 → 800×400：横向可拖 200，纵向刚好铺满（0）
    const next = clampPan(view({ scale: 4, x: 999, y: 999 }), { width: 200, height: 100 }, { width: 400, height: 400 })
    expect(next).toMatchObject({ x: 200, y: 0 })
  })

  it('旋转 90° 后宽高互换（否则竖图只能拖一半）', () => {
    const next = clampPan(
      view({ scale: 4, rotate: 90, x: 999, y: 999 }),
      { width: 200, height: 100 },
      { width: 400, height: 400 },
    )
    expect(next).toMatchObject({ x: 0, y: 200 })
  })

  it('尺寸未知（首帧 / jsdom）原样返回，不算出 NaN', () => {
    const original = view({ x: 12, y: -8 })
    expect(clampPan(original, { width: 0, height: 0 }, { width: 0, height: 0 })).toBe(original)
  })

  it('没有越界时返回原对象（避免多余重渲染）', () => {
    const original = view({ scale: 4, x: 10, y: 0 })
    expect(clampPan(original, { width: 200, height: 100 }, { width: 400, height: 400 })).toBe(original)
  })
})

describe('百分比口径', () => {
  it('适应比例：大图按容器缩、小图不放大', () => {
    expect(fitRatio({ width: 800, height: 400 }, { width: 400, height: 400 })).toBe(0.5)
    expect(fitRatio({ width: 20, height: 20 }, { width: 400, height: 400 })).toBe(1)
  })

  it('未知尺寸按 1 处理（首帧不显示 0%）', () => {
    expect(fitRatio({ width: 0, height: 0 }, { width: 400, height: 400 })).toBe(1)
  })

  it('百分比 = 适应比例 × scale，且不显示 0%', () => {
    expect(scalePercent(0.5, 1)).toBe(50)
    expect(scalePercent(0.5, 2)).toBe(100)
    expect(scalePercent(1, 0.1)).toBe(10)
    expect(scalePercent(0.01, 0.1)).toBe(1)
  })

  it('实际大小 = 1 / 适应比例，并夹到上限', () => {
    expect(actualSizeScale(0.5)).toBe(2)
    expect(actualSizeScale(1)).toBe(1)
    expect(actualSizeScale(0.01)).toBe(IMAGE_MAX_SCALE)
  })
})
