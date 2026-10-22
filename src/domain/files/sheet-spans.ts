/**
 * 合并区域 → 每个格子的 `colspan` / `rowspan`（表格预览的唯一实现）。
 *
 * 为什么需要它：`xlsx` 的合并单元格在「表名 + 制表符分列」这种正文里只剩「左上角有值、其余位置是空」，
 * 给模型看够用（说明里点了区域），但画成表格时那些空格子会把一片合并画成一排小空框。
 * Rust 侧把区域坐标原样交出来（`doc_parse::office::MergedBounds`，与说明同源），这里只做换算。
 *
 * 三条口径：
 * 1. **只裁不猜**：坐标以**整张表**为准，超出物化窗口的部分裁掉 —— 表格只画已物化的行列，
 *    span 不能把它撑出去；裁完连一格都不剩（完全落在窗口外）就整片丢掉；
 * 2. **被覆盖的格子记 `null`**：渲染时跳过。不能既画 span 又画一遍空格子，否则行里会多出格子、
 *    列数当场对不上；
 * 3. **重叠 / 越界不抛错**：Excel 允许重叠（非法但现实存在），先到先得；后来的区域只占还没被覆盖的位置，
 *    锚点已经被占就整片跳过（宁可不画，也不能画出错位的表）。
 */

/** 一片合并区域（0-based 闭区间，与 Rust `MergedBounds` 同形） */
export interface MergedBounds {
  rowFirst: number
  rowLast: number
  colFirst: number
  colLast: number
}

/** 一个锚点格子的跨行跨列数 */
export interface CellSpan {
  rowSpan: number
  colSpan: number
}

/**
 * 一片区域最多铺多少个格子还画（超出预算的区域**整片放弃**）。
 *
 * 合并区域是文件里的外部输入：物化窗口最大 500 × 40（2 万格），一个异常记录（`A1:XFD1048576`）
 * 铺下去就是 40 亿次循环 —— 与 Rust 侧 `MAX_GRID_POSITIONS_PER_CELL` 同一层顾虑。
 * 4096 = 真实报表里「一片合并」的合理上限（40 列 × 100 行那种表头合并顶格）；
 * 超过它的区域宁可**不画 span**（大不了一排空框），也不能把渲染拖死。
 */
const MAX_SPAN_CELLS = 4_096

/** 键是 `"行,列"`（0-based，物化窗口内的坐标） */
export type SheetSpans = Map<string, CellSpan | null>

/**
 * 算出一张表的 span 表。`rowCount` / `colCount` 传**物化窗口**的尺寸
 * （`rows.length` / 实际渲染的列数），不是这张表的真实总量。
 */
export function buildSheetSpans(
  merges: MergedBounds[] | undefined,
  rowCount: number,
  colCount: number,
): SheetSpans {
  const spans: SheetSpans = new Map()
  if (!merges?.length || rowCount <= 0 || colCount <= 0) return spans

  for (const merge of merges) {
    // 裁到物化窗口（客户端也不信外部坐标：负数 / 反序一律当越界）
    const rowFirst = Math.max(0, Math.trunc(merge.rowFirst))
    const rowLast = Math.min(rowCount - 1, Math.trunc(merge.rowLast))
    const colFirst = Math.max(0, Math.trunc(merge.colFirst))
    const colLast = Math.min(colCount - 1, Math.trunc(merge.colLast))
    if (rowFirst > rowLast || colFirst > colLast) continue

    const rowSpan = rowLast - rowFirst + 1
    const colSpan = colLast - colFirst + 1
    // 裁完只剩一格 = 不跨格，画不画都一样（留着反而会跟「被覆盖」混起来）
    if (rowSpan === 1 && colSpan === 1) continue
    if (rowSpan * colSpan > MAX_SPAN_CELLS) continue

    const anchor = `${rowFirst},${colFirst}`
    // 锚点已被别的区域占着（重叠）：整片跳过 —— 宁可少画，也不能画出错位的表
    if (spans.has(anchor)) continue

    for (let row = rowFirst; row <= rowLast; row += 1) {
      for (let col = colFirst; col <= colLast; col += 1) {
        if (row === rowFirst && col === colFirst) continue
        const key = `${row},${col}`
        if (!spans.has(key)) spans.set(key, null)
      }
    }
    spans.set(anchor, { rowSpan, colSpan })
  }
  return spans
}
