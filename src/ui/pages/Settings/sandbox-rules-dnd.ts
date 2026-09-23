/**
 * sandbox-rules-dnd — 「忽略沙盒命令」列表拖拽排序的几何计算（纯函数，无 React / 无 DOM）
 *
 * 为什么不用 HTML5 drag & drop：窗口开了原生拖放（`dragDropEnabled: true`，见 AGENTS §11.8），
 * WebView2 的 HTML5 `drop` / `dragover` 事件收不到，拖拽排序只能自己用 pointer 事件实现。
 * 于是把「指针位置 → 落点间隙」和「落点间隙 → 指示线 Y」抽成纯函数，便于单测。
 *
 * 坐标约定：所有 `top` / `bottom` **都是列表容器内容坐标**
 * （= getBoundingClientRect 的值 - 容器 top + 容器 scrollTop），
 * 这样指示线可以直接作为 `position: absolute; top` 使用，且不受滚动位置影响。
 */

/** 一行在列表内容坐标下的纵向范围 */
export interface RowRange {
  top: number
  bottom: number
}

/**
 * 指针落在第几个「间隙」（返回值 0..rows.length）。
 *
 * 判定用行中线：越过某行的中线即认为要排到它前面。
 * 行高可能不同（匹配内容是 1~2 行裁剪），所以按每行真实范围逐个比较，不用平均行高估算。
 */
export function computeDropIndex(rows: RowRange[], y: number): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (y < (r.top + r.bottom) / 2) return i
  }
  return rows.length
}

/**
 * 落点指示线的内容坐标 Y：插在第 `index` 个间隙时，
 * 贴该行的上沿；排在最后则贴末行的下沿。
 */
export function dropIndicatorTop(rows: RowRange[], index: number): number {
  if (rows.length === 0) return 0
  if (index >= rows.length) return rows[rows.length - 1].bottom
  return rows[index].top
}
