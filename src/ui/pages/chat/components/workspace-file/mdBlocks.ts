/**
 * Markdown 块切分器（给**文件预览**的虚拟列表用；聊天区不用）。
 *
 * 虚拟渲染的前提是「能按顶层块切成片段、每段独立交给 MarkdownRenderer 而渲染结果与整篇一致」。
 * 规则与 `streamMarkdown.ts::splitStablePrefix` 同一套判定（围栏追踪 + 容器块粘连），只是从
 * 「找一个切点」改成「扫描整篇返回块数组」。
 *
 * 粘连规则（切开会导致渲染结果变化的，一律不切）：
 * - 围栏代码块（``` / ~~~）内部永远不切，整块算一个片段；
 * - 列表 / 引用 / 表格行是容器块，相邻行之间不切（列表项内缩进续行、嵌套列表都要跟着主行走）；
 * - 缩进代码块（≥4 空格 / Tab）不作为片段开头（它属于上一段的段落延续）；
 * - setext 标题（`===` / `---` 下划线）与上一段段落是一体，不切在它们中间；
 * - 其余在空行处切分。
 *
 * 两个后处理：
 * - **相邻短段合并**：连续小片段合成一个（目标几十~几百块），避免块数爆炸反而拖慢测量；
 * - **超长片段按行二次切**：只对围栏代码块和纯段落（无容器结构的）做，切出的片段首尾补
 *   fence / 空行，保证每段仍语法完整、渲染独立成立。
 */

/** 小于该总长度不切，整篇一次渲染（虚拟化在小文档上纯亏：切分 + 测量都是开销） */
export const MIN_VIRTUALIZE_CHARS = 4000

/** 相邻片段合并的目标长度（按 UTF-16 码元） */
const MERGE_TARGET = 1200

/** 超过该长度的「可再切」片段做行级二次切分 */
const SPLIT_OVER = 4000

/** 二次切分的目标片段长度 */
const SPLIT_TARGET = 3000

/** 列表项 / 引用 / 表格行：容器块，其内部换行不等于块边界（与 streamMarkdown 同正则） */
const LIST_OR_CONTAINER = /^\s*(?:[-*+]|\d+[.)])\s|^\s*>|^\s*\|/

/** 缩进代码块（≥4 空格 / Tab） */
const INDENTED_CODE = /^(?: {4,}|\t)/

/** 围栏代码块起始/结束标记（``` 或 ~~~，最多缩进 3 空格） */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/** ATX 标题 / 水平线 / HTML 块（保留常量供将来细分切分优先级用） */
/** setext 下划线（`===` / `---`）：跟上一段段落一体 */
const SETEXT = /^ {0,3}(=+|-+)\s*$/

/** 一行是否为空 */
const isEmpty = (s: string) => s.trim() === ''

interface RawChunk {
  text: string
  /** 能否安全做行级二次切分（围栏块可以补围栏；普通段落可以补空行；容器块不行） */
  resplittable: 'fence' | 'paragraph' | 'no'
}

/**
 * 把 markdown 切成顶层块片段。
 * @returns 片段文本数组；数组长度为 1 时调用方应退化为整篇渲染
 */
export function splitMarkdownBlocks(content: string): string[] {
  if (content.length < MIN_VIRTUALIZE_CHARS) return [content]

  const lines = content.split('\n')
  const chunks: RawChunk[] = []
  let start = 0
  let fence: string | null = null

  const push = (end: number, resplittable: RawChunk['resplittable']) => {
    const text = lines.slice(start, end).join('\n')
    if (text.trim() !== '') chunks.push({ text, resplittable })
    start = end
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) {
        // 围栏起始行属于这个围栏块
        push(i, 'no')
        fence = marker
        continue
      }
      if (marker[0] === fence[0] && marker.length >= fence.length) {
        // 闭合行收进这个围栏块，之后才能切（'fence' 标记它可以行级二次切分）
        fence = null
        push(i + 1, 'fence')
        continue
      }
      continue
    }
    if (fence) continue
    if (isEmpty(line)) continue

    // 空行之后的新块起点判定：
    // - setext 下划线 / 缩进代码块：属上一段，不切；
    // - 容器行（列表 / 引用 / 表格）：若上一个非空行**也是**容器行，说明是容器块内部的
    //   空行（宽松列表的项间 / 引用块间的空行），切开会让一个列表变两个 —— 不切；
    //   否则是紧跟普通段落的**新容器块**，可以切。
    if (i > 0 && isEmpty(lines[i - 1])) {
      if (SETEXT.test(line) || INDENTED_CODE.test(line)) continue
      if (LIST_OR_CONTAINER.test(line)) {
        let prevNonEmpty = ''
        for (let j = i - 2; j >= start; j--) {
          if (!isEmpty(lines[j])) {
            prevNonEmpty = lines[j]
            break
          }
        }
        if (LIST_OR_CONTAINER.test(prevNonEmpty)) continue
        // 容器块起点：整块（到下一个顶层块前）不可行级二次切分 → 'no'
        push(i, 'no')
        continue
      }
      push(i, 'paragraph')
      continue
    }
  }
  push(lines.length, 'no')

  return postProcess(chunks)
}

/**
 * 后处理：相邻短段合并 + 超长片段行级二次切分。
 */
function postProcess(chunks: RawChunk[]): string[] {
  // 1) 合并相邻短段
  const merged: RawChunk[] = []
  let buf: string[] = []
  let bufLen = 0
  const flush = () => {
    if (buf.length) {
      // 段间用一个空行分隔（块尾可能残留换行，先归一化，避免 \n\n\n 变成「空段落」）
      merged.push({ text: buf.map((s) => s.replace(/\n+$/, '')).join('\n\n'), resplittable: 'paragraph' })
      buf = []
      bufLen = 0
    }
  }
  for (const c of chunks) {
    if (c.resplittable === 'paragraph' && c.text.length < MERGE_TARGET && bufLen < MERGE_TARGET) {
      buf.push(c.text)
      bufLen += c.text.length
      continue
    }
    flush()
    merged.push(c)
  }
  flush()

  // 2) 超长片段二次切分
  const out: string[] = []
  for (const c of merged) {
    if (c.text.length <= SPLIT_OVER || c.resplittable === 'no') {
      out.push(c.text)
      continue
    }
    if (c.resplittable === 'fence') {
      out.push(...resplitFence(c.text))
    } else {
      out.push(...resplitParagraph(c.text))
    }
  }
  return out.length === 0 ? [''] : out
}

/** 超长围栏代码块：按行切，首尾补围栏 */
function resplitFence(text: string): string[] {
  const lines = text.split('\n')
  // 找到起始围栏行（含反引号 / 波浪号个数），闭合行去掉
  const openMatch = FENCE.exec(lines[0])
  const marker = openMatch ? openMatch[1] : '```'
  const body: string[] = []
  const closeIdx = (() => {
    for (let i = lines.length - 1; i >= 1; i--) {
      if (FENCE.test(lines[i])) return i
    }
    return -1
  })()
  body.push(...(closeIdx > 0 ? lines.slice(1, closeIdx) : lines.slice(1)))

  const out: string[] = []
  let part: string[] = []
  let len = 0
  const flush = () => {
    if (part.length) {
      out.push(`${marker}\n${part.join('\n')}\n${marker}`)
      part = []
      len = 0
    }
  }
  for (const l of body) {
    part.push(l)
    len += l.length
    if (len >= SPLIT_TARGET) flush()
  }
  flush()
  return out.length ? out : [text]
}

/** 超长纯段落：按行切，段间补空行（两个相邻段落之间 React 渲染上等价于一个空段落分隔） */
function resplitParagraph(text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let part: string[] = []
  let len = 0
  const flush = () => {
    if (part.length) {
      out.push(part.join('\n'))
      part = []
      len = 0
    }
  }
  for (const l of lines) {
    // 只在段落间空行处切（CommonMark 里两个段落本来就分开渲染，切点前后渲染完全一致）——
    // 段落内部硬切会把一个 <p> 变成两个，渲染结果就变了，宁可留着超大段不切
    if (isEmpty(l) && len >= SPLIT_TARGET / 2) {
      flush()
      continue
    }
    part.push(l)
    len += l.length
  }
  flush()
  return out.length ? out : [text]
}
