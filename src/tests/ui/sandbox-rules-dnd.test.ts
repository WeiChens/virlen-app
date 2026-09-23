/**
 * sandbox-rules-dnd 单测 — 「忽略沙盒命令」列表拖拽排序的几何计算
 *
 * 这两个纯函数决定两件事：松手时排到第几位、指示线画在哪里 ——
 * 算错就会「明明拖到第 2 位却排到第 3 位」，所以边界（行中线、越界、空列表）都要钉住。
 * 坐标语义：`top` / `bottom` 是**列表内容坐标**（见模块头注释）。
 */
import { describe, it, expect } from 'vitest'
import {
  computeDropIndex,
  dropIndicatorTop,
  type RowRange,
} from '@/ui/pages/Settings/sandbox-rules-dnd'

/** 三行：间隔 6px（= .rule-list 的 gap），行高 40 */
const rows: RowRange[] = [
  { top: 0, bottom: 40 },
  { top: 46, bottom: 86 },
  { top: 92, bottom: 132 },
]

describe('sandbox-rules-dnd · computeDropIndex', () => {
  it('按行中线判定落点（越过后即排到该行前面）', () => {
    expect(computeDropIndex(rows, -5)).toBe(0)
    expect(computeDropIndex(rows, 19)).toBe(0) // 第一行中线 20 之前
    expect(computeDropIndex(rows, 25)).toBe(1)
    expect(computeDropIndex(rows, 70)).toBe(2)
  })

  it('正好压在中线上算「下一行」（`<` 严判，不给两个间隙同时命中）', () => {
    expect(computeDropIndex(rows, 20)).toBe(1)
    expect(computeDropIndex(rows, 66)).toBe(2)
  })

  it('越过最后一行 → 排在末尾（返回 rows.length）', () => {
    expect(computeDropIndex(rows, 133)).toBe(3)
    expect(computeDropIndex(rows, 9999)).toBe(3)
  })

  it('空列表 → 0（唯一合法间隙）', () => {
    expect(computeDropIndex([], 100)).toBe(0)
  })
})

describe('sandbox-rules-dnd · dropIndicatorTop', () => {
  it('插到某行之前 → 贴该行上沿', () => {
    expect(dropIndicatorTop(rows, 0)).toBe(0)
    expect(dropIndicatorTop(rows, 1)).toBe(46)
    expect(dropIndicatorTop(rows, 2)).toBe(92)
  })

  it('排在末尾 / 越界 → 贴末行下沿', () => {
    expect(dropIndicatorTop(rows, 3)).toBe(132)
    expect(dropIndicatorTop(rows, 99)).toBe(132)
  })

  it('空列表 → 0（指示线此时不渲染）', () => {
    expect(dropIndicatorTop([], 0)).toBe(0)
  })
})
