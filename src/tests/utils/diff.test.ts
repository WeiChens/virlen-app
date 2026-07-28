/**
 * Diff 工具测试 — 基于 LCS 的逐行 diff
 *
 * 覆盖场景：
 * - 完全相同的文本 → 全是 equal
 * - 完全不同的文本 → delete + insert
 * - 新增行 → insert
 * - 删除行 → delete
 * - 修改行 → delete(旧) + insert(新)
 * - 空数组输入
 * - 行号正确赋值
 * - countDiffRows 统计
 * - 混合操作（增删改混排）
 */
import { describe, it, expect } from 'vitest'
import { computeDiff, countDiffRows } from '@/utils/diff'

describe('computeDiff', () => {
  it('完全相同的文本应全部标记为 equal', () => {
    const oldLines = ['line1', 'line2', 'line3']
    const newLines = ['line1', 'line2', 'line3']
    const rows = computeDiff(oldLines, newLines, 1)

    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.type === 'equal')).toBe(true)
    expect(rows[0].oldLineNum).toBe(1)
    expect(rows[0].newLineNum).toBe(1)
    expect(rows[2].oldLineNum).toBe(3)
    expect(rows[2].newLineNum).toBe(3)
  })

  it('新增行应标记为 insert', () => {
    const oldLines = ['line1', 'line2']
    const newLines = ['line1', 'line2', 'line3']
    const rows = computeDiff(oldLines, newLines, 1)

    expect(rows).toHaveLength(3)
    expect(rows[0].type).toBe('equal')
    expect(rows[1].type).toBe('equal')
    expect(rows[2].type).toBe('insert')
    expect(rows[2].oldLine).toBeNull()
    expect(rows[2].newLine).toBe('line3')
  })

  it('删除行应标记为 delete', () => {
    const oldLines = ['line1', 'line2', 'line3']
    const newLines = ['line1', 'line3']
    const rows = computeDiff(oldLines, newLines, 1)

    // line2 被删除
    expect(rows.some((r) => r.type === 'delete' && r.oldLine === 'line2')).toBe(true)
  })

  it('最前面新增行应正确处理', () => {
    const oldLines = ['line2']
    const newLines = ['line1', 'line2']
    const rows = computeDiff(oldLines, newLines, 1)

    expect(rows).toHaveLength(2)
    expect(rows[0].type).toBe('insert')
    expect(rows[0].newLine).toBe('line1')
    expect(rows[1].type).toBe('equal')
  })

  it('最前面删除行应正确处理', () => {
    const oldLines = ['line1', 'line2']
    const newLines = ['line2']
    const rows = computeDiff(oldLines, newLines, 1)

    expect(rows).toHaveLength(2)
    expect(rows[0].type).toBe('delete')
    expect(rows[0].oldLine).toBe('line1')
    expect(rows[1].type).toBe('equal')
  })

  it('空旧文本应全部标记为 insert', () => {
    const oldLines: string[] = []
    const newLines = ['new1', 'new2']
    const rows = computeDiff(oldLines, newLines, 1)

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === 'insert')).toBe(true)
  })

  it('空新文本应全部标记为 delete', () => {
    const oldLines = ['old1', 'old2']
    const newLines: string[] = []
    const rows = computeDiff(oldLines, newLines, 1)

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === 'delete')).toBe(true)
  })

  it('两个空数组应返回空数组', () => {
    const rows = computeDiff([], [], 1)
    expect(rows).toHaveLength(0)
  })

  it('修改行应视为 delete + insert', () => {
    const oldLines = ['保持不变', '这行被修改了', '保持不变']
    const newLines = ['保持不变', '这是修改后的内容', '保持不变']
    const rows = computeDiff(oldLines, newLines, 1)

    expect(rows).toHaveLength(4)
    // 期望: equal(保持不变), delete(这行被修改了), insert(这是修改后的内容), equal(保持不变)
    expect(rows[0].type).toBe('equal')
    expect(rows[1].type).toBe('delete')
    expect(rows[2].type).toBe('insert')
    expect(rows[3].type).toBe('equal')
  })

  it('行号应从 startLine 开始递增', () => {
    const oldLines = ['a', 'b']
    const newLines = ['a', 'b']
    const rows = computeDiff(oldLines, newLines, 10)

    expect(rows[0].oldLineNum).toBe(10)
    expect(rows[0].newLineNum).toBe(10)
    expect(rows[1].oldLineNum).toBe(11)
    expect(rows[1].newLineNum).toBe(11)
  })

  it('delete 行应只有 oldLineNum，insert 行应只有 newLineNum', () => {
    const oldLines = ['del']
    const newLines: string[] = []
    const rows = computeDiff(oldLines, newLines, 5)

    expect(rows[0].type).toBe('delete')
    expect(rows[0].oldLineNum).toBe(5)
    expect(rows[0].newLineNum).toBeNull()
  })
})

describe('countDiffRows', () => {
  it('应正确统计增删行数', () => {
    const oldLines = ['a', 'b', 'c', 'd']
    const newLines = ['a', 'x', 'c']
    const rows = computeDiff(oldLines, newLines, 1)
    const counts = countDiffRows(rows)

    // a=equal, b→x=delete+insert, c=equal, d=delete
    // 所以: 2 delete, 1 insert
    expect(counts.delCount).toBe(2)
    expect(counts.insCount).toBe(1)
  })

  it('无变化时应返回全零', () => {
    const rows = computeDiff(['a', 'b'], ['a', 'b'], 1)
    const counts = countDiffRows(rows)
    expect(counts.delCount).toBe(0)
    expect(counts.insCount).toBe(0)
  })
})
