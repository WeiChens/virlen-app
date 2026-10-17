/**
 * 「左右对比」的唯一实现（SideBySideDiff 的输入行模型）。
 * 用 jsdiff 的 diffLines + diffChars：先按行分组，每个改动组内部再做字符级 diff，
 * 于是「一行改两个字」是行内片段，而换行变更以 ↵ 标出。
 *
 * 两处取舍：不折叠未改动行（省略行由视图层插）；组内字符级 diff 有规模 / 编辑距离上限，
 * 超限降级成整行红绿，避免「整个文件重写」卡死界面。
 */
import { diffChars, diffLines, type ChangeObject } from 'diff'

/** 行内片段：一段文本 + 它在两侧的归属 */
export interface WordPart {
  type: 'equal' | 'removed' | 'added'
  value: string
}

export type DiffRowType = 'equal' | 'removed' | 'added' | 'modified'

/**
 * 一行对齐结果。两侧成对：equal 两侧相同；removed / added 是单侧行（另一侧空，占一个空行盒保持对齐）；
 * modified 两侧都有且内容不同，各带字符级片段。
 */
export interface DiffRow {
  type: DiffRowType
  /** 行号；续行与单侧行的另一侧为 null（留空，不重复打号） */
  leftLineNo: number | null
  /** 右侧（新）行号，语义同上 */
  rightLineNo: number | null
  left: WordPart[]
  right: WordPart[]
}

/** 换行标记：行内可视化「这里新增 / 删除了一个换行」 */
export const NL_MARK = '\u21b5' // ↵

/**
 * 性能兜底（上限来自实测：10000 行全重写从 20s 降到 0.33s）。
 * 中止不是抛错而是降级：退成整行红绿或「公共前后缀 + 中间整段」，用户仍看得到差异。
 */
const MAX_GROUP_CHARS = 10_000
/** 字符级 diff 的编辑距离上限（超出时 jsdiff 返回 undefined） */
const MAX_CHAR_EDITS = 2_000
/** 行级 diff 的编辑距离上限（超出时 jsdiff 返回 undefined，见 coarseRows） */
const MAX_LINE_EDITS = 2_000

/**
 * 按行拆开并丢掉末尾换行带来的空元素（否则每个文件末尾多一行空白）；CRLF 归一成 LF。
 */
function splitLines(value: string): string[] {
  const v = value.replace(/\r\n/g, '\n')
  if (v === '') return []
  const arr = v.split('\n')
  if (v.endsWith('\n')) arr.pop()
  return arr
}

/** 追加片段；同类型相邻片段合并（减少渲染节点） */
function pushPart(buf: WordPart[], type: WordPart['type'], value: string): void {
  if (value === '') return
  const last = buf[buf.length - 1]
  if (last && last.type === type) last.value += value
  else buf.push({ type, value })
}

/**
 * 组内两侧文本 → 行对齐。换行时按归属推进对应侧行号；只有一侧有换行时另一侧续行（行号不变），
 * added / removed 的换行在对应侧追加 ↵。
 * @param startLeftNo 进入本组前左侧已输出的行号
 */
function buildGroupRows(
  oldGroup: string,
  newGroup: string,
  startLeftNo: number,
  startRightNo: number,
): { rows: DiffRow[]; leftNo: number; rightNo: number } {
  const parts: ChangeObject<string>[] | null =
    oldGroup === '' && newGroup === ''
      ? []
      : oldGroup.length + newGroup.length > MAX_GROUP_CHARS
        ? null
        : (diffChars(oldGroup, newGroup, { maxEditLength: MAX_CHAR_EDITS }) ??
          null)
  // 超出规模 / 编辑距离上限：退化成整行红绿
  if (parts === null) return lineLevelRows(oldGroup, newGroup, startLeftNo, startRightNo)

  const rows: DiffRow[] = []
  let leftNo = startLeftNo
  let rightNo = startRightNo
  let leftOpen = false // 当前行左侧是否已开行（区分续行与另起新行）
  let rightOpen = false
  let leftBuf: WordPart[] = []
  let rightBuf: WordPart[] = []
  let prevLeftLine: number | null = null // 上一行已输出的左侧行号（续行时留空）
  let prevRightLine: number | null = null

  function flush(): void {
    const leftHas = leftBuf.length > 0
    const rightHas = rightBuf.length > 0
    if (!leftHas && !rightHas) {
      leftBuf = []
      rightBuf = []
      return
    }
    const allEqual =
      leftHas &&
      rightHas &&
      leftBuf.every((p) => p.type === 'equal') &&
      rightBuf.every((p) => p.type === 'equal')
    let type: DiffRowType
    if (allEqual) type = 'equal'
    else if (!leftHas) type = 'added'
    else if (!rightHas) type = 'removed'
    else type = 'modified'

    const leftDisplay = leftHas && leftNo !== prevLeftLine ? leftNo : null
    const rightDisplay = rightHas && rightNo !== prevRightLine ? rightNo : null
    if (leftHas) prevLeftLine = leftNo
    if (rightHas) prevRightLine = rightNo

    rows.push({
      type,
      leftLineNo: leftDisplay,
      rightLineNo: rightDisplay,
      left: leftBuf,
      right: rightBuf,
    })
    leftBuf = []
    rightBuf = []
  }

  for (const part of parts) {
    const status: WordPart['type'] = part.added
      ? 'added'
      : part.removed
        ? 'removed'
        : 'equal'
    const segments = part.value.split('\n')
    for (let s = 0; s < segments.length; s += 1) {
      if (s > 0) {
        // 换行本身是 added / removed 时先在对应侧打上 ↵
        if (status === 'added') pushPart(rightBuf, 'added', NL_MARK)
        else if (status === 'removed') pushPart(leftBuf, 'removed', NL_MARK)
        flush()
        if (status === 'equal') {
          leftOpen = false
          rightOpen = false
        } else if (status === 'removed') {
          leftOpen = false // 左侧行结束，右侧续行
        } else {
          rightOpen = false // 右侧行结束，左侧续行
        }
      }
      const seg = segments[s]
      if (seg === '') continue
      if (status !== 'added') {
        if (!leftOpen) {
          leftNo += 1
          leftOpen = true
        }
        pushPart(leftBuf, status, seg)
      }
      if (status !== 'removed') {
        if (!rightOpen) {
          rightNo += 1
          rightOpen = true
        }
        pushPart(rightBuf, status, seg)
      }
    }
  }
  flush()

  return { rows, leftNo, rightNo }
}

/** 退化路径：不做字符级对比，删除行一段、新增行一段 */
function lineLevelRows(
  oldGroup: string,
  newGroup: string,
  startLeftNo: number,
  startRightNo: number,
): { rows: DiffRow[]; leftNo: number; rightNo: number } {
  const rows: DiffRow[] = []
  let leftNo = startLeftNo
  let rightNo = startRightNo
  for (const line of splitLines(oldGroup)) {
    leftNo += 1
    rows.push({
      type: 'removed',
      leftLineNo: leftNo,
      rightLineNo: null,
      left: [{ type: 'removed', value: line }],
      right: [],
    })
  }
  for (const line of splitLines(newGroup)) {
    rightNo += 1
    rows.push({
      type: 'added',
      leftLineNo: null,
      rightLineNo: rightNo,
      left: [],
      right: [{ type: 'added', value: line }],
    })
  }
  return { rows, leftNo, rightNo }
}

/**
 * 两段文本 → 行对齐的差异行（视图的唯一输入）。
 * @param oldText 旧侧全文（null = 没有这一侧）
 * @param startLine 首行行号；edit_file 传文件真实起始行号，打出来的是绝对行号
 */
export function buildDiffRows(
  oldText: string | null,
  newText: string | null,
  startLine = 1,
): DiffRow[] {
  const oldAll = oldText ?? ''
  const newAll = newText ?? ''
  // 超大规模不赌 jsdiff 能算完（见 MAX_LINE_EDITS）
  const parts = diffLines(oldAll, newAll, { maxEditLength: MAX_LINE_EDITS })
  if (parts === undefined) return coarseRows(oldAll, newAll, startLine)

  const rows: DiffRow[] = []
  let leftNo = startLine - 1
  let rightNo = startLine - 1
  let i = 0

  while (i < parts.length) {
    const part = parts[i]

    // 未变化块：两侧逐行相同
    if (!part.added && !part.removed) {
      for (const line of splitLines(part.value)) {
        leftNo += 1
        rightNo += 1
        rows.push({
          type: 'equal',
          leftLineNo: leftNo,
          rightLineNo: rightNo,
          left: [{ type: 'equal', value: line }],
          right: [{ type: 'equal', value: line }],
        })
      }
      i += 1
      continue
    }

    // 收集连续的删除 / 新增块（同一个改动组）
    const removedLines: string[] = []
    const addedLines: string[] = []
    while (i < parts.length && (parts[i].removed || parts[i].added)) {
      if (parts[i].removed) removedLines.push(...splitLines(parts[i].value))
      if (parts[i].added) addedLines.push(...splitLines(parts[i].value))
      i += 1
    }

    const group = buildGroupRows(
      removedLines.join('\n'),
      addedLines.join('\n'),
      leftNo,
      rightNo,
    )
    rows.push(...group.rows)
    leftNo = group.leftNo
    rightNo = group.rightNo
  }

  return rows
}

/**
 * 行级 diff 中止时的降级：公共前后缀照常对齐，中间整段先删后增。
 * 前后缀是 O(n) 就能确定的真实相等行，中间本来就是改动区。
 */
function coarseRows(
  oldText: string,
  newText: string,
  startLine: number,
): DiffRow[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const rows: DiffRow[] = []
  let leftNo = startLine
  let rightNo = startLine
  const pushEqual = (line: string): void => {
    rows.push({
      type: 'equal',
      leftLineNo: leftNo,
      rightLineNo: rightNo,
      left: [{ type: 'equal', value: line }],
      right: [{ type: 'equal', value: line }],
    })
    leftNo += 1
    rightNo += 1
  }

  for (let i = 0; i < prefix; i += 1) pushEqual(oldLines[i])
  for (let i = prefix; i < oldLines.length - suffix; i += 1) {
    rows.push({
      type: 'removed',
      leftLineNo: leftNo,
      rightLineNo: null,
      left: [{ type: 'removed', value: oldLines[i] }],
      right: [],
    })
    leftNo += 1
  }
  for (let i = prefix; i < newLines.length - suffix; i += 1) {
    rows.push({
      type: 'added',
      leftLineNo: null,
      rightLineNo: rightNo,
      left: [],
      right: [{ type: 'added', value: newLines[i] }],
    })
    rightNo += 1
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
    pushEqual(oldLines[i])
  }

  return rows
}

/**
 * 汇总差异行数。modified 两侧各算一行，否则「改了 N 行」会显示成无变更。
 */
export function diffStats(rows: DiffRow[]): {
  delCount: number
  insCount: number
  modifiedCount: number
  equalCount: number
} {
  let delCount = 0
  let insCount = 0
  let modifiedCount = 0
  let equalCount = 0
  for (const row of rows) {
    if (row.type === 'removed') delCount += 1
    else if (row.type === 'added') insCount += 1
    else if (row.type === 'modified') {
      modifiedCount += 1
      delCount += 1
      insCount += 1
    } else equalCount += 1
  }
  return { delCount, insCount, modifiedCount, equalCount }
}

/**
 * 全角 / 宽字符判定：只为了把宽度往宽了估（估窄会裁掉行尾）。
 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** 一侧的片段宽度（ch）：制表符 8、宽字符 2、其余 1 */
function partsWidthCh(parts: WordPart[]): number {
  let n = 0
  for (const part of parts) {
    for (const ch of part.value) {
      if (ch === '\t') n += 8
      else if (ch === NL_MARK) n += 1
      else n += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
    }
  }
  return n
}

/** 同一份行数据会被原位 / 全屏各问一次，算一次就够 */
const _widthChCache = new WeakMap<object, number>()

/**
 * 最长一行的等宽字符宽（ch），决定横向滚动宽度（--diff-max-ch）。
 * 不能用 CSS max-content：content-visibility 会跳过屏外行、不参与尺寸计算，列宽会忽宽忽窄。
 */
export function maxDiffWidthCh(
  rows: ReadonlyArray<DiffRow | { type: 'gap' }>,
): number {
  const hit = _widthChCache.get(rows)
  if (hit !== undefined) return hit
  let max = 0
  for (const row of rows) {
    // 省略间隔行不占宽度
    if (row.type === 'gap') continue
    const w = Math.max(partsWidthCh(row.left), partsWidthCh(row.right))
    if (w > max) max = w
  }
  _widthChCache.set(rows, max)
  return max
}

/** 老行模型：equal / delete / insert + 左右整行文本 */
interface LegacyDiffRow {
  type?: string
  oldLine?: string | null
  newLine?: string | null
  oldLineNum?: number | null
  newLineNum?: number | null
}

/**
 * 把历史消息里落库的差异行归一成当前模型。按老口径归一（不重算）：老消息当初显示什么样，
 * 现在还得是什么样，否则会与当时看到的、以及增删统计对不上。
 */
export function normalizeDiffRows(rows: unknown): DiffRow[] {
  if (!Array.isArray(rows)) return []
  const out: DiffRow[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    // 省略行不会落库；真出现了也跳过
    if (r.type === 'gap') continue
    if (Array.isArray(r.left) || Array.isArray(r.right)) {
      out.push({
        type: (r.type ?? 'equal') as DiffRowType,
        leftLineNo: (r.leftLineNo as number | null) ?? null,
        rightLineNo: (r.rightLineNo as number | null) ?? null,
        left: (r.left as WordPart[]) ?? [],
        right: (r.right as WordPart[]) ?? [],
      })
      continue
    }
    const legacy = r as LegacyDiffRow
    const oldLine = legacy.oldLine
    const newLine = legacy.newLine
    if (legacy.type === 'delete') {
      out.push({
        type: 'removed',
        leftLineNo: legacy.oldLineNum ?? null,
        rightLineNo: null,
        left: oldLine != null ? [{ type: 'removed', value: oldLine }] : [],
        right: [],
      })
    } else if (legacy.type === 'insert') {
      out.push({
        type: 'added',
        leftLineNo: null,
        rightLineNo: legacy.newLineNum ?? null,
        left: [],
        right: newLine != null ? [{ type: 'added', value: newLine }] : [],
      })
    } else {
      out.push({
        type: 'equal',
        leftLineNo: legacy.oldLineNum ?? null,
        rightLineNo: legacy.newLineNum ?? null,
        left: [{ type: 'equal', value: oldLine ?? '' }],
        right: [{ type: 'equal', value: newLine ?? '' }],
      })
    }
  }
  return out
}
