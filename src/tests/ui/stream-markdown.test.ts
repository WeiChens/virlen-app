/**
 * streamMarkdown.splitStablePrefix — 流式 Markdown「前缀冻结」切分策略测试
 *
 * 背景（DevTools trace 实测）：流式期间每帧都要 reconcile 整篇 markdown 的元素树，
 * 长回复下这是主线程 CPU 的主要来源。切分后前缀被 memo 冻住，每帧只重建尾部。
 *
 * 语义：返回 [prefix, tail]；无法安全切分时返回 ['', content]。
 *  - prefix 是「已定稿前缀」，不含作为分隔的那个空行
 *  - tail 是「正在增长的尾部」（当前正在写的那个块）
 *
 * 安全边界（本测试锁死）：
 *  - 只在空行处切分，围栏代码块内 / 未闭合时绝不切分
 *  - 不在列表 / 引用 / 表格内部或其边界切分（会把一个容器块劈成两个）
 *  - 尾部首行是缩进代码块时不切分
 *  - 前缀不足 MIN_STABLE_PREFIX 时不切分（短前缀冻结无收益）
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_STABLE_PREFIX,
  splitStablePrefix,
} from '@/ui/pages/chat/components/message/streamMarkdown'

/** 造一个足够长的段落（超过 MIN_STABLE_PREFIX） */
const longPara = (tag: string) => `${tag}:` + '这是一段足够长的正文内容。'.repeat(26)

const A = longPara('A')
const B = longPara('B')

describe('splitStablePrefix', () => {
  it('夹具本身要超过阈值，否则用例没有意义', () => {
    expect(A.length).toBeGreaterThan(MIN_STABLE_PREFIX)
  })

  it('短文档不拆分（拆分收益为负）', () => {
    const content = '短内容\n\n再来一小段'
    expect(content.length).toBeLessThan(MIN_STABLE_PREFIX)
    expect(splitStablePrefix(content)).toEqual(['', content])
  })

  it('长前缀 + 空行 + 正在增长的段落 → 切在空行', () => {
    expect(splitStablePrefix(`${A}\n\nB: 正在增长`)).toEqual([A, 'B: 正在增长'])
  })

  it('取最靠后的合法切点（尾部只保留正在写的那个块）', () => {
    expect(splitStablePrefix(`${A}\n\n${B}\n\nC: 正在增长`)).toEqual([
      `${A}\n\n${B}`,
      'C: 正在增长',
    ])
  })

  it('未闭合的围栏代码块内部不切分，整体留在尾部', () => {
    const fence = '```js\nconst a = 1\n\nconst b = 2\n'
    expect(splitStablePrefix(`${A}\n\n${fence}`)).toEqual([A, fence])
  })

  it('已闭合的代码块整体冻结进前缀（不在块内切分）', () => {
    const fence = '```js\nconst a = 1\n\nconst b = 2\n```'
    const [p, t] = splitStablePrefix(`${A}\n\n${fence}\n\n${B}`)
    expect(p).toBe(`${A}\n\n${fence}`)
    expect(t).toBe(B)
    // 前缀里的围栏是完整的（成对出现）
    expect(p.split('```').length - 1).toBe(2)
  })

  it('列表内部不切分（避免劈成两个列表）', () => {
    const content = `${A}\n\n- item A\n\n- item B`
    expect(splitStablePrefix(content)).toEqual(['', content])
  })

  it('尾部以列表项开头时不切分（同上）', () => {
    const content = `${A}\n\n- 正在写的新条目`
    expect(splitStablePrefix(content)).toEqual(['', content])
  })

  it('引用 / 表格边界同样不切分', () => {
    const quote = `${A}\n\n> 引用第一行`
    expect(splitStablePrefix(quote)).toEqual(['', quote])
    const table = `${A}\n\n| a | b |`
    expect(splitStablePrefix(table)).toEqual(['', table])
  })

  it('尾部是缩进代码块时不切分', () => {
    const content = `${A}\n\n    indented code`
    expect(splitStablePrefix(content)).toEqual(['', content])
  })

  it('尾部为空（内容以空行结尾）时不切分', () => {
    const content = `${A}\n\n`
    expect(splitStablePrefix(content)).toEqual(['', content])
  })

  it('切分不变量：prefix 是内容的前缀、tail 是内容的后缀、两者都非空', () => {
    const content = `${A}\n\n${B}`
    const [p, t] = splitStablePrefix(content)
    expect(p.length).toBeGreaterThan(0)
    expect(t.length).toBeGreaterThan(0)
    expect(content.startsWith(p)).toBe(true)
    expect(content.endsWith(t)).toBe(true)
  })

  it('逐块增长：前缀越冻越多，尾部始终只剩正在写的那一小块', () => {
    const blocks = [A, '```ts\nconst a = 1\n```', B, '正在写：最后一段']
    let content = ''
    const sizes: Array<[number, number]> = []
    for (const block of blocks) {
      content += `${content ? '\n\n' : ''}${block}`
      const [p, t] = splitStablePrefix(content)
      sizes.push([p.length, t.length])
    }
    // 最后一步：前缀已经很大且被冻结，尾部只有正在写的几个字
    const [prefixLen, tailLen] = sizes[sizes.length - 1]
    expect(prefixLen).toBeGreaterThan(600)
    expect(tailLen).toBeLessThan(40)
  })
})
