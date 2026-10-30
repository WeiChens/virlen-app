/**
 * mdBlocks（文件预览 markdown 虚拟渲染的块切分器）用例。
 *
 * 核心不变量：**每一段片段单独渲染的结果 == 整篇渲染时该片段对应部分的结果**。
 * 文本级用例验证「不切错」（围栏内部、列表/引用/表格行间、setext 标题）；渲染级一致性由
 * `workspace-file-preview.test.tsx` 的组件用例兜底（虚拟与整篇两条路都过 MarkdownRenderer）。
 */
import { describe, it, expect } from 'vitest'
import { splitMarkdownBlocks, MIN_VIRTUALIZE_CHARS } from '@/ui/pages/chat/components/workspace-file/mdBlocks'

/** 造一段超过阈值的长文本（repeat 次 unit，空行分隔） */
const long = (unit: string, repeat: number) => Array.from({ length: repeat }, () => unit).join('\n\n')

/** 必须远大于 MIN_VIRTUALIZE_CHARS / SPLIT_OVER，否则走短文档 / 不二次切分路径 */
const BIG = MIN_VIRTUALIZE_CHARS * 2

describe('splitMarkdownBlocks — 短文档不切', () => {
  it('总长 < MIN_VIRTUALIZE_CHARS 时返回单块（调用方整篇渲染）', () => {
    expect(splitMarkdownBlocks('# hi\n\npara')).toHaveLength(1)
  })
})

describe('splitMarkdownBlocks — 顶层块切分', () => {
  it('标题 / 段落 / 代码块各自成块，拼回去内容不丢', () => {
    const md = [
      '# 标题',
      '',
      long('这是很长的一第一段。', Math.ceil(BIG / 10)),
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '结尾段落',
    ].join('\n')
    const blocks = splitMarkdownBlocks(md)
    expect(blocks.length).toBeGreaterThan(1)
    for (const b of blocks) expect(b.trim()).not.toBe('')
    const joined = blocks.join('\n\n')
    for (const line of md.split('\n')) {
      if (line.trim() !== '') expect(joined).toContain(line)
    }
  })

  it('围栏代码块整体一块，内部空行不切', () => {
    const md = [
      '前置段落',
      '',
      '```',
      '',
      'in fence',
      '',
      'still fence',
      '```',
      '',
      long('后置的长段落内容。', Math.ceil(BIG / 10)),
    ].join('\n')
    const blocks = splitMarkdownBlocks(md)
    const fenceBlock = blocks.find((b) => b.includes('in fence'))
    expect(fenceBlock).toBeDefined()
    expect(fenceBlock).toContain('still fence') // 围栏没被内部空行拆开
  })

  it('列表连续行粘在一个块里', () => {
    const md = [
      '前文',
      '',
      '- 项一',
      '- 项二',
      '  续行',
      '',
      long('列表之后的长段落内容。', Math.ceil(BIG / 10)),
    ].join('\n')
    const blocks = splitMarkdownBlocks(md)
    const listBlock = blocks.find((b) => b.startsWith('- 项一'))
    expect(listBlock).toBeDefined()
    expect(listBlock).toContain('项二')
    expect(listBlock).toContain('续行')
  })

  it('表格整表一块', () => {
    const md = [
      long('表格之前的段落。', Math.ceil(BIG / 10)),
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
      '尾',
    ].join('\n')
    const blocks = splitMarkdownBlocks(md)
    const table = blocks.find((b) => b.includes('| a | b |'))
    expect(table).toContain('| 3 | 4 |')
  })

  it('引用块粘在一起', () => {
    const md = [
      long('引用之前的段落。', Math.ceil(BIG / 10)),
      '',
      '> 引一行',
      '> 引二行',
      '',
      '尾',
    ].join('\n')
    const blocks = splitMarkdownBlocks(md)
    const quote = blocks.find((b) => b.startsWith('> 引一行'))
    expect(quote).toContain('引二行')
  })

  it('setext 标题下划线不与段落切开', () => {
    const md = [
      long('下划线标题前的段落。', Math.ceil(BIG / 10)),
      '',
      '大标题',
      '===',
      '',
      '尾',
    ].join('\n')
    const blocks = splitMarkdownBlocks(md)
    const owner = blocks.find((b) => b.includes('大标题'))
    expect(owner).toContain('===')
  })
})

describe('splitMarkdownBlocks — 超长片段二次切分', () => {
  it('超长围栏代码块按行切并补围栏', () => {
    // 每行 ~10 字，2000 行 ≈ 20k 字，远超 SPLIT_OVER
    const md = ['```', ...Array.from({ length: 2000 }, (_, i) => `line ${i}`), '```'].join('\n')
    const blocks = splitMarkdownBlocks(md)
    expect(blocks.length).toBeGreaterThan(1)
    // 每块都以围栏开头结尾（首尾补了 fence）
    for (const b of blocks) {
      expect(b.startsWith('```')).toBe(true)
      expect(b.endsWith('```')).toBe(true)
    }
    // 行不丢
    const joined = blocks.map((b) => b.split('\n').slice(1, -1).join('\n')).join('\n')
    for (let i = 0; i < 2000; i += 100) expect(joined).toContain(`line ${i}`)
  })

  it('超长多段落按空行切，段落不被腰斩', () => {
    const md = Array.from({ length: 2000 }, (_, i) => `第 ${i} 段正文内容。`).join('\n\n')
    const blocks = splitMarkdownBlocks(md)
    expect(blocks.length).toBeGreaterThan(1)
    for (const b of blocks) {
      // 每个块都是整段集合（无半句）；块尾可能残留换行，先归一化再断言
      const t = b.replace(/\n+$/, '')
      expect(t.startsWith('第 ')).toBe(true)
      expect(t.endsWith('。')).toBe(true)
    }
  })

  it('切不动的超长单段落保持原样（宁可留大块也不改变渲染结果）', () => {
    const md = Array.from({ length: BIG }, (_, i) => `词${i}`).join(' ')
    const blocks = splitMarkdownBlocks(md)
    expect(blocks).toHaveLength(1)
  })
})

describe('splitMarkdownBlocks — 常量口径', () => {
  it('MIN_VIRTUALIZE_CHARS 是导出的阈值', () => {
    expect(MIN_VIRTUALIZE_CHARS).toBeGreaterThan(0)
  })
})
