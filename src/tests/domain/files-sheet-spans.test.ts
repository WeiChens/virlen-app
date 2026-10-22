/**
 * 合并区域 → `colspan` / `rowspan` 的换算口径（表格预览）。
 *
 * 钉住四件事：
 * - 坐标是**整张表**的，要按物化窗口裁（表格只画已物化的行列）；
 * - 被覆盖的格子必须记 `null`（渲染时跳过），否则行里多出格子、列数当场对不上；
 * - 「裁完只剩一格」与重叠区域不能画出错位的表（宁可少画）；
 * - 异常区域（越界 / 巨大 / 反序）不抛错，也不让渲染卡死。
 */
import { describe, expect, it } from 'vitest'
import { buildSheetSpans, type MergedBounds } from '@/domain/files/sheet-spans'

describe('换算', () => {
  it('横跨 3 列：锚点带 colspan，右边两格记 null', () => {
    const spans = buildSheetSpans([{ rowFirst: 0, rowLast: 0, colFirst: 0, colLast: 2 }], 2, 3)
    expect(spans.get('0,0')).toEqual({ rowSpan: 1, colSpan: 3 })
    expect(spans.get('0,1')).toBeNull()
    expect(spans.get('0,2')).toBeNull()
    expect(spans.has('1,0')).toBe(false)
  })

  it('纵跨 2 行：锚点带 rowspan，下面那格记 null', () => {
    const spans = buildSheetSpans([{ rowFirst: 1, rowLast: 2, colFirst: 0, colLast: 0 }], 4, 3)
    expect(spans.get('1,0')).toEqual({ rowSpan: 2, colSpan: 1 })
    expect(spans.get('2,0')).toBeNull()
  })

  it('行列都跨：两个 span 都要对', () => {
    const spans = buildSheetSpans([{ rowFirst: 0, rowLast: 1, colFirst: 1, colLast: 2 }], 3, 3)
    expect(spans.get('0,1')).toEqual({ rowSpan: 2, colSpan: 2 })
    expect(spans.get('0,2')).toBeNull()
    expect(spans.get('1,1')).toBeNull()
    expect(spans.get('1,2')).toBeNull()
  })

  it('没有合并（或空白）→ 空表，不产生任何条目', () => {
    expect(buildSheetSpans(undefined, 3, 3).size).toBe(0)
    expect(buildSheetSpans([], 3, 3).size).toBe(0)
    expect(buildSheetSpans([{ rowFirst: 0, rowLast: 0, colFirst: 0, colLast: 0 }], 3, 3).size).toBe(0)
  })
})

describe('裁到物化窗口', () => {
  it('区域比窗口大：span 裁到最后一列 / 最后一行', () => {
    const spans = buildSheetSpans([{ rowFirst: 0, rowLast: 9, colFirst: 0, colLast: 9 }], 2, 3)
    expect(spans.get('0,0')).toEqual({ rowSpan: 2, colSpan: 3 })
    expect(spans.get('1,2')).toBeNull()
  })

  it('锚点在窗口外但区域伸进窗口：按窗口起点画（不丢内容，也不撑出表）', () => {
    // 行 -? 不合法的负坐标先夹到 0；列从 1 开始伸到 5，窗口只有 3 列
    const spans = buildSheetSpans([{ rowFirst: -2, rowLast: 0, colFirst: 1, colLast: 5 }], 2, 3)
    expect(spans.get('0,1')).toEqual({ rowSpan: 1, colSpan: 2 })
    expect(spans.get('0,2')).toBeNull()
  })

  it('完全落在窗口外的区域整片丢掉', () => {
    const spans = buildSheetSpans([{ rowFirst: 5, rowLast: 6, colFirst: 0, colLast: 1 }], 2, 3)
    expect(spans.size).toBe(0)
  })
})

describe('异常输入', () => {
  it('反序坐标（首尾颠倒）当越界丢掉，不抛错', () => {
    const reversed: MergedBounds = { rowFirst: 2, rowLast: 1, colFirst: 1, colLast: 0 }
    expect(buildSheetSpans([reversed], 4, 4).size).toBe(0)
  })

  it('重叠区域：先到先得，后一片不覆盖已画的 span', () => {
    const spans = buildSheetSpans(
      [
        { rowFirst: 0, rowLast: 0, colFirst: 0, colLast: 1 },
        { rowFirst: 0, rowLast: 0, colFirst: 0, colLast: 2 },
      ],
      2,
      3,
    )
    expect(spans.get('0,0')).toEqual({ rowSpan: 1, colSpan: 2 })
    expect(spans.get('0,1')).toBeNull()
    // 第二片被整片跳过：第 3 列没有被它记成 null
    expect(spans.has('0,2')).toBe(false)
  })

  it('铺满整张表的异常区域（超出预算）整片放弃，不让渲染卡死', () => {
    const spans = buildSheetSpans([{ rowFirst: 0, rowLast: 65535, colFirst: 0, colLast: 16383 }], 500, 40)
    expect(spans.size).toBe(0)
  })

  it('浮点 / 非法数值按整数处理，不产生半格', () => {
    const spans = buildSheetSpans(
      [{ rowFirst: 0.7, rowLast: 1.2, colFirst: 0, colLast: 1 } as MergedBounds],
      3,
      3,
    )
    expect(spans.get('0,0')).toEqual({ rowSpan: 2, colSpan: 2 })
  })
})
