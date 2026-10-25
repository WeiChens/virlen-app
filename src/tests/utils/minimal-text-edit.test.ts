// @vitest-environment node
/**
 * 「旧文本 → 新文本」的最小编辑区间。
 *
 * 这条纯函数决定了文件在磁盘上被改过之后，编辑器里到底换掉哪一段：
 * 算宽了光标会跳、算窄了内容会错（后者更致命）。所以这里把几种边界都钉死。
 */
import { describe, expect, it } from 'vitest'
import { computeMiddleEdit } from '@/utils/minimal-text-edit'

describe('computeMiddleEdit', () => {
  it('两边相同 → null（不该有任何编辑）', () => {
    expect(computeMiddleEdit('abc', 'abc')).toBeNull()
    expect(computeMiddleEdit('', '')).toBeNull()
  })

  it('尾部插入：只加一段，前缀不动', () => {
    expect(computeMiddleEdit('ab', 'abXY')).toEqual({
      startOffset: 2,
      endOffset: 2,
      text: 'XY',
    })
  })

  it('尾部删除：区间为空文本', () => {
    expect(computeMiddleEdit('abXY', 'ab')).toEqual({
      startOffset: 2,
      endOffset: 4,
      text: '',
    })
  })

  it('中间替换：前缀 + 后缀都裁掉，只剩改动的那一小段', () => {
    // "hello\nword" → "hello\nworld"：只插一个 l
    expect(computeMiddleEdit('hello\nword', 'hello\nworld')).toEqual({
      startOffset: 9,
      endOffset: 9,
      text: 'l',
    })
  })

  it('前后缀会「互相吃」的情况不能算成空区间', () => {
    // "ab" → "ba"：前缀 0、后缀 0（后缀不能越过前缀），整段换
    expect(computeMiddleEdit('ab', 'ba')).toEqual({
      startOffset: 0,
      endOffset: 2,
      text: 'ba',
    })
  })

  it('CRLF 文本按 UTF-16 偏移算（偏移 ↔ 行列交给 Monaco）', () => {
    expect(computeMiddleEdit('a\r\nb', 'a\r\nc')).toEqual({
      startOffset: 3,
      endOffset: 4,
      text: 'c',
    })
  })

  it('代理对（emoji）不会被拆坏', () => {
    const edit = computeMiddleEdit('😀a', '😀b')!
    expect(edit).toEqual({ startOffset: 2, endOffset: 3, text: 'b' })
  })

  it('空文件 → 有内容 = 一次纯插入', () => {
    expect(computeMiddleEdit('', 'abc')).toEqual({
      startOffset: 0,
      endOffset: 0,
      text: 'abc',
    })
  })

  it('有内容 → 空文件 = 一次纯删除', () => {
    expect(computeMiddleEdit('abc', '')).toEqual({
      startOffset: 0,
      endOffset: 3,
      text: '',
    })
  })
})
