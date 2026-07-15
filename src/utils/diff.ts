/** 一行 diff 结果 */
export type DiffRow = {
  type: 'equal' | 'delete' | 'insert'
  oldLine: string | null // delete/equal 时有值，insert 时为 null
  newLine: string | null // insert/equal 时有值，delete 时为 null
  oldLineNum: number | null
  newLineNum: number | null
}

/**
 * 基于 LCS（最长公共子序列）的逐行 diff。
 * 正确识别 equal / delete / insert，保证相同行不会因偏移误标为 change。
 */
export function computeDiff(
  oldLines: string[],
  newLines: string[],
  startLine: number,
): DiffRow[] {
  const m = oldLines.length
  const n = newLines.length

  // 构建 LCS DP 表
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // 回溯得到 diff 操作（逆序）
  const reversed: DiffRow[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({
        type: 'equal',
        oldLine: oldLines[i - 1],
        newLine: newLines[j - 1],
        oldLineNum: null,
        newLineNum: null,
      })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({
        type: 'insert',
        oldLine: null,
        newLine: newLines[j - 1],
        oldLineNum: null,
        newLineNum: null,
      })
      j--
    } else {
      reversed.push({
        type: 'delete',
        oldLine: oldLines[i - 1],
        newLine: null,
        oldLineNum: null,
        newLineNum: null,
      })
      i--
    }
  }

  // 翻转得到正向顺序
  const rows = reversed.reverse()

  // 正向遍历赋行号
  let oldLn = startLine
  let newLn = startLine
  for (const row of rows) {
    if (row.type === 'equal') {
      row.oldLineNum = oldLn++
      row.newLineNum = newLn++
    } else if (row.type === 'delete') {
      row.oldLineNum = oldLn++
      row.newLineNum = null
    } else {
      // insert
      row.oldLineNum = null
      row.newLineNum = newLn++
    }
  }

  return rows
}

/**
 * 从 diffRows 中统计删除行数和新增行数
 */
export function countDiffRows(diffRows: DiffRow[]): {
  delCount: number
  insCount: number
} {
  let delCount = 0
  let insCount = 0
  for (const row of diffRows) {
    if (row.type === 'delete') delCount++
    else if (row.type === 'insert') insCount++
  }
  return { delCount, insCount }
}
