/**
 * git 差异的**视图模型** —— 把 Rust 给的「两侧文本」变成左右对比可渲染的行。
 *
 * 算法与行模型都来自唯一实现 `utils/diff.ts`（jsdiff 的 diffLines + 组内 diffChars，
 * 与 xwjc-app 的 `VersionCompareDetailPage/diff.js` 同一套）；本模块只做三件 git 特有的事：
 *
 * 1. **空侧**：`null` 表示「这一侧没有内容」（新增 / 未跟踪的旧侧、删除的新侧、未合并取不到的那侧），
 *    换成空串交给内核（`""` 与 `null` 在 diff 里是同一件事）；
 * 2. **不折叠未改动行**（实测反馈：不要用 … 省略相同的部分）：差异弹窗给的是**整个文件**，
 *    改动行前后到底有多少未改动行，用户自己看得到；
 * 3. **单侧判定**（[`singleSideOf`]）：只有一侧有内容时，另一栏整栏不画。
 *
 * ⚠️ `gitDiffRows` 目前**没有生产调用方**：差异弹窗的正文已改成 Monaco（见 §11.53 ㉙）——
 * 两栏形态直接拿两侧全文，单侧形态由 Monaco 的整行装饰上色，都不必先比成行。它与 `buildDiffRows`
 * 一起由 `src/tests/domain/git-diff-rows.test.ts` 看着，留着是为了行模型本身（聊天内联 diff 仍在用）。
 *
 * ⚠️ 与「取内容」那一侧是成对的契约：Rust `git/diff.rs::to_text` 的空侧必须是 `None`
 * 而不是 `Some("")`，否则单侧判定失效（用例 `diff_sides_deleted_file_leaves_new_side_empty`）。
 */
import { buildDiffRows, type DiffRow } from '@/utils/diff'
import type { GitDiffSides } from './types'

/**
 * 两侧文本 → 可渲染的行（含行内字符级片段）。行号从 1 起，与 git 的行号口径一致。
 *
 * 行模型是 `utils/diff` 的那一套（「左右对比」在本项目只有一份实现，`SideBySideDiff` 消费它）。
 * ⚠️ git 差异弹窗已不再调用它（正文换成 Monaco，见 §11.53 ㉙）—— 保留的理由见文件头。
 */
export function gitDiffRows(sides: GitDiffSides): DiffRow[] {
  return buildDiffRows(sides.old_text, sides.new_text, 1)
}

/**
 * 「这一份差异只有一侧」时返回**要保留的那一侧**；两侧都有内容返回 `null`。
 *
 * 依据是**内容**而不是状态字母：`null` 是 Rust `git/diff.rs::to_text` 的「空侧」口径（新增 / 未跟踪的
 * 旧侧、删除的新侧、未合并取不到的那一侧）。要回答的是「这份差异里有没有另一侧」，而状态字母是列表的
 * 展示口径 —— 两者不该互相假设（同一条路径在两段的字母还不一样）。
 *
 * ⚠️ `binary` 时两侧都是 `null`（正文压根没拉），此时不适用 —— 二进制另走「无法显示差异」提示。
 */
export function singleSideOf(sides: GitDiffSides): 'old' | 'new' | null {
  if (sides.binary) return null
  if (sides.new_text === null) return sides.old_text === null ? null : 'old'
  if (sides.old_text === null) return 'new'
  return null
}
