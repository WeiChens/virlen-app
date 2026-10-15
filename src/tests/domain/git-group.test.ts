/**
 * git/group —— 状态分组与徽标口径的纯函数测试（**界面口径的唯一实现**）。
 *
 * 重点守三件事：
 * 1. 一个文件可以**同时**出现在「已暂存」与「未暂存」两段（git 的真实语义，不许去重）；
 * 2. 冲突与未跟踪各自独立成段，且**不与普通变更混在一起**（冲突段不给写入口）；
 * 3. 徽标数字按**路径去重**（同一个文件在两段出现两次只算一个）。
 */
import { describe, expect, it } from 'vitest'
import {
  badgeText,
  baseName,
  changedFileCount,
  dirName,
  displayPath,
  groupChanges,
  isStaged,
  isUnstaged,
  statusLetter,
} from '@/domain/git'
import type { GitChangeEntry, GitEntryKind, GitStatusSnapshot } from '@/domain/git'

function entry(
  path: string,
  x: string,
  y: string,
  kind: GitEntryKind = 'ordinary',
  orig_path: string | null = null,
): GitChangeEntry {
  return { path, orig_path, x, y, kind }
}

function snapshot(entries: GitChangeEntry[]): GitStatusSnapshot {
  return {
    head: { oid: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0 },
    entries,
    truncated: false,
  }
}

describe('groupChanges', () => {
  it('空快照 → 四段都空', () => {
    const g = groupChanges(null)
    expect(g.staged).toEqual([])
    expect(g.unstaged).toEqual([])
    expect(g.untracked).toEqual([])
    expect(g.conflicts).toEqual([])
  })

  it('XY=MM 的文件同时进「已暂存」与「未暂存」（不许去重）', () => {
    const g = groupChanges(snapshot([entry('a.txt', 'M', 'M')]))
    expect(g.staged.map((e) => e.path)).toEqual(['a.txt'])
    expect(g.unstaged.map((e) => e.path)).toEqual(['a.txt'])
  })

  it('只有 X 变 → 仅已暂存；只有 Y 变 → 仅未暂存', () => {
    const onlyX = groupChanges(snapshot([entry('a.txt', 'A', '.')]))
    expect(onlyX.staged).toHaveLength(1)
    expect(onlyX.unstaged).toHaveLength(0)

    const onlyY = groupChanges(snapshot([entry('b.txt', '.', 'M')]))
    expect(onlyY.staged).toHaveLength(0)
    expect(onlyY.unstaged).toHaveLength(1)
  })

  it('未跟踪与冲突各自成段，且不进暂存 / 未暂存', () => {
    const g = groupChanges(
      snapshot([
        entry('new.txt', '?', '?', 'untracked'),
        entry('conflict.txt', 'U', 'U', 'unmerged'),
      ]),
    )
    expect(g.untracked.map((e) => e.path)).toEqual(['new.txt'])
    expect(g.conflicts.map((e) => e.path)).toEqual(['conflict.txt'])
    expect(g.staged).toHaveLength(0)
    expect(g.unstaged).toHaveLength(0)
  })

  it('isStaged / isUnstaged 对未跟踪返回 false', () => {
    const u = entry('new.txt', '?', '?', 'untracked')
    expect(isStaged(u)).toBe(false)
    expect(isUnstaged(u)).toBe(false)
    expect(isStaged(entry('a.txt', 'M', '.'))).toBe(true)
    expect(isUnstaged(entry('a.txt', '.', 'M'))).toBe(true)
  })
})

describe('changedFileCount / badgeText', () => {
  it('按路径去重：同一个文件在两段各出现一次只算一个', () => {
    expect(changedFileCount(snapshot([entry('a.txt', 'M', 'M')]))).toBe(1)
  })

  it('把暂存 / 未暂存 / 未跟踪 / 冲突一起算进来', () => {
    const snap = snapshot([
      entry('a.txt', 'M', 'M'),
      entry('b.txt', 'A', '.'),
      entry('c.txt', '.', 'M'),
      entry('new.txt', '?', '?', 'untracked'),
      entry('conflict.txt', 'U', 'U', 'unmerged'),
    ])
    expect(changedFileCount(snap)).toBe(5)
  })

  it('空快照 → 0；超过 99 收敛成 99+', () => {
    expect(changedFileCount(null)).toBe(0)
    expect(badgeText(0)).toBe('0')
    expect(badgeText(7)).toBe('7')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})

describe('statusLetter / displayPath / 路径拆分', () => {
  it('按所在段取那一侧的字母', () => {
    const e = entry('a.txt', 'M', 'R')
    expect(statusLetter(e, 'staged')).toBe('M')
    expect(statusLetter(e, 'unstaged')).toBe('R')
  })

  it('未跟踪取到 `?` 侧时归一成 `?`', () => {
    expect(statusLetter(entry('new.txt', '?', '?', 'untracked'), 'unstaged')).toBe('?')
  })

  it('rename 显示成 旧 → 新', () => {
    const renamed = entry('new.txt', 'R', '.', 'renamed', 'old.txt')
    expect(displayPath(renamed)).toBe('old.txt → new.txt')
    expect(displayPath(entry('a.txt', 'M', '.'))).toBe('a.txt')
  })

  it('baseName / dirName 取文件名与相对目录', () => {
    expect(baseName('src/ui/a.tsx')).toBe('a.tsx')
    expect(dirName('src/ui/a.tsx')).toBe('src/ui')
    expect(baseName('a.txt')).toBe('a.txt')
    expect(dirName('a.txt')).toBe('')
  })
})
