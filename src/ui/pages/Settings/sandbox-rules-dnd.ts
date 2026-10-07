/**
 * sandbox-rules-dnd — 「忽略沙盒命令」列表拖拽排序的几何计算（纯函数，无 React / 无 DOM）
 *
 * 不用 HTML5 drag & drop：窗口开了原生拖放（`dragDropEnabled: true`，AGENTS §11.8），WebView2
 * 收不到 `drop` / `dragover`，拖拽排序只能自己用 pointer 事件实现。故把「指针位置 → 落点间隙」
 * 与「落点间隙 → 指示线 Y」抽成纯函数便于单测。
 *
 * 坐标约定：`top` / `bottom` 一律是**列表容器内容坐标**（rect 值 - 容器 top + 容器 scrollTop），
 * 指示线因此可直接当 `position: absolute; top` 用，不受滚动位置影响。
 */

/** 一行在列表内容坐标下的纵向范围 */
export interface RowRange {
  top: number
  bottom: number
}

/**
 * 指针落在第几个「间隙」（0..rows.length）：越过某行中线即排到它前面。
 * 行高可能不同（匹配内容是 1~2 行裁剪），故按每行真实范围逐个比较，不用平均行高估算。
 */
export function computeDropIndex(rows: RowRange[], y: number): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (y < (r.top + r.bottom) / 2) return i
  }
  return rows.length
}

/** 指示线的内容坐标 Y：插在第 `index` 个间隙 → 贴该行上沿；排最后 → 贴末行下沿 */
export function dropIndicatorTop(rows: RowRange[], index: number): number {
  if (rows.length === 0) return 0
  if (index >= rows.length) return rows[rows.length - 1].bottom
  return rows[index].top
}
