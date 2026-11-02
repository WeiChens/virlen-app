/**
 * 文件 markdown 预览的「查找」（Ctrl/Cmd+F）—— 匹配与高亮。
 *
 * 为什么不能靠浏览器自带的查找：预览是**虚拟列表**（见 virtual-markdown.tsx），没滚到的块根本不在 DOM 里，
 * 原生查找只能搜到视口附近那几块。所以这里直接搜**源码**（`mdBlocks` 切出来的块数组），命中数是全量的，
 * 跳转按「块下标」交给虚拟层 `scrollToIndex`。
 *
 * 两条分工：
 * - **匹配（权威）**：`findMatches` 在块文本上找，决定「共几处 / 当前第几处 / 跳哪一块」；
 * - **高亮（尽力）**：`applyFindHighlights` 只在**已挂载**的块 DOM 里按文本节点找，走 CSS Custom
 *   Highlight（不改 DOM 结构，React 照常 reconcile）。两者的命中数可能不同 —— 查询里带 markdown 语法
 *   （`**加粗**`、`## `）时源码命中但渲染后的文字里没有这些字符，那处就只跳转不高亮；反过来一处分行
 *   内 `**a**b` 之类的拼接也不会跨节点匹配。这类偏差只影响观感，不影响定位。
 *
 * 高亮的「当前那处」用**块内序号**对齐：源码第 k 次 ↔ DOM 里第 k 个 Range。正常查询（词、短语）
 * 两边一致，偏差同上。
 */

/** CSS Custom Highlight 的两个登记名（样式见 virtual-markdown.scss 的 ::highlight 规则） */
const HIGHLIGHT_ALL = 'md-find'
const HIGHLIGHT_CURRENT = 'md-find-current'

/** 查找输入框的标记（键盘处理要靠它区分「是不是我们自己的输入框」） */
export const FIND_INPUT_ATTR = 'data-md-find-input'

/**
 * 把「用户选中的文本」变成查找词。
 *
 * `Ctrl+F` 时先把选中文本填进搜索框（Monaco / VS Code 同一套手感）。两条规则：
 * - 首尾空白去掉（拖选很容易带上行尾空格 / 换行）；
 * - **跨行选区只取第一行**：我们的匹配是在「块」文本上做的，把一整段（或两段）塞进查询
 *   几乎必然零命中，不如给一个能命中的开头让用户接着改。
 */
export function selectionToQuery(text: string): string {
  const flat = text.replace(/\r\n?/g, '\n').trim()
  if (flat === '') return ''
  if (!flat.includes('\n')) return flat
  return flat.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
}

/** 一条命中（块级定位用；块内偏移只用于调试 / 后续扩展） */
export interface FindMatch {
  /** 所在的块下标（`splitMarkdownBlocks` 的数组下标） */
  block: number
  /** 是块内第几处命中（0 基）：用来在渲染出的 DOM 里挑「当前」那一个 */
  ordinal: number
  /** 块内字符偏移 */
  offset: number
  /** 命中长度（与查询同长，不是字节数） */
  length: number
}

/**
 * 在块数组里找全部命中（不重叠，按文档顺序）。
 *
 * @param caseSensitive 区分大小写；默认不区分（与 Monaco 的默认一致）
 */
export function findMatches(
  blocks: readonly string[],
  query: string,
  caseSensitive = false,
): FindMatch[] {
  if (query === '') return []
  const needle = caseSensitive ? query : query.toLowerCase()
  const out: FindMatch[] = []

  blocks.forEach((text, block) => {
    const haystack = caseSensitive ? text : text.toLowerCase()
    let from = 0
    let ordinal = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      out.push({ block, ordinal, offset: at, length: needle.length })
      ordinal += 1
      // 不重叠：`aa` 在 `aaaa` 里是两处，不是三处（与 Monaco / 浏览器查找一致）
      from = at + needle.length
    }
  })

  return out
}

/** 一段文本节点里的命中（DOM 偏移，**不跨节点**） */
export interface NodeHit {
  node: Text
  start: number
  end: number
}

/** 单个文本节点里的命中（不跨节点；跨节点的命中只影响高亮，不影响跳转） */
export function hitsInNode(node: Text, query: string, caseSensitive = false): NodeHit[] {
  if (query === '') return []
  const text = node.data
  const needle = caseSensitive ? query : query.toLowerCase()
  const haystack = caseSensitive ? text : text.toLowerCase()
  const out: NodeHit[] = []

  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    out.push({ node, start: at, end: at + needle.length })
    from = at + needle.length
  }

  return out
}

/** CSS Custom Highlight API 的最小形状（不依赖 lib.dom 里有没有这两个类型） */
interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void
  delete(name: string): boolean
}
type HighlightCtor = new (...ranges: AbstractRange[]) => unknown

/**
 * 拿到 CSS Custom Highlight API；不支持就返回 null。
 *
 * 支持情况：Chromium 105+ / Safari 17.2+ / Firefox 140+。老 WebView（Windows 之外的某些发行版）
 * 没有它就只是**没有高亮**，跳转与计数照常工作 —— 所以不做 polyfill。
 */
function highlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightCtor } | null {
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike }
    Highlight?: HighlightCtor
  }
  if (!g.CSS?.highlights || typeof g.Highlight !== 'function') return null
  return { registry: g.CSS.highlights, Highlight: g.Highlight }
}

/** 子树里的全部文本节点（文档顺序） */
function textNodesOf(root: Node): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text)
  return out
}

/** 清掉查找高亮（关掉浮层 / 清空查询时调用） */
export function clearFindHighlights(): void {
  const api = highlightApi()
  if (!api) return
  api.registry.delete(HIGHLIGHT_ALL)
  api.registry.delete(HIGHLIGHT_CURRENT)
}

export interface FindHighlightResult {
  /** 当前命中在 DOM 里的 Range：短文档（整篇渲染）靠它滚进视野 */
  current: Range | null
  /** 本次真正高亮到的命中数（只含已挂载的块，与源码命中数可能不同） */
  highlighted: number
}

/**
 * 把高亮挂到 CSS Custom Highlight 上。
 *
 * @param blockRoots 已挂载的块容器（每个带 `data-index`，值是块下标）
 * @param current 当前命中（块下标 + 块内序号）；无命中传 null
 */
export function applyFindHighlights(
  blockRoots: readonly HTMLElement[],
  query: string,
  caseSensitive: boolean,
  current: { block: number; ordinal: number } | null,
): FindHighlightResult {
  const api = highlightApi()
  if (!api) return { current: null, highlighted: 0 }

  api.registry.delete(HIGHLIGHT_ALL)
  api.registry.delete(HIGHLIGHT_CURRENT)
  if (query === '') return { current: null, highlighted: 0 }

  const all: Range[] = []
  let currentRange: Range | null = null

  for (const root of blockRoots) {
    const block = Number(root.dataset.index)
    let ordinal = 0
    for (const node of textNodesOf(root)) {
      for (const hit of hitsInNode(node, query, caseSensitive)) {
        const range = document.createRange()
        range.setStart(hit.node, hit.start)
        range.setEnd(hit.node, hit.end)
        all.push(range)
        if (current && current.block === block && current.ordinal === ordinal) {
          currentRange = range
        }
        ordinal += 1
      }
    }
  }

  if (all.length > 0) api.registry.set(HIGHLIGHT_ALL, new api.Highlight(...all))
  if (currentRange) api.registry.set(HIGHLIGHT_CURRENT, new api.Highlight(currentRange))

  return { current: currentRange, highlighted: all.length }
}

/**
 * 焦点是不是落在「自己能处理 Ctrl+F」的文本编辑控件上（Monaco 的隐藏 textarea、
 * 聊天输入框、设置里的 input…）。是的话不能抢它的查找。
 */
export function isTextEditingElement(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  return el.closest('.monaco-editor') !== null
}
