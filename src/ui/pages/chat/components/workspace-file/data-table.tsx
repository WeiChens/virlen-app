/**
 * DataTable — 表格预览的**唯一一份**渲染（工作表预览与 CSV 预览共用）。
 *
 * 只做四件事：表头给列号（A、B、…、AA，Excel 口径）、行首给行号、合并区域画成
 * `colspan` / `rowspan`、超出行 / 列上限时如实说一句。
 *
 * 为什么用一个 `<table>` 而不是虚拟滚动：物化上限已经压到 500 × 40（见 `doc_parse::preview`
 * 与 `domain/files/delimited.ts`），这个量级直接渲染比引入虚拟化更简单，也不会出现
 * 「滚动时表格跳动」的观感问题。上限之外的行列**不静默丢**：提示条会说清共多少。
 *
 * 单元格一律按纯文本渲染（不走 Markdown / 不解析 HTML）：这里是别人的文件内容，
 * 不能被当成模板。
 */
import { useMemo } from 'react'
import { t, tpl } from '@/ui/i18n'
import { buildSheetSpans, type MergedBounds } from '@/domain/files/sheet-spans'

interface Props {
  /** 已物化的行（`rows.length <= MAX_PREVIEW_ROWS`） */
  rows: string[][]
  /** 真实行数 / 列数（判断要不要提示「只显示前 N 行」） */
  rowCount: number
  colCount: number
  /** 左侧行号列（默认显示；CSV 预览也显示） */
  showRowNumbers?: boolean
  /** 合并区域（整张表的 0-based 坐标；CSV 没有） */
  merges?: MergedBounds[]
}

/** 列号：0 → A，25 → Z，26 → AA（与 Excel 的列标一致） */
export function columnLabel(index: number): string {
  let label = ''
  let n = index
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}

/** 表头最多几列（物化了多少列就画多少列） */
function columnIndexes(rows: string[][], colCount: number): number[] {
  const widest = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const width = Math.max(widest, Math.min(colCount, 1))
  return Array.from({ length: width }, (_, index) => index)
}

export default function DataTable({
  rows,
  rowCount,
  colCount,
  showRowNumbers = true,
  merges,
}: Props) {
  const cols = columnIndexes(rows, colCount)
  const rowsHidden = rowCount > rows.length
  const colsHidden = colCount > cols.length
  // 合并区域的坐标是整张表的，所以按**物化窗口**裁（`rows.length` / `cols.length`）
  const spans = useMemo(
    () => buildSheetSpans(merges, rows.length, cols.length),
    [merges, rows, cols.length],
  )

  return (
    <div className="wfp-sheet">
      {(rowsHidden || colsHidden) && (
        <div className="wfp-sheet-note">
          {rowsHidden &&
            tpl('仅显示前 $__shown__ 行（共 $__total__ 行）', {
              shown: rows.length,
              total: rowCount,
            })}
          {rowsHidden && colsHidden && ' · '}
          {colsHidden &&
            tpl('仅显示前 $__shown__ 列（共 $__total__ 列）', {
              shown: cols.length,
              total: colCount,
            })}
        </div>
      )}
      <div className="wfp-sheet-scroll">
        <table className="wfp-sheet-table">
          <thead>
            <tr>
              {showRowNumbers && <th className="wfp-sheet-corner" aria-label={t('行号')} />}
              {cols.map((col) => (
                <th key={col} className="wfp-sheet-col" scope="col">
                  {columnLabel(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {showRowNumbers && (
                  <th className="wfp-sheet-row" scope="row">
                    {rowIndex + 1}
                  </th>
                )}
                {cols.map((col) => {
                  // `null` = 被别的格子合并覆盖：整格不画（画了会让这一行的列数多出来）
                  const span = spans.get(`${rowIndex},${col}`)
                  if (span === null) return null
                  return (
                    <td
                      key={col}
                      colSpan={span?.colSpan}
                      rowSpan={span?.rowSpan}
                      title={row[col] || undefined}>
                      {row[col] ?? ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
