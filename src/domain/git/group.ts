/**
 * git 状态分组的**纯函数**（唯一实现）—— 界面只消费这里的产物。
 *
 * 为什么分组放在前端而不是 Rust：Rust 那层是 porcelain=v2 的**忠实映射**（一行一条，
 * `x` / `y` 原样保留），而「哪一段算暂存、徽标数字怎么算」是界面口径 —— 放这里才能用 vitest 钉住，
 * 也才不会让「Rust 想改解析」与「界面想改分组」互相牵扯。
 */
import type { GitChangeEntry, GitStatusSnapshot } from './types'

/** 一个变更条目属于哪一段 */
export interface GitGroups {
  /** 暂存的更改（X ≠ `.`） */
  staged: GitChangeEntry[]
  /** 更改（Y ≠ `.`） */
  unstaged: GitChangeEntry[]
  /** 未跟踪 */
  untracked: GitChangeEntry[]
  /** 冲突（未合并）—— **单独一段**：这一段的文件上不给「暂存 / 丢弃」入口，避免语义误导 */
  conflicts: GitChangeEntry[]
}

/**
 * 把快照切成四段。
 *
 * ⚠️ 同一个文件**可能同时出现在 `staged` 与 `unstaged`**（已暂存的改动之后又改了工作区）——
 * 这是 git 的真实语义，不要为了「列表好看」去重：两段的 diff 基准不同（HEAD↔index / index↔工作区）。
 */
export function groupChanges(snapshot: GitStatusSnapshot | null): GitGroups {
  const groups: GitGroups = {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
  }
  if (!snapshot) return groups

  for (const entry of snapshot.entries) {
    if (entry.kind === 'untracked') {
      groups.untracked.push(entry)
      continue
    }
    if (entry.kind === 'unmerged') {
      groups.conflicts.push(entry)
      continue
    }
    if (isStaged(entry)) groups.staged.push(entry)
    if (isUnstaged(entry)) groups.unstaged.push(entry)
  }
  return groups
}

/** 已暂存：X ≠ `.`（未跟踪的 `?` 不算） */
export function isStaged(entry: GitChangeEntry): boolean {
  return entry.kind !== 'untracked' && entry.x !== '.' && entry.x !== '?'
}

/** 未暂存：Y ≠ `.` */
export function isUnstaged(entry: GitChangeEntry): boolean {
  return entry.kind !== 'untracked' && entry.y !== '.' && entry.y !== '?'
}

/**
 * 徽标数字 = **未提交的变更文件数（按路径去重）**，与 VS Code 活动栏口径一致。
 *
 * 去重的理由：暂存后又改了工作区的文件在两段各出现一次，但它仍然是**一个**文件；
 * 徽标回答的是「有多少文件等着我处理」，不是「有多少行列表项」。
 */
export function changedFileCount(snapshot: GitStatusSnapshot | null): number {
  if (!snapshot) return 0
  const paths = new Set<string>()
  for (const entry of snapshot.entries) paths.add(entry.path)
  return paths.size
}

/** 徽标文案（> 99 收敛成 `99+`，与任务清单 / 后台服务徽标同一口径） */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/** 列表里显示的字母（按所在段取那一侧的字母：暂存段看 X，未暂存段看 Y） */
export function statusLetter(
  entry: GitChangeEntry,
  side: 'staged' | 'unstaged',
): string {
  const raw = side === 'staged' ? entry.x : entry.y
  return raw === '.' || raw === '?' ? '?' : raw
}

/** 展示用路径：rename 显示成 `旧 → 新`（否则用户只看到新名字，以为多了个文件） */
export function displayPath(entry: GitChangeEntry): string {
  return entry.orig_path ? `${entry.orig_path} → ${entry.path}` : entry.path
}

/** 路径的文件名部分（列表只显示文件名，完整路径放 title） */
export function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/** 相对目录部分（用于列表第二行；根目录下的文件返回空串） */
export function dirName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}
