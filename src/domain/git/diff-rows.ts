/**
 * git 差异的**视图模型**：两侧文本 → 左右对比行。行模型来自唯一实现 `utils/diff.ts`，
 * 本模块只做三件 git 特有的事：空侧 `null` → `""`；不折叠未改动行；单侧判定（`singleSideOf`）。
 * ⚠️ `gitDiffRows` 目前**无生产调用方**（差异弹窗已换 Monaco），留着是为了行模型本身（聊天内联 diff 仍用），
 * 由 `tests/domain/git-diff-rows.test.ts` 看着。
 * ⚠️ 与 Rust `git/diff.rs::to_text` 成对：空侧必须是 `None` 而非 `Some("")`，否则单侧判定失效。
 */
import { buildDiffRows, type DiffRow } from '@/utils/diff'
import type { GitDiffSides } from './types'

/**
 * 两侧文本 → 可渲染行（行号从 1 起）。⚠️ 差异弹窗已不调用（用 Monaco），保留理由见文件头。
 */
export function gitDiffRows(sides: GitDiffSides): DiffRow[] {
  return buildDiffRows(sides.old_text, sides.new_text, 1)
}

/**
 * 「只有一侧」时返回要保留的那侧，两侧都有内容返回 `null`。依据是**内容**而非状态字母
 * （同一条路径在两段的字母还不一样）。⚠️ `binary` 时两侧皆 `null`，不适用。
 */
export function singleSideOf(sides: GitDiffSides): 'old' | 'new' | null {
  if (sides.binary) return null
  if (sides.new_text === null) return sides.old_text === null ? null : 'old'
  if (sides.old_text === null) return 'new'
  return null
}
