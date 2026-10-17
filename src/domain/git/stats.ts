/**
 * 行数统计的**取用口径**（纯函数）：行怎么查、合计怎么算。
 *
 * 三条口径：
 * - **按段查**：已暂存的行用 `staged`（INDEX ↔ HEAD），未暂存 / 未跟踪的行用 `worktree`
 *   （工作区 ↔ INDEX）—— 同一个文件两段都有改动时，两行各算各的，不合并；
 * - **查不到就是 `null`**：二进制、数不出来的未跟踪文件、冲突文件（index 里没有 stage 0，
 *   `git diff` 不列它）都没有数字；界面显示「—」，**不许当 0**（0 是「这个文件一行没变」的意思）；
 * - **合计是「改动量」而不是「文件当前大小」**：同一个文件两段都改就两段相加；文件数按**去重后的
 *   路径**算（与标题栏徽标的口径一致）。
 */
import type { GitFileStat, GitStatReport, GitStatusSnapshot } from './types'

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

/** 顶部合计 */
export interface GitStatTotals {
  /** 有变更的文件数（路径去重） */
  files: number
  added: number
  deleted: number
  /** 有变更没算出来（二进制 / 冲突 / 未跟踪过大）—— 此时合计只是「已知部分」 */
  partial: boolean
}

/**
 * 合计：文件数来自**快照**（未加载统计时也能给出正确的文件数），增删行来自统计。
 * 统计缺失的行让 `partial = true`，界面据此把 `+X` 称作「至少」。
 */
export function statTotals(
  snapshot: GitStatusSnapshot | null,
  report: GitStatReport | null,
): GitStatTotals {
  const paths = new Set((snapshot?.entries ?? []).map((e) => e.path))
  let added = 0
  let deleted = 0
  let partial = false

  for (const list of [report?.staged ?? [], report?.worktree ?? []]) {
    for (const s of list) {
      if (s.added === null || s.deleted === null) {
        partial = true
        continue
      }
      added += s.added
      deleted += s.deleted
    }
  }
  // 快照里有、统计里没有的路径 = 没算出来（冲突 / 未跟踪过多 / 统计还没回来）
  if (report) {
    const counted = new Set(
      [...report.staged, ...report.worktree].filter(
        (s) => s.added !== null || s.deleted !== null,
      ).map((s) => s.path),
    )
    for (const path of paths) if (!counted.has(path)) partial = true
  }

  return { files: paths.size, added, deleted, partial }
}
