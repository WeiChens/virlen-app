/**
 * 「旧文本 → 新文本」的最小编辑区间（按字符做公共前缀 / 后缀裁剪）。
 *
 * 用途：文件在磁盘上被改过之后，把新内容塞回 Monaco 时**不要整篇替换** ——
 * `@monaco-editor/react` 的受控 `value` 就是这么干的（整段 `executeEdits`），
 * 光标会被冲到文末、滚动位置被弹回去。这里只算出「中间那段要换掉」的区间，
 * 于是光标 / 滚动 / 折叠 / 装饰器都留在原地。
 *
 * 纯函数、只认 UTF-16 偏移；偏移 ↔ 行列的换算交给 Monaco 的
 * `model.getPositionAt()` / `getOffsetAt()`（它们自己处理 CRLF 与代理对），
 * 见 `ui/components/code-editor/applyTextChange.ts`。
 */
export interface MiddleEdit {
  /** 替换区间起点（相对旧文本的偏移，含） */
  startOffset: number
  /** 替换区间终点（相对旧文本的偏移，不含） */
  endOffset: number
  /** 用来替换该区间的文本 */
  text: string
}

/**
 * 算出把 `prev` 变成 `next` 的最小一次替换；两边相同返回 null。
 *
 * 复杂度 O(n)，2 MB 的文件也就一次线性扫描（面板本来就有 2 MB 上限）。
 */
export function computeMiddleEdit(prev: string, next: string): MiddleEdit | null {
  if (prev === next) return null

  const prevLen = prev.length
  const nextLen = next.length
  const maxStart = Math.min(prevLen, nextLen)

  // 公共前缀（按 UTF-16 码元比较：够用且不会把代理对拆错 —— 拆分只发生在
  // 两端「相同」的部分，结果文本仍逐字等于 next）
  let start = 0
  while (start < maxStart && prev.charCodeAt(start) === next.charCodeAt(start)) {
    start += 1
  }

  // 公共后缀不能越过前缀，否则两边互相吃（例如 "ab" → "ba" 会被算成空区间）
  let suffix = 0
  const maxSuffix = maxStart - start
  while (
    suffix < maxSuffix &&
    prev.charCodeAt(prevLen - 1 - suffix) === next.charCodeAt(nextLen - 1 - suffix)
  ) {
    suffix += 1
  }

  return {
    startOffset: start,
    endOffset: prevLen - suffix,
    text: next.slice(start, nextLen - suffix),
  }
}
