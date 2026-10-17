/**
 * 行数统计的取用口径（`domain/git/stats.ts`）：行按段查、合计怎么算。
 *
 * 守的三条：
 * 1. **按段查**：同一个文件在两段各有改动时，行内取的是它所在那一段的数字（不合并、不串段）；
 * 2. **`null` 不是 0**：二进制 / 冲突没有数字 → 界面不画数字；合计置 `partial`（别把「不知道」当 0）；
 * 3. **文件数来自快照**：统计没回来时也能给出正确的文件数（徽标与汇总同一个口径）。
 */
import { describe, expect, it } from 'vitest'
import { statOf, statTotals } from '@/domain/git'
import type {
  GitChangeEntry,
  GitStatReport,
  GitStatusSnapshot,
} from '@/domain/git'

function entry(path: string, x = '.', y = 'M'): GitChangeEntry {
  return { path, orig_path: null, x, y, kind: 'ordinary' }
}

function snapshot(entries: GitChangeEntry[]): GitStatusSnapshot {
  return {
    head: { oid: 'a', branch: 'main', upstream: null, ahead: 0, behind: 0 },
    entries,
    truncated: false,
  }
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

describe('statTotals', () => {
  it('文件数按去重路径算，行数两段相加', () => {
    const totals = statTotals(snapshot([entry('a.txt'), entry('both.txt'), entry('both.txt', 'M', 'M')]), report)
    expect(totals.files).toBe(2)
    expect(totals.added).toBe(5 + 2 + 7)
    expect(totals.deleted).toBe(0 + 1 + 3)
    // 二进制那一行没数字 → 合计算「已知部分」，界面据此不把 +X 说成完整值
    expect(totals.partial).toBe(true)
  })

  it('统计没回来时：文件数照给，行数为 0 且不算 partial', () => {
    const totals = statTotals(snapshot([entry('a.txt'), entry('b.txt')]), null)
    expect(totals).toEqual({ files: 2, added: 0, deleted: 0, partial: false })
  })

  it('快照里有、统计里没有的路径（冲突 / 未跟踪过多）→ partial', () => {
    const totals = statTotals(snapshot([entry('a.txt'), entry('conflict.txt', 'U', 'U')]), report)
    expect(totals.files).toBe(2)
    expect(totals.partial).toBe(true)
  })
})
