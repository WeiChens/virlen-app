/**
 * utils/text — 代理对（surrogate pair）安全截断 / 清洗
 *
 * 回归背景（线上事故）：正文压缩用裸 slice 截断工具输出，把 emoji 切成孤立代理，
 * `JSON.stringify` 输出 `\ud83d`，Rust `serde_json` 报
 * "unexpected end of hex escape at line 1 column N"，整次 agent_send_message 失败。
 */
import { describe, it, expect } from 'vitest'
import {
  sliceHead,
  sliceTail,
  hasLoneSurrogate,
  stripLoneSurrogates,
  sanitizeLoneSurrogates,
} from '@/utils/text'

/** U+D83D U+DE00 —— 站两个码元，最容易被截断切开 */
const EMOJI = '😀'

describe('sliceHead / sliceTail', () => {
  it('sliceHead 在截断点落到低代理时退一格，不产生孤立代理', () => {
    const text = 'aaa' + EMOJI + 'b' // 3 = 高代理, 4 = 低代理
    const cut = sliceHead(text, 4)
    expect(cut).toBe('aaa')
    expect(hasLoneSurrogate(cut)).toBe(false)
    // 不切在代理对中间时行为与 slice 一致
    expect(sliceHead(text, 5)).toBe('aaa' + EMOJI)
    expect(sliceHead(text, 0)).toBe('')
    expect(sliceHead(text, 99)).toBe(text)
  })

  it('sliceTail 在起点落到低代理时前进一格，不产生孤立代理', () => {
    const text = 'aaa' + EMOJI + 'bbb' // 长度 8：3 = 高代理, 4 = 低代理
    const cut = sliceTail(text, 4) // start = 4（低代理）
    expect(cut).toBe('bbb')
    expect(hasLoneSurrogate(cut)).toBe(false)
    // 起点落在高代理上不切（下一个码元是配对的低代理，属于「整对保留」）
    expect(sliceTail(text, 5)).toBe(EMOJI + 'bbb')
    expect(sliceTail(text, 0)).toBe('')
    expect(sliceTail(text, 99)).toBe(text)
  })
})

describe('hasLoneSurrogate', () => {
  it('合法文本 / 完整 emoji 判为非孤立', () => {
    expect(hasLoneSurrogate('')).toBe(false)
    expect(hasLoneSurrogate('a😀b')).toBe(false)
    expect(hasLoneSurrogate('中文\n\t✅')).toBe(false)
  })

  it('孤立高/低代理判为命中', () => {
    expect(hasLoneSurrogate('\ud83d')).toBe(true) // 半个 emoji
    expect(hasLoneSurrogate('\ude00')).toBe(true)
    expect(hasLoneSurrogate('a\ud83db')).toBe(true)
    expect(hasLoneSurrogate('a😀b\ude00')).toBe(true)
  })
})

describe('stripLoneSurrogates', () => {
  it('只丢残缺的半个字符', () => {
    expect(stripLoneSurrogates('x\ud83dy')).toBe('xy')
    expect(stripLoneSurrogates('\ude00x')).toBe('x')
    expect(stripLoneSurrogates('a😀b\ude00c')).toBe('a😀bc')
  })

  it('无孤立代理时返回同一引用（不走复制）', () => {
    const s = 'a😀b'
    expect(stripLoneSurrogates(s)).toBe(s)
  })
})

describe('sanitizeLoneSurrogates（IPC 边界兜底）', () => {
  it('无问题时原样返回同一引用，不产生任何拷贝', () => {
    const payload = { a: ['x', { b: '😀' }], n: 1 }
    expect(sanitizeLoneSurrogates(payload)).toBe(payload)
  })

  it('递归清洗字符串，且不修改原对象', () => {
    const payload = { msgs: [{ content: 'a\ud83d' }, { content: '\ude00b' }] }
    const cleaned = sanitizeLoneSurrogates(payload) as typeof payload
    expect(cleaned.msgs[0].content).toBe('a')
    expect(cleaned.msgs[1].content).toBe('b')
    // 原对象未被就地改写
    expect(payload.msgs[0].content).toBe('a\ud83d')
    expect(cleaned).not.toBe(payload)
  })

  it('不递归非普通对象（Date 等实例保持原样）', () => {
    const d = new Date(0)
    const payload = { d }
    expect(sanitizeLoneSurrogates(payload)).toBe(payload)
    expect((sanitizeLoneSurrogates(payload) as typeof payload).d).toBe(d)
  })
})
