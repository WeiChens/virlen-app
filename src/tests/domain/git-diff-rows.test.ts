/**
 * git/diff-rows —— 「git 给的两侧文本 → 可渲染行」的纯函数测试。
 *
 * 守两件事：
 * 1. **空侧**（新增 / 删除 / 未跟踪）不能凭空多出一行空白（空串 split 会得到 `['']`）；
 * 2. 连续未改动行的**折叠**：大文件只改一行时不许把几千行都铺出来，同时上下文不能丢。
 */
import { describe, expect, it } from 'vitest'
import {
  buildDiffRows,
  collapseEqualRuns,
  diffStat,
} from '@/domain/git'
import type { GitDiffSides } from '@/domain/git'
import type { DiffRow } from '@/utils/diff'

function sides(oldText: string | null, newText: string | null): GitDiffSides {
  return {
    old_text: oldText,
    new_text: newText,
    old_label: 'INDEX',
    new_label: '工作区',
    binary: false,
    truncated: false,
  }
}

/** 造一段 equal 行（只测折叠逻辑，不需要真内容） */
function equals(count: number, offset = 0): DiffRow[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'equal' as const,
    oldLine: `l${offset + i}`,
    newLine: `l${offset + i}`,
    oldLineNum: offset + i + 1,
    newLineNum: offset + i + 1,
  }))
}

describe('buildDiffRows', () => {
  it('新增文件：旧侧为空 → 全是 insert，且没有多出一行空白', () => {
    const rows = buildDiffRows(sides(null, 'a\nb\n'))
    expect(rows.every((r) => r.type === 'insert')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('删除文件：新侧为空 → 全是 delete', () => {
    const rows = buildDiffRows(sides('a\nb\n', null))
    expect(rows.every((r) => r.type === 'delete')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('两侧都空 → 零行（不是一行空白）', () => {
    expect(buildDiffRows(sides(null, null))).toEqual([])
    expect(buildDiffRows(sides('', ''))).toEqual([])
  })

  it('末尾换行不算一行："a\\n" 只有 1 行', () => {
    expect(buildDiffRows(sides(null, 'a\n'))).toHaveLength(1)
    expect(buildDiffRows(sides('a\n', null))).toHaveLength(1)
    // 没有末尾换行的文件同样 1 行
    expect(buildDiffRows(sides(null, 'a'))).toHaveLength(1)
  })

  it('中间的空行是真行，不能被丢掉', () => {
    // "a\n\nb" = 3 行（a / 空行 / b）
    expect(buildDiffRows(sides(null, 'a\n\nb'))).toHaveLength(3)
  })

  it('单行改动：改动行 + 上下文，行号两侧各自连续', () => {
    const rows = buildDiffRows(sides('a\nb\nc\n', 'a\nB\nc\n'))
    const types = rows.map((r) => r.type)
    expect(types).toContain('delete')
    expect(types).toContain('insert')
    // 两侧都从 1 开始编号，且不出现空档
    const oldNums = rows
      .filter((r): r is DiffRow => r.type !== 'gap' && r.type !== 'insert')
      .map((r) => r.oldLineNum)
    expect(oldNums).toEqual([1, 2, 3])
  })
})

describe('collapseEqualRuns', () => {
  it('短段（≤ 2×context+1）不折叠', () => {
    const rows = collapseEqualRuns(equals(7), 3)
    expect(rows).toHaveLength(7)
    expect(rows.some((r) => r.type === 'gap')).toBe(false)
  })

  it('长段折叠成「头 context 行 + gap + 尾 context 行」', () => {
    const rows = collapseEqualRuns(equals(100), 3)
    expect(rows).toHaveLength(7)
    expect(rows[3]).toEqual({ type: 'gap' })
    // 头 3 行取原段开头，尾 3 行取原段结尾
    expect((rows[0] as DiffRow).oldLineNum).toBe(1)
    expect((rows[6] as DiffRow).oldLineNum).toBe(100)
  })

  it('改动行永远不被折叠掉', () => {
    const mid: DiffRow = {
      type: 'delete',
      oldLine: 'x',
      newLine: null,
      oldLineNum: 60,
      newLineNum: null,
    }
    const rows = collapseEqualRuns([...equals(50), mid, ...equals(50, 50)], 3)
    expect(rows.some((r) => r.type === 'delete')).toBe(true)
    expect(rows.filter((r) => r.type === 'gap')).toHaveLength(2)
  })

  it('多段长 equal 各自折叠', () => {
    const rows = collapseEqualRuns(
      [...equals(20), { type: 'insert', oldLine: null, newLine: 'n', oldLineNum: null, newLineNum: 21 } as DiffRow, ...equals(20, 20)],
      2,
    )
    expect(rows.filter((r) => r.type === 'gap')).toHaveLength(2)
    expect(rows.filter((r) => r.type === 'insert')).toHaveLength(1)
  })
})

describe('diffStat', () => {
  it('统计新增 / 删除行数，忽略 gap', () => {
    const rows: DiffRow[] = [
      ...equals(50),
      { type: 'delete', oldLine: 'x', newLine: null, oldLineNum: 51, newLineNum: null },
      { type: 'insert', oldLine: null, newLine: 'y', oldLineNum: null, newLineNum: 51 },
    ]
    const stat = diffStat(collapseEqualRuns(rows, 3))
    expect(stat).toEqual({ delCount: 1, insCount: 1 })
  })
})
