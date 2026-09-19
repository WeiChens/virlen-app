/**
 * messageContent — 用户消息 content 组装 / 解析测试
 *
 * 重点守住两条不变量：
 *   1. 文件附件只带路径，绝不带文件内容（"不拷贝文件"是产品约定）
 *   2. 文本/图片的既有行为不被文件附件改变（回归保护）
 */
import { describe, it, expect } from 'vitest'
import {
  buildUserContent,
  getFileBlocks,
  getImageUrls,
  fileBlocksToText,
} from '@/utils/messageContent'
import { fileBlockToText } from '@/types'

const img = (n: number) => ({ url: `data:image/png;base64,IMG${n}` })

describe('buildUserContent', () => {
  it('纯文本：只产生一个 text 块', () => {
    expect(buildUserContent('你好')).toEqual([{ type: 'text', text: '你好' }])
  })

  it('文本 + 图片：text 在校首，image_url 依次在后', () => {
    const content = buildUserContent('看看', [img(1), img(2)]) as any[]
    expect(content.map((b) => b.type)).toEqual(['text', 'image_url', 'image_url'])
    expect(content[1].image_url.url).toBe('data:image/png;base64,IMG1')
  })

  it('文本 + 文件：文件块只带路径，不带任何文件内容', () => {
    const content = buildUserContent('读一下', [], [
      { path: 'C:/a/b.ts', name: 'b.ts', size: 12 },
    ]) as any[]

    expect(content).toEqual([
      { type: 'text', text: '读一下' },
      { type: 'file', path: 'C:/a/b.ts', name: 'b.ts', isDir: undefined, size: 12 },
    ])
    // 关键：块里除了路径与展示元数据，不应出现任何内容字段
    const fileBlock = content[1]
    expect(Object.keys(fileBlock).sort()).toEqual([
      'isDir',
      'name',
      'path',
      'size',
      'type',
    ])
  })

  it('无文本但有图片：沿用「分析这张/这N张图片」的兜底文案', () => {
    const one = buildUserContent('', [img(1)]) as any[]
    expect(one[0]).toEqual({ type: 'text', text: '分析这张图片' })

    const two = buildUserContent('', [img(1), img(2)]) as any[]
    expect(two[0]).toEqual({ type: 'text', text: '分析这2张图片' })
  })

  it('无文本但有文件：补一句「看看这些文件」，文件块仍只有路径', () => {
    const content = buildUserContent('', [], [{ path: '/tmp/a.txt' }]) as any[]
    expect(content[0]).toEqual({ type: 'text', text: '看看这些文件' })
    expect(content[1].type).toBe('file')
    expect(content[1].path).toBe('/tmp/a.txt')
  })

  it('空输入：返回空数组（不产生空 text 块）', () => {
    expect(buildUserContent('')).toEqual([])
    expect(buildUserContent('', [], [])).toEqual([])
  })

  it('三类附件混排：text → image → file', () => {
    const content = buildUserContent('干活', [img(1)], [
      { path: 'C:/a.ts' },
      { path: 'C:/dir', isDir: true },
    ]) as any[]
    expect(content.map((b) => b.type)).toEqual([
      'text',
      'image_url',
      'file',
      'file',
    ])
    expect(content[3].isDir).toBe(true)
  })
})

describe('getFileBlocks / getImageUrls', () => {
  it('字符串 content 不报错并返回空', () => {
    expect(getFileBlocks('plain')).toEqual([])
    expect(getImageUrls('plain')).toEqual([])
  })

  it('按类型筛出文件块与图片 url', () => {
    const content = buildUserContent('x', [img(1)], [{ path: 'C:/a.ts' }])
    expect(getFileBlocks(content).map((f) => f.path)).toEqual(['C:/a.ts'])
    expect(getImageUrls(content)).toEqual(['data:image/png;base64,IMG1'])
  })
})

describe('fileBlockToText', () => {
  // 这里故意断言字面量（而不是引用常量）：常量被改时要红，
  // 提醒同步 Rust 侧 provider.rs 的同名常量（铁律 1：双引擎文案一致）
  it('文件与目录给出不同标签，且只含路径', () => {
    expect(fileBlockToText({ type: 'file', path: 'C:/a.ts' })).toBe(
      '[User attached file] C:/a.ts',
    )
    expect(
      fileBlockToText({ type: 'file', path: 'C:/dir', isDir: true }),
    ).toBe('[User attached folder] C:/dir')
  })

  it('path 缺失时不产生 undefined 字面量', () => {
    expect(fileBlockToText({ type: 'file', path: '' })).toBe(
      '[User attached file] ',
    )
  })

  it('fileBlocksToText 逐行拼接', () => {
    expect(
      fileBlocksToText([
        { type: 'file', path: '/a' },
        { type: 'file', path: '/b' },
      ]),
    ).toBe('[User attached file] /a\n[User attached file] /b')
  })
})
