/**
 * CSV / TSV 文本 → 行 × 列（**只用于面板里的表格预览**）。
 *
 * ⚠️ 这不是第二份「文档解析」：给模型 / 知识库的那一份在 Rust `doc_parse::delimited`
 * （解码 + 规范化重写 + 坏文件回退原文）。这里输入已经是**解码后的草稿字符串**
 * （Monaco 编辑器里的内容），要解决的只有「把所见内容画成表」——所以没有规范化重写那一步，
 * 但引号 / 换行 / 分隔符的判定必须与那边同一口径（否则同一份文件在正文与预览里列数不同）。
 *
 * 两条口径：
 * 1. **分隔符嗅探同 Rust**：取第一条非空行里出现次数最多的那个（`,` `;` `\t` `|`），
 *    次数打平按这个顺序取先者；`tsv` 恒用制表符（不看内容）。
 * 2. **上限只限制物化**：`rowCount` / `colCount` 是真实总量，界面据此提示「只看前 N 行」。
 */

/** 物化的行数上限（与 Rust `doc_parse::preview::MAX_PREVIEW_ROWS` 同值：表格观感一致） */
export const MAX_PREVIEW_ROWS = 500

/** 物化的列数上限（与 Rust `doc_parse::preview::MAX_PREVIEW_COLS` 同值） */
export const MAX_PREVIEW_COLS = 40

export interface DelimitedGrid {
  /** 已物化的行（`rows.length <= MAX_PREVIEW_ROWS`） */
  rows: string[][]
  /** 真实行数 */
  rowCount: number
  /** 真实最大列数 */
  colCount: number
}

/** 嗅探分隔符（与 Rust `delimited::sniff_delimiter` 同一规则） */
export function sniffDelimiter(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') || ''
  // 只看首行前 4096 字符：这一行足以代表整份表，再长只是浪费
  const line = firstLine.slice(0, 4096)
  let best = ','
  let bestCount = 0
  for (const candidate of [',', ';', '\t', '|']) {
    const count = line.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/**
 * 把 CSV / TSV 文本切成网格（`ext` 只影响分隔符：`tsv` 恒用制表符）。
 *
 * 解析是**单遍逐字符**的：引号里的分隔符与换行都属于同一个格子，`""` 是一个字面引号。
 * 这样与 `csv` crate 的行为一致（坏文件也不丢内容：未闭合的引号把余下全文收进一个格子）。
 */
export function parseDelimitedGrid(text: string, ext?: string): DelimitedGrid {
  const delimiter = ext === 'tsv' ? '\t' : sniffDelimiter(text)
  const rows: string[][] = []
  let rowCount = 0
  let colCount = 0
  let cell = ''
  let row: string[] = []
  /** 当前行的列数（含被 `MAX_PREVIEW_COLS` 截掉的） */
  let cols = 0
  let inQuotes = false

  const endCell = () => {
    cols += 1
    if (row.length < MAX_PREVIEW_COLS) row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    rowCount += 1
    colCount = Math.max(colCount, cols)
    if (rows.length < MAX_PREVIEW_ROWS) rows.push(row)
    row = []
    cols = 0
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch !== '"') {
        cell += ch
      } else if (text[i + 1] === '"') {
        // `""` = 一个字面引号
        cell += '"'
        i += 1
      } else {
        inQuotes = false
      }
      continue
    }
    // 引号只有落在**格子开头**才算引号（与 csv crate 一致；`a"b` 里的引号就是普通字符）
    if (ch === '"' && cell === '') {
      inQuotes = true
    } else if (ch === delimiter) {
      endCell()
    } else if (ch === '\n') {
      endRow()
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  // 末尾没有换行结尾也要收下最后一行；整篇以换行结束时这里不会多出一行空白
  if (cell !== '' || row.length > 0 || cols > 0) endRow()

  return { rows, rowCount, colCount }
}
