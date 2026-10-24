/**
 * 行数统计的**取用口径**（纯函数）：行怎么查、**一段**的合计怎么算。
 *
 * 四条口径：
 * - **按段查**：已暂存的行用 `staged`（INDEX ↔ HEAD），未暂存 / 未跟踪的行用 `worktree`
 *   （工作区 ↔ INDEX）—— 同一个文件两段都有改动时，两行各算各的，不合并；
 * - **查不到就是 `null`**：二进制、数不出来的未跟踪文件、冲突文件（index 里没有 stage 0，
 *   `git diff` 不列它）都没有数字；界面显示「—」，**不许当 0**（0 是「这个文件一行没变」的意思）；
 * - **合计是一段一段算的**：变更列表按 tab 一次只看一段，所以汇总也只描述那一段 —— 同一个文件
 *   两段都有改动时**两边各算一次**（两段的基准不同，相加等于把两份差异叠在一起）；
 * - **文件数按这一段的路径算**（与快照同源，统计没回来时也准）。
 */
import type { GitChangeEntry, GitFileStat, GitStatReport } from './types'

/** 一行所属的段（与 `domain/git/group.ts` 的 side 同义） */
export type GitStatSide = 'staged' | 'unstaged'

/** 查一条变更的行数；没有统计（未加载 / 二进制 / 冲突）→ `null` */
export function statOf(
  report: GitStatReport | null,
  side: GitStatSide,
  path: string,
): GitFileStat | null {
  if (!report) return null
  const list = side === 'staged' ? report.staged : report.worktree
  return list.find((s) => s.path === path) ?? null
}

/** 一段的合计（字段含义同下方注释：文件数 + 已知增删行 + 是否只算了“已知部分”） */
export interface GitStatTotals {
  /** 这一段有几个文件 */
  files: number
  added: number
  deleted: number
  /** 这一段里有文件数不出来（二进制 / 冲突 / 未跟踪过大）—— 此时合计只是「已知部分」 */
  partial: boolean
}

/**
 * **一段**的合计（变更列表按 tab 一次只看一段，汇总因此也只描述这一段）。
 *
 * 只取 `side` 那一侧的数字，并且只算 `entries` 里出现的路径 —— 段里没有的文件不能借进来。
 * 统计缺失（`report` 为 `null`）时给 0 行，**不算** `partial`（那不是「算不出来」，是「还没算」）。
 */
export function sectionStatTotals(
  side: GitStatSide,
  entries: readonly GitChangeEntry[],
  report: GitStatReport | null,
): GitStatTotals {
  const wanted = new Set(entries.map((entry) => entry.path))
  const counted = new Set<string>()
  let added = 0
  let deleted = 0
  let partial = false

  const list = (side === 'staged' ? report?.staged : report?.worktree) ?? []
  for (const stat of list) {
    if (!wanted.has(stat.path)) continue
    if (stat.added === null || stat.deleted === null) {
      partial = true
      continue
    }
    counted.add(stat.path)
    added += stat.added
    deleted += stat.deleted
  }
  // 这一段里有、统计里没有的路径 = 没算出来（二进制 / 冲突 / 未跟踪过多）
  if (report) {
    for (const path of wanted) if (!counted.has(path)) partial = true
  }

  return { files: entries.length, added, deleted, partial }
}
