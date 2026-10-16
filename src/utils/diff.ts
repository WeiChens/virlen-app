/**
 * diff —— 「左右对比」的**唯一实现**（`SideBySideDiff` 的输入行模型）。
 *
 * 算法用 `diff` 库（jsdiff）的 `diffLines` + `diffChars`，与 xwjc-app 的
 * `VersionCompareDetailPage/diff.js` 同一套：
 *
 * 1. `diffLines` 先按行切出「未变化块」与「改动组」；
 * 2. **每个改动组内部**再做一次 `diffChars` —— 于是「一行里改了两个字」是**行内字符级**片段，
 *    而不是整行删除 + 整行新增；
 * 3. 组内整段字符级 diff 还能正确处理**行中插入 / 删除换行**：换行前后的文本被识别为相等，
 *    只有换行本身是变更，不会把换行后的内容误判成「整段删除 + 整段新增」；换行变更在行内以
 *    `↵`（[`NL_MARK`]）标出。
 *
 * 为什么换掉原先手写的 LCS：它的 DP 表是 `(m+1)×(n+1)` 个 number —— 5000 行的文件就是 2500 万项
 * （几百 MB 内存），大文件直接卡死；而且它只到行粒度，改一个字符也整行红绿。
 *
 * 两处刻意的取舍（与参照实现不同）：
 * - **不折叠未改动行**（参照实现也没有）：省略行只在「调用方手里根本没有那段内容」时才出现
 *   （`edit_file` 的多处编辑之间），由视图层自己插，内核不产生。
 * - **性能兜底**：组内字符级 diff 的规模与编辑距离都有上限，超限就退化成整行红绿（见常量注释）。
 *   参照实现没有这道闸，遇到「整个大文件重写」的改动组会卡死界面。
 */
import { diffChars, diffLines, type ChangeObject } from 'diff'

/** 行内片段：一段文本 + 它在两侧的归属（`equal` = 两侧共有 / `removed` = 只在左侧 / `added` = 只在右侧） */
export interface WordPart {
  type: 'equal' | 'removed' | 'added'
  value: string
}

export type DiffRowType = 'equal' | 'removed' | 'added' | 'modified'

/**
 * 一行对齐结果。两侧**成对**：
 * - `equal`：两侧内容相同（理论上只会出现在改动组内被字符级 diff 识别为相等的行上）；
 * - `removed` / `added`：单侧行（另一侧是空数组，渲染时留一个空行盒保持行高对齐）；
 * - `modified`：两侧都有、内容不同，各自带字符级片段（行内高亮的依据）。
 */
export interface DiffRow {
  type: DiffRowType
  /** 左侧（旧）行号；续行与单侧行的另一侧为 `null`（界面上留空，不重复打号） */
  leftLineNo: number | null
  /** 右侧（新）行号，语义同上 */
  rightLineNo: number | null
  left: WordPart[]
  right: WordPart[]
}

/** 换行标记：在行内可视化「这里新增 / 删除了一个换行」 */
export const NL_MARK = '\u21b5' // ↵

/**
 * 性能兜底（参照实现没有这道闸，实测必须加）——三处上限都是**实测**调出来的：
 *
 * | 场景 | 无上限 | 加闸后 |
 * |---|---|---|
 * | 10000 行（419KB，在 git 的 512KB/侧上限内）全重写 | **20 s** | 0.33 s（中止）|
 * | 3000 行全重写 | 1.86 s | 0.59 s（中止）|
 * | 800 行全重写（组内 8k 字符） | 0.4 s | —（在闸内，保留字符级）|
 * | 5000 行 / 改 50 行（常见形态） | 10.6 ms | 同左 |
 *
 * 中止不是抛错，而是**降级**：拿不到精细对齐时退成「整行红绿」（组内）或
 * 「公共前后缀 + 中间整段」（整文），用户看到的仍然是差异，只是没有字符级高亮。
 */
const MAX_GROUP_CHARS = 10_000
/** 字符级 diff 的编辑距离上限（超出时 jsdiff 返回 `undefined`） */
const MAX_CHAR_EDITS = 2_000
/** 行级 diff 的编辑距离上限（超出时 jsdiff 返回 `undefined`，见 [`coarseRows`]） */
const MAX_LINE_EDITS = 2_000

/**
 * 把 diff 片段的 value 按行拆开，并丢掉末尾换行带来的空元素。
 *
 * ⚠️ 与 `domain/git` 的行口径**同一件事**：`"a\nb\n"` 只有 **2** 行 —— 不丢末尾空元素，
 * 每个文件末尾都会凭空多一行空白（左右对比里非常显眼）。
 * 顺带把 CRLF 归一成 LF（内核只认 LF，见 git/diff.rs 的换行归一化）。
 */
function splitLines(value: string): string[] {
  const v = value.replace(/\r\n/g, '\n')
  if (v === '') return []
  const arr = v.split('\n')
  if (v.endsWith('\n')) arr.pop()
  return arr
}

/** 追加片段；同类型相邻片段合并（减少渲染节点数） */
function pushPart(buf: WordPart[], type: WordPart['type'], value: string): void {
  if (value === '') return
  const last = buf[buf.length - 1]
  if (last && last.type === type) last.value += value
  else buf.push({ type, value })
}

/**
 * 组内两侧文本 → 行对齐（整段字符级 diff + 按换行重建）。
 *
 * 重建规则：
 * - 遇到换行时按换行归属（equal / removed / added）推进对应侧行号；**只有一侧有换行**时，
 *   另一侧从这一行「续行」（行号不变、显示留空），这样行高与语义都不会错位；
 * - added / removed 的换行在对应侧追加一个 `↵`，让「换行本身变了」可见。
 *
 * @param startLeftNo 进入本组前左侧已输出的行号（本组内从它 +1 开始）
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
  // 超出规模 / 编辑距离上限：退化成「整行红绿」（不再做行内字符级对比）
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
        // 遇到一个换行：换行本身是 added / removed 时先在对应侧打上 ↵ 标记
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

/** 退化路径：不做字符级对比，删除行一段、新增行一段（与老的行模型观感一致） */
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
 *
 * @param oldText 旧侧全文（`null` = 没有这一侧，例如新增文件的旧侧）
 * @param newText 新侧全文
 * @param startLine 首行行号（默认 1）。`edit_file` 传文件里的真实起始行号，
 *   这样左右两侧打出来的是**文件里的绝对行号**而不是片段内的相对行号。
 */
export function buildDiffRows(
  oldText: string | null,
  newText: string | null,
  startLine = 1,
): DiffRow[] {
  const oldAll = oldText ?? ''
  const newAll = newText ?? ''
  // 超大规模 / 改动量：不赌 jsdiff 能在合理时间内算完（见 MAX_LINE_EDITS 的实测表）
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
 * 行级 diff 中止时的降级：**公共前缀 / 后缀行照常对齐，中间整段「先删后增」**。
 *
 * 不是「随便给个结果」：前后缀是 O(n) 就能确定的真实相等行，中间那段本来也是改动区（只是不再
 * 逐行配对，「一大块被替换」这种最常见的大改动照样看得清）。
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
 * 汇总差异行数。
 *
 * `modified`（两侧都有、内容不同）**两侧各算一行** —— 工具消息上那行「减少 N 行, 新增 M 行」
 * 要的就是「这份差异动了多少行」，把它排除掉会显示成「无变更」。
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
 * 全角 / 宽字符（表意文字、全角标点、emoji …）—— 只为一个目的服务：把宽度**往宽了估**。
 * 判定不需要精确（`ch` 是等宽字体的一个字符宽，宽字符大致是 2 倍；CJK 走回退字体时可能只有
 * 1.67 倍，估宽只是多滚一点）。
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

/** 一侧的片段宽度（ch）：制表符 8（`white-space: pre` 下 tab 走到下一个制表位）、
 * 宽字符 2、其余 1；换行标记 `↵` 是展示标记，算 1。 */
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

/** 同一份行数据会被「原位 / 全屏」两份实例各问一次，算一次就够 */
const _widthChCache = new WeakMap<object, number>()

/**
 * 最长一行值多少「等宽字符宽」（ch）—— 左右对比视图的**横向滚动宽度**由它决定。
 *
 * 为什么要算而不是让 CSS 按内容撑开（`max-content`）：`content-visibility: auto` 会把屏外行整个
 * 跳过，**被跳过的内容不参与尺寸计算** —— 列宽会随滚动位置忽宽忽窄、横向滚动条时有时无（实测）。
 * 所以宽度只能由**行数据**算出来，交给 CSS 当固定值用（`--diff-max-ch`）。
 *
 * 一律**往宽了估**：估宽只是多滚一点，估窄会把这一行的尾巴裁掉（列宽不够时的兜底见 .diff-code）。
 */
export function maxDiffWidthCh(
  rows: ReadonlyArray<DiffRow | { type: 'gap' }>,
): number {
  const hit = _widthChCache.get(rows)
  if (hit !== undefined) return hit
  let max = 0
  for (const row of rows) {
    // 省略间隔行不占宽度（它只画一个 ⋯）
    if (row.type === 'gap') continue
    const w = Math.max(partsWidthCh(row.left), partsWidthCh(row.right))
    if (w > max) max = w
  }
  _widthChCache.set(rows, max)
  return max
}

/** 老行模型（`edit_file` 早期落库的形状）：`equal` / `delete` / `insert` + 左右整行文本 */
interface LegacyDiffRow {
  type?: string
  oldLine?: string | null
  newLine?: string | null
  oldLineNum?: number | null
  newLineNum?: number | null
}

/**
 * 把**历史消息里落库的差异行**归一成当前模型。
 *
 * `edit_file` 的 diff 行是落库的（消息 uiData）：老会话里存的是老模型
 * （`{type: 'equal'|'delete'|'insert', oldLine, newLine, oldLineNum, newLineNum}`），
 * 按新模型直接渲染会读到一堆 `undefined`（表现为整片空白）。
 *
 * 按**老口径**归一（一行一段、不重算）：老消息当初显示什么样，现在还得是什么样 ——
 * 用新算法重算虽然更漂亮，但会与用户当时看到的、以及当初的增删统计对不上。
 */
export function normalizeDiffRows(rows: unknown): DiffRow[] {
  if (!Array.isArray(rows)) return []
  const out: DiffRow[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    // 省略行是视图层自己插的展示行，不会落库；真出现了也直接跳过
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
