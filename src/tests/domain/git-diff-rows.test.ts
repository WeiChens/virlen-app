// @vitest-environment node
/**
 * git 差异的视图模型 —— 两侧文本 → 行（`gitDiffRows`）+ 空侧判定（`singleSideOf`）。
 *
 * 守三件事：
 * 1. **空侧**（新增 / 删除 / 未跟踪）不能凭空多出一行空白，且 `null` 与空串同义；
 * 2. **不折叠未改动行**（实测反馈：不要用 … 省略相同的部分）—— 差异弹窗给的是整个文件，
 *    改动行前后有多少未改动行，用户自己看得到；
 * 3. 行内是**字符级片段**（一行里改了几个字，只有那几个字被标出来）。
 */
import { describe, expect, it } from 'vitest'
import { gitDiffRows, singleSideOf } from '@/domain/git'
import type { GitDiffSides } from '@/domain/git'

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

/** 行数固定的一段文本（用于「不折叠」用例） */
const lines = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `line ${i} ${tag}`).join('\n') + '\n'

describe('gitDiffRows', () => {
  it('新增文件（旧侧为空）：全是 added，左半为空', () => {
    const rows = gitDiffRows(sides(null, 'a\nb\n'))
    expect(rows.every((r) => r.type === 'added')).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[0].left).toEqual([])
    expect(rows[0].rightLineNo).toBe(1)
  })

  it('删除文件（新侧为空）：全是 removed，右半为空', () => {
    const rows = gitDiffRows(sides('a\nb\n', null))
    expect(rows.every((r) => r.type === 'removed')).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[0].right).toEqual([])
    expect(rows[0].leftLineNo).toBe(1)
  })

  it('两侧都空 → 零行（不是一行空白）', () => {
    expect(gitDiffRows(sides(null, null))).toEqual([])
    expect(gitDiffRows(sides('', ''))).toEqual([])
  })

  it('末尾换行不算一行："a\\n" 只有 1 行', () => {
    expect(gitDiffRows(sides(null, 'a\n'))).toHaveLength(1)
    expect(gitDiffRows(sides('a\n', null))).toHaveLength(1)
    expect(gitDiffRows(sides(null, 'a'))).toHaveLength(1)
  })

  it('中间的空行是真行，不能被丢掉', () => {
    expect(gitDiffRows(sides(null, 'a\n\nb'))).toHaveLength(3)
  })

  it('一行改几个字：一行 modified + 字符级片段（两侧成对）', () => {
    const rows = gitDiffRows(sides('const a = 1\n', 'const a = 2\n'))
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('modified')
    expect(rows[0].left).toEqual([
      { type: 'equal', value: 'const a = ' },
      { type: 'removed', value: '1' },
    ])
    expect(rows[0].right).toEqual([
      { type: 'equal', value: 'const a = ' },
      { type: 'added', value: '2' },
    ])
  })

  it('**不折叠**未改动行：500 行的文件改 1 行就是 500 行（不是 7 行，也不是 1 行）', () => {
    const rows = gitDiffRows(sides(lines(500, 'same'), lines(500, 'same').replace('line 250 same', 'line 250 CHANGED')))
    expect(rows).toHaveLength(500)
    expect(rows.filter((r) => r.type === 'modified')).toHaveLength(1)
    // 没有省略行这种东西
    expect(rows.some((r) => (r as { type: string }).type === 'gap')).toBe(false)
  })
})

describe('singleSideOf', () => {
  it('删除（新侧为空）→ 只留「原文件」那一栏', () => {
    expect(singleSideOf(sides('a\n', null))).toBe('old')
  })

  it('新增 / 未跟踪（旧侧为空）→ 只留「新文件」那一栏', () => {
    expect(singleSideOf(sides(null, 'a\n'))).toBe('new')
  })

  it('两侧都有内容 → null（照常双栏）', () => {
    expect(singleSideOf(sides('a\n', 'b\n'))).toBeNull()
    // 空文件不比单侧：`''` 是「有内容且为空」，不是空侧
    expect(singleSideOf(sides('', 'a\n'))).toBeNull()
  })

  it('两侧都空 / 二进制 → null（没有「保留哪一栏」可言；二进制另走提示）', () => {
    expect(singleSideOf(sides(null, null))).toBeNull()
    expect(singleSideOf({ ...sides(null, null), binary: true })).toBeNull()
    expect(singleSideOf({ ...sides('a\n', null), binary: true })).toBeNull()
  })
})
