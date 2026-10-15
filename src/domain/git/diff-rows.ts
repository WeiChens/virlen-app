/**
 * git 差异行模型 —— 把 git 给的**两侧文本**变成左右对比可渲染的行（纯函数）。
 *
 * 复用既有的 LCS 实现（`src/utils/diff.ts::computeDiff`）与既有的视图（`SideBySideDiff`）：
 * 「左右对比」在本项目只有一份实现，git 差异不另起一套（见方案 §2.3）。
 *
 * 两件本模块独有的事：
 * 1. **空侧**（新增 / 删除）用零行表示，不能拿空串去 `split('\n')` —— 那会得到 `['']`，
 *    在界面上表现为凭空多出一行空白；
 * 2. **折叠连续未改动行**：大文件里只改一行时，全文照渲染会铺出几千行。按「改动前后各留 N 行」
 *    折叠成一条 `gap` 行 —— `SideBySideDiff` 本来就认这种行。
 */
import { computeDiff, countDiffRows, type DiffRow } from '@/utils/diff'
import type { GitDiffSides } from './types'

/** 可渲染的行：普通 diff 行 + 折叠间隔行（结构与 `SideBySideDiff` 的 `SideBySideRow` 一致） */
export type GitDiffRow = DiffRow | { type: 'gap' }

/** 折叠时保留的上下文行数（改动前后各留这么多） */
export const DIFF_CONTEXT_LINES = 3

/** 文本 → 行数组；`null`（空侧）与空串都得到零行 */
function toLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const lines = text.split('\n')
  // ⚠️ `"a\nb\n"` 只有 **2** 行：末尾换行是第 2 行的终止符，不是第 3 行空行。
  //    不丢它的话，每个文件末尾都会多出一行空白 —— 在左右对比里非常显眼（末尾多一行）。
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 两侧文本 → 可渲染的行（含折叠） */
export function buildDiffRows(
  sides: GitDiffSides,
  context: number = DIFF_CONTEXT_LINES,
): GitDiffRow[] {
  const rows = computeDiff(toLines(sides.old_text), toLines(sides.new_text), 1)
  return collapseEqualRuns(rows, context)
}

/**
 * 把连续的 `equal` 行折叠成「首尾各留 context 行、中间一条 gap」。
 *
 * 不折叠时行数 = 文件行数；折叠后 ≈ 改动行数 + 2×context。超过一整段的短省略**不插 gap**
 *（留 4 行以内的空档反而更难读）。
 */
export function collapseEqualRuns(
  rows: DiffRow[],
  context: number,
): GitDiffRow[] {
  const out: GitDiffRow[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].type !== 'equal') {
      out.push(rows[i])
      i += 1
      continue
    }
    // 找出一整段 equal
    let end = i
    while (end < rows.length && rows[end].type === 'equal') end += 1
    const runLength = end - i
    // 短段不折：省略 1–4 行的收益还不如它带来的视觉断裂
    if (runLength <= context * 2 + 1) {
      for (let k = i; k < end; k++) out.push(rows[k])
    } else {
      for (let k = i; k < i + context; k++) out.push(rows[k])
      out.push({ type: 'gap' })
      for (let k = end - context; k < end; k++) out.push(rows[k])
    }
    i = end
  }
  return out
}

/** 新增 / 删除行数（给视图的 `stat`） */
export function diffStat(rows: GitDiffRow[]): { delCount: number; insCount: number } {
  return countDiffRows(rows.filter((r): r is DiffRow => r.type !== 'gap'))
}
