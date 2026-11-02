/**
 * md-find（文件预览的 Ctrl+F 查找：匹配 + 高亮）用例。
 *
 * 守三件事：
 * 1. **匹配权威**：命中数 / 块内序号 / 偏移算得对（不区分大小写是默认，不重叠计数），
 *    跳转只依赖这些数据 —— 虚拟列表里没挂载的块也算在内；
 * 2. **高亮尽力**：只在已挂载的块 DOM 里按文本节点找，走 CSS Custom Highlight（不改 DOM），
 *    当前那处用「块内序号」对齐；浏览器不支持这个 API 时**不抛错**，只是没有高亮；
 * 3. **不抢别人的查找**：焦点在输入框 / Monaco 里时不能接管 Ctrl+F。
 *
 * 高亮依赖 `CSS.highlights` + `Highlight`（真实 WebView 里 Chromium 105+ / Safari 17.2+ 才有），
 * happy-dom 没有，所以这里用替身登记表断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyFindHighlights,
  clearFindHighlights,
  findMatches,
  hitsInNode,
  isTextEditingElement,
  selectionToQuery,
} from '@/ui/pages/chat/components/workspace-file/md-find'

describe('selectionToQuery — 选中文本当查询词', () => {
  it('单个词 / 词组原样（只去首尾空白）', () => {
    expect(selectionToQuery('  改法 2 ')).toBe('改法 2')
  })

  it('跨行选区只取第一行（跨块的整段几乎必然零命中）', () => {
    expect(selectionToQuery('改法 1：借用\n\n改法 2：克隆')).toBe('改法 1：借用')
  })

  it('第一行是空行时往下一行找', () => {
    expect(selectionToQuery('\n\n  正文\n尾')).toBe('正文')
  })

  it('CRLF 也算换行', () => {
    expect(selectionToQuery('第一行\r\n第二行')).toBe('第一行')
  })

  it('空选区 / 纯空白什么都不给（调用方沿用旧查询）', () => {
    expect(selectionToQuery('')).toBe('')
    expect(selectionToQuery('   \n  ')).toBe('')
  })
})

describe('findMatches — 源码级匹配', () => {
  it('空查询没有命中', () => {
    expect(findMatches(['abc'], '')).toEqual([])
  })

  it('默认不区分大小写，且记录块内序号与偏移', () => {
    expect(findMatches(['Hello hello'], 'hello')).toEqual([
      { block: 0, ordinal: 0, offset: 0, length: 5 },
      { block: 0, ordinal: 1, offset: 6, length: 5 },
    ])
  })

  it('区分大小写时只命中完全一致的写法', () => {
    // 大小写敏感时 'Hello' 不算命中，所以它既是唯一的命中，块内序号也是 0
    expect(findMatches(['Hello hello'], 'hello', true)).toEqual([
      { block: 0, ordinal: 0, offset: 6, length: 5 },
    ])
  })

  it('按文档顺序跨块累计，块内序号各自从 0 起', () => {
    expect(findMatches(['a bb', 'bb', 'x'], 'bb')).toEqual([
      { block: 0, ordinal: 0, offset: 2, length: 2 },
      { block: 1, ordinal: 0, offset: 0, length: 2 },
    ])
  })

  it('命中不重叠（aaaa 里的 aa 是两处，不是三处）', () => {
    expect(findMatches(['aaaa'], 'aa')).toHaveLength(2)
  })

  it('中文按字符算偏移', () => {
    expect(findMatches(['改法 1 与改法 2'], '改法')).toEqual([
      { block: 0, ordinal: 0, offset: 0, length: 2 },
      { block: 0, ordinal: 1, offset: 6, length: 2 },
    ])
  })
})

describe('hitsInNode — 单个文本节点内的命中', () => {
  it('给出 DOM 偏移（不跨节点）', () => {
    const node = document.createTextNode('foo bar foo')
    expect(hitsInNode(node, 'foo')).toEqual([
      { node, start: 0, end: 3 },
      { node, start: 8, end: 11 },
    ])
  })

  it('跨节点的查询在单节点里匹配不到（只影响高亮，不影响跳转）', () => {
    const node = document.createTextNode('foo ')
    expect(hitsInNode(node, 'foo bar')).toEqual([])
  })
})

describe('applyFindHighlights — CSS Custom Highlight', () => {
  const registry = new Map<string, { ranges: unknown[] }>()

  beforeEach(() => {
    registry.clear()
    // 用最小替身模拟浏览器 API：只关心「登记了哪些 Range」
    ;(globalThis as unknown as { CSS: unknown }).CSS = {
      highlights: {
        set: (name: string, highlight: { ranges: unknown[] }) => registry.set(name, highlight),
        delete: (name: string) => registry.delete(name),
      },
    }
    ;(globalThis as unknown as { Highlight: unknown }).Highlight = class {
      ranges: unknown[]
      constructor(...ranges: unknown[]) {
        this.ranges = ranges
      }
    }
    document.body.innerHTML = ''
  })

  afterEach(() => {
    delete (globalThis as unknown as { CSS?: unknown }).CSS
    delete (globalThis as unknown as { Highlight?: unknown }).Highlight
    document.body.innerHTML = ''
  })

  /** 造一个块容器：`Hello <b>hello</b>` —— 两处命中落在两个不同文本节点上 */
  function mountBlock(index: number): HTMLElement {
    const root = document.createElement('div')
    root.dataset.index = String(index)
    root.innerHTML = 'Hello <b>hello</b>'
    document.body.appendChild(root)
    return root
  }

  it('全部命中登记到 md-find，当前那处按块内序号挑出来', () => {
    const root = mountBlock(0)

    const result = applyFindHighlights([root], 'hello', false, { block: 0, ordinal: 1 })

    expect(registry.get('md-find')?.ranges).toHaveLength(2)
    const current = registry.get('md-find-current')?.ranges
    expect(current).toHaveLength(1)
    expect(result.highlighted).toBe(2)
    expect(result.current).not.toBeNull()
    // 序号 1 = 第 2 处（<b> 里那个）
    expect(result.current?.toString()).toBe('hello')
    expect((result.current?.startContainer as Text).parentElement?.tagName).toBe('B')
  })

  it('块内序号对不上时只画全部命中，不给当前项', () => {
    const root = mountBlock(0)

    const result = applyFindHighlights([root], 'hello', false, { block: 0, ordinal: 5 })

    expect(registry.get('md-find')?.ranges).toHaveLength(2)
    expect(registry.has('md-find-current')).toBe(false)
    expect(result.current).toBeNull()
  })

  it('清空查询时把两个登记项都摘掉（不留残影）', () => {
    const root = mountBlock(0)
    applyFindHighlights([root], 'hello', false, { block: 0, ordinal: 0 })
    expect(registry.size).toBe(2)

    applyFindHighlights([root], '', false, null)

    expect(registry.size).toBe(0)
  })

  it('浏览器没有 CSS Custom Highlight 时不抛错，只是不高亮', () => {
    const root = mountBlock(0)
    delete (globalThis as unknown as { CSS?: unknown }).CSS

    const result = applyFindHighlights([root], 'hello', false, { block: 0, ordinal: 0 })

    expect(result).toEqual({ current: null, highlighted: 0 })
    expect(() => clearFindHighlights()).not.toThrow()
  })
})

describe('isTextEditingElement — 谁自己处理 Ctrl+F', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('输入框 / 文本域 / 可编辑区算', () => {
    for (const html of ['<input />', '<textarea></textarea>', '<div contenteditable="true"></div>']) {
      document.body.innerHTML = html
      expect(isTextEditingElement(document.body.firstElementChild)).toBe(true)
    }
  })

  it('Monaco 编辑器算（它有自己的查找框）', () => {
    document.body.innerHTML = '<div class="monaco-editor"><textarea></textarea></div>'
    expect(isTextEditingElement(document.querySelector('textarea'))).toBe(true)
  })

  it('普通容器不算', () => {
    document.body.innerHTML = '<div class="wfp-preview"></div>'
    expect(isTextEditingElement(document.body.firstElementChild)).toBe(false)
    expect(isTextEditingElement(null)).toBe(false)
  })
})
