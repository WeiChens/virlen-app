/**
 * SheetView — `xlsx` / `xls` 的表格预览：顶部按工作表切换，下面是网格。
 *
 * 两条口径：
 * 1. **一张表一次只画一张**：工作簿动辄十几张，全画出来既慢又看不出重点；
 *    切换只换数据源，滚动位置重置（不同表的列宽 / 行数没有可比性）。
 * 2. **内容与「给模型的那份」同源**：网格来自 Rust `cmd_preview_document`
 *    （与 `parse_document` 同一套 `office_oxide` 抽取 + 格内换行压平），不是前端另解一遍 OOXML。
 */
import { useMemo, useState } from 'react'
import { t } from '@/ui/i18n'
import type { DocumentPreviewSheet } from '@/services/workspace-file-service'
import DataTable from './data-table'

interface Props {
  sheets: DocumentPreviewSheet[]
}

export default function SheetView({ sheets }: Props) {
  const [active, setActive] = useState(0)
  // 换文件 / 重新加载后表数变少时，别把下标留在越界位置
  const index = sheets.length > 0 ? Math.min(active, sheets.length - 1) : 0
  const sheet = sheets[index]

  // 每张表的真实规模先算好：切换时提示条要立刻准确，不用等网格渲染
  const tabs = useMemo(
    () => sheets.map((item) => ({ name: item.name, cells: item.rowCount * item.colCount })),
    [sheets],
  )

  if (!sheet) {
    return <div className="wfp-hint">{t('这张工作簿是空的')}</div>
  }

  return (
    <div className="wfp-sheets">
      {sheets.length > 1 && (
        <div className="wfp-sheet-tabs" role="tablist">
          {tabs.map((tab, tabIndex) => (
            <button
              key={`${tab.name}-${tabIndex}`}
              type="button"
              role="tab"
              aria-selected={tabIndex === index}
              className={`wfp-sheet-tab${tabIndex === index ? ' is-active' : ''}`}
              title={tab.name}
              onClick={() => setActive(tabIndex)}>
              {tab.name}
            </button>
          ))}
        </div>
      )}
      {sheet.rows.length > 0 ? (
        <DataTable
          rows={sheet.rows}
          rowCount={sheet.rowCount}
          colCount={sheet.colCount}
          merges={sheet.merges}
        />
      ) : (
        // 整册不是全空（否则 Rust 那边已报 `no_text`），但这张表是空的：表名依旧留着可切换
        <div className="wfp-hint">{t('这张工作表是空的')}</div>
      )}    </div>
  )
}
