/**
 * streamMarkdown — 流式 Markdown 的「前缀冻结」切分
 *
 * 背景（DevTools trace 实测）：AI 流式回复期间，一个 MarkdownRenderer 每帧都要
 * 重新 reconcile 整篇文档的元素树（长回复有数千个节点）→ 主线程 98% 占满，
 * 其中 68% 在 React render 阶段。
 *
 * 对策：把内容切成
 *   [已定稿前缀] + [正在增长的尾部]
 * 前缀用 memo 组件渲染，内容不变时 React 整棵跳过 reconcile；于是每帧只需要
 * 重建「尾部那一小块」。
 *
 * 安全策略（宁可少拆，不可拆错）：
 *  - 只在「空行」处切分，且该处围栏代码块必须已闭合；
 *  - 边界两侧都不能是列表 / 引用 / 表格（这类块内部换行不代表块边界，
 *    跨边界拆分会渲染成两个容器，出现结构差异）；
 *  - 尾部首行不能是缩进代码块（≥4 空格 / Tab）；
 *  - 前缀需达到 MIN_STABLE_PREFIX 长度（短文档拆分收益为负）。
 * 取「最靠后的合法候选点」，让尾部尽可能小（就是当前正在写的那个块）。
 * 前缀不含作为分隔的那个空行（两个渲染体互相独立，分隔换行无语义）。
 * 无法安全拆分时返回 ['', content]，退化为「整篇一次性渲染」。
 *
 * 注意：拆分只发生在 streaming=true 期间；消息结束时（streaming=false）会
 * 整篇一次性渲染，因此**最终结果与不拆分完全一致**，中间态最多出现「跨边界
 * 的列表临时显示为两个列表」这类瞬时差异（高度本来就在变）。
 */

/** 前缀小于该长度时不拆分 */
export const MIN_STABLE_PREFIX = 320

/** 列表项 / 引用 / 表格行：这些是「容器块」，其内部换行不等于块边界 */
const LIST_OR_CONTAINER = /^\s*(?:[-*+]|\d+[.)])\s|^\s*>|^\s*\|/

/** 缩进代码块（≥4 空格 / Tab） */
const INDENTED_CODE = /^(?: {4,}|\t)/

/** 围栏代码块起始/结束标记（``` 或 ~~~，最多缩进 3 空格） */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/** 从 from 开始找第一个非空行 */
function firstNonEmpty(lines: string[], from: number): string | null {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== '') return lines[i]
  }
  return null
}

/**
 * 切分「已定稿前缀 / 正在增长的尾部」。
 * @returns [prefix, tail]；无法安全切分时 prefix 为空串
 */
export function splitStablePrefix(content: string): [string, string] {
  if (content.length < MIN_STABLE_PREFIX) return ['', content]

  const lines = content.split('\n')
  let fence: string | null = null
  let prevNonEmpty = ''
  let candidate = -1

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]

    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) {
        fence = marker
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
      prevNonEmpty = line
      continue
    }
    // 未闭合的围栏内部一律不切分
    if (fence) continue

    if (line.trim() !== '') {
      prevNonEmpty = line
      continue
    }

    // ---- 空行 → 候选分界点 = 下一行 ----
    const tailFirst = firstNonEmpty(lines, i + 1)
    if (tailFirst === null) continue
    if (LIST_OR_CONTAINER.test(prevNonEmpty)) continue
    if (LIST_OR_CONTAINER.test(tailFirst)) continue
    if (INDENTED_CODE.test(tailFirst)) continue

    const prefix = lines.slice(0, i).join('\n').replace(/\n+$/, '')
    if (prefix.length < MIN_STABLE_PREFIX) continue
    candidate = i
  }

  if (candidate <= 0) return ['', content]

  const prefix = lines.slice(0, candidate).join('\n').replace(/\n+$/, '')
  const tail = lines.slice(candidate + 1).join('\n')
  if (!prefix || !tail.trim()) return ['', content]
  return [prefix, tail]
}
