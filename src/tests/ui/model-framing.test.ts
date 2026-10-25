/**
 * 3D 预览的取景主体判定（`model-framing.ts`）。
 *
 * 为什么值得单测：这条规则决定「打开模型第一眼看到什么」。判错了不会报错、不会崩，
 * 只会让主体缩成画面中间一个小点（实测 `black_demon_castle.glb` 就是这个现象），
 * 肉眼很难判断是"模型有问题"还是"取景算错了"。
 */
import { describe, expect, it } from 'vitest'
import { subjectSpan, type BoxSpan } from '@/ui/pages/chat/components/workspace-file/model-framing'

/** 以中心 + 尺寸构造包围盒，用例里只看尺寸关系 */
function box(center: [number, number, number], size: [number, number, number]): BoxSpan {
  return {
    min: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2],
    max: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2],
  }
}

describe('取景主体 · subjectSpan', () => {
  it('剔除远处的星光散布与远景碎石，只框住城堡主体（实测模型的比例）', () => {
    const spans = [
      box([0, 0, 0], [498.3, 238.3, 480.1]), // Castle_Star：1400 个散落三角面
      box([0, 0, 0], [317.0, 39.4, 288.0]), // Castle_FarRock：远景碎石
      box([0, 10, 0], [35.0, 72.7, 50.7]), // Castle_Iron：铁塔
      box([0, 4, 0], [32.9, 28.4, 47.6]), // Castle_AshStone
      box([0, 8, 0], [35.2, 36.9, 50.0]), // Castle_Obsidian
      box([0, 1, 0], [55.8, 24.6, 62.0]), // Castle_IslandRock
      box([0, 31.5, 4], [10.4, 10.4, 10.4]), // Castle_Moon
    ]

    const span = subjectSpan(spans)
    expect(span).not.toBeNull()
    const width = span!.max[0] - span!.min[0]
    const height = span!.max[1] - span!.min[1]
    // 只剩主体：横向约 62、纵向约 73（铁塔撑起来），绝不再是 498
    expect(width).toBeLessThan(80)
    expect(height).toBeGreaterThan(70)
    expect(height).toBeLessThan(100)
  })

  it('单网格模型：原样返回（没有可比的邻居就不做离群判断）', () => {
    const only = box([1, 2, 3], [10, 20, 30])
    expect(subjectSpan([only])).toEqual(only)
  })

  it('所有网格都退化（对角线为 0）：退回全并，绝不返回空盒子', () => {
    const spans = [
      box([0, 0, 0], [0, 0, 0]),
      box([5, 0, 0], [0, 0, 0]),
      box([0, 5, 0], [0, 0, 0]),
    ]
    const span = subjectSpan(spans)
    expect(span).not.toBeNull()
    expect(span!.min).toEqual([0, 0, 0])
    expect(span!.max).toEqual([5, 5, 0])
  })

  it('没有网格（空模型）：返回 null，由调用方退回整树包围盒', () => {
    expect(subjectSpan([])).toBeNull()
  })
})
