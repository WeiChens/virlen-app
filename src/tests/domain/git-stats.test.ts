// @vitest-environment node
/**
 * 行数统计的取用口径（`domain/git/stats.ts`）：行按段查、**一段**的合计怎么算。
 *
 * 守的四条：
 * 1. **按段查**：同一个文件在两段各有改动时，行内取的是它所在那一段的数字（不合并、不串段）；
 * 2. **`null` 不是 0**：二进制 / 冲突没有数字 → 界面不画数字；合计置 `partial`（别把「不知道」当 0）；
 * 3. **合计只描述一段**：两段各算一次，绝不相加（变更列表已按 tab 一次只看一段）；
 * 4. **文件数来自快照**：统计没回来时也能给出这一段的文件数。
 */
import { describe, expect, it } from 'vitest'
import { sectionStatTotals, statOf } from '@/domain/git'
import type { GitChangeEntry, GitStatReport } from '@/domain/git'

function entry(path: string, x = '.', y = 'M'): GitChangeEntry {
  return { path, orig_path: null, x, y, kind: 'ordinary' }
}

const report: GitStatReport = {
  staged: [
    { path: 'a.txt', orig_path: null, added: 5, deleted: 0 },
    { path: 'both.txt', orig_path: null, added: 2, deleted: 1 },
  ],
  worktree: [
    { path: 'both.txt', orig_path: null, added: 7, deleted: 3 },
    { path: 'bin.dat', orig_path: null, added: null, deleted: null },
  ],
}

describe('statOf', () => {
  it('按段取：同一个文件在两段各有数字，互不串段', () => {
    expect(statOf(report, 'staged', 'both.txt')).toEqual({
      path: 'both.txt',
      orig_path: null,
      added: 2,
      deleted: 1,
    })
    expect(statOf(report, 'unstaged', 'both.txt')?.added).toBe(7)
  })

  it('没有这一行 / 没有统计 → null', () => {
    expect(statOf(report, 'staged', 'missing.txt')).toBeNull()
    expect(statOf(null, 'staged', 'a.txt')).toBeNull()
  })
})

describe('sectionStatTotals', () => {
  const list = (...paths: string[]): GitChangeEntry[] => paths.map((p) => entry(p))

  it('只算这一段、这一侧：同一个文件两段各算一次，不相加', () => {
    // `report` 里 a.txt 只有 staged 一侧，both.txt 两侧都有
    expect(sectionStatTotals('staged', list('a.txt', 'both.txt'), report)).toEqual({
      files: 2,
      added: 5 + 2,
      deleted: 0 + 1,
      partial: false,
    })
    expect(sectionStatTotals('unstaged', list('both.txt'), report)).toEqual({
      files: 1,
      added: 7,
      deleted: 3,
      partial: false,
    })
  })

  it('段里有、统计里没有的路径（未跟踪过多 / 冲突）→ partial，文件数照给', () => {
    const totals = sectionStatTotals('unstaged', list('both.txt', 'new.txt'), report)
    expect(totals.files).toBe(2)
    expect(totals.added).toBe(7)
    expect(totals.partial).toBe(true)
  })

  it('二进制那一行没数字 → partial（不当 0）', () => {
    const totals = sectionStatTotals('unstaged', list('bin.dat'), report)
    expect(totals.files).toBe(1)
    expect(totals.added).toBe(0)
    expect(totals.partial).toBe(true)
  })

  it('别的段有数字也绝不借进来', () => {
    // a.txt 只在 staged 一侧有数字：拿它查 unstaged 应当是 0 行 + partial
    const totals = sectionStatTotals('unstaged', list('a.txt'), report)
    expect(totals.added).toBe(0)
    expect(totals.deleted).toBe(0)
    expect(totals.partial).toBe(true)
  })

  it('统计还没回来：文件数照给、行数为 0，且不算 partial', () => {
    expect(sectionStatTotals('staged', list('a.txt', 'b.txt'), null)).toEqual({
      files: 2,
      added: 0,
      deleted: 0,
      partial: false,
    })
  })
})
