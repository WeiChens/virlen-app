/**
 * compress-raw 测试 — 正文压缩（本地压缩）
 *
 * 核心契约：
 * - 用户 / 助手正文一字不删（哪怕很长）
 * - 深度思考整段丢弃
 * - 工具参数超长只截尾部；工具结果超长保留头尾、省略中间
 * - 图片降级为占位（有本地视觉分析结果时保留分析文本）
 * - 省略量必须显式写进摘要，模型才知道内容被裁过
 */
import { describe, it, expect } from 'vitest'
import { buildRawSummary } from '@/domain/engine/compress-raw'
import { hasLoneSurrogate } from '@/utils/text'
import type { Message } from '@/types'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('buildRawSummary', () => {
  it('正文一字不删，深度思考整段丢弃', () => {
    const body = 'A'.repeat(5000)
    const r = buildRawSummary([
      msg({ role: 'user', content: '用户的正文' }),
      msg({
        role: 'assistant',
        content: body,
        reasoningContent: 'THINKING_SHOULD_BE_GONE',
      }),
    ])

    expect(r.summary).toContain('用户的正文')
    expect(r.summary).toContain(body)
    expect(r.summary).not.toContain('THINKING_SHOULD_BE_GONE')
    expect(r.omittedChars).toBe(0)
  })

  it('工具参数超长时只截尾部，并写明省略量', () => {
    const args = { path: 'x'.repeat(1000) }
    const r = buildRawSummary([
      msg({
        role: 'assistant',
        content: '调用工具',
        toolCalls: [
          { type: 'tool_use', id: 't1', name: 'read_file', input: args },
        ],
      }),
    ])

    expect(r.summary).toContain('- [tool call] read_file:')
    expect(r.summary).toContain('characters omitted')
    // 保留文件路径头部（前 300 字符里能看到 "path"）
    expect(r.summary).toContain('"path":"xxx')
    expect(r.omittedChars).toBeGreaterThan(0)
  })

  it('工具结果超长时保留头尾、省略中间，并标出工具名', () => {
    const long = 'H'.repeat(500) + 'M'.repeat(3000) + 'T'.repeat(200)
    const r = buildRawSummary([
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [
          { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
        ],
      }),
      msg({ role: 'tool', content: long, toolCallId: 't1' }),
    ])

    expect(r.summary).toContain('## Tool result: read_file')
    expect(r.summary).toContain('H'.repeat(500))
    expect(r.summary).toContain('T'.repeat(200))
    expect(r.summary).not.toContain('M'.repeat(10))
    expect(r.omittedChars).toBe(3000)
  })

  it('失败的工具结果标注 (error)', () => {
    const r = buildRawSummary([
      msg({ role: 'tool', content: 'boom', toolCallId: 't9', isError: true }),
    ])
    expect(r.summary).toContain('## Tool result (error)')
    expect(r.summary).toContain('boom')
  })

  it('短内容不做任何省略，且不写省略统计', () => {
    const r = buildRawSummary([
      msg({ role: 'user', content: '你好' }),
      msg({ role: 'assistant', content: '你好！' }),
    ])
    expect(r.omittedChars).toBe(0)
    expect(r.summary).not.toContain('Truncated')
    expect(r.summary).not.toContain('characters omitted')
  })

  it('图片降级为占位，有本地视觉分析结果时保留分析文本', () => {
    const r = buildRawSummary([
      msg({
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAAA' },
          },
        ],
        imageVisionAnalyzeResult: 'Tree: Button ...',
      }),
    ])

    expect(r.summary).toContain('看这张图')
    expect(r.summary).toContain('[Image]')
    expect(r.summary).toContain('Tree: Button ...')
    expect(r.summary).not.toContain('base64')
    expect(r.summary).toContain('Images are represented as placeholders')
  })

  it('file / quote / skill 块复用各协议共用的降级文本', () => {
    const r = buildRawSummary([
      msg({
        role: 'user',
        content: [
          { type: 'file', path: 'C:/a/b.txt', name: 'b.txt' },
          {
            type: 'quote',
            messageId: 'm1',
            role: 'assistant',
            text: '被引用的正文',
          },
          {
            type: 'skill',
            name: 'my-skill',
            path: 'C:/skills/my-skill',
            content: '# SKILL',
          },
        ],
      }),
    ])

    expect(r.summary).toContain('[User attached file] C:/a/b.txt')
    expect(r.summary).toContain('[Quoted message]')
    expect(r.summary).toContain('被引用的正文')
    expect(r.summary).toContain('[Skill]')
  })

  it('上一轮 summary 的内容当正文保留（可反复压缩）', () => {
    const r = buildRawSummary([
      msg({ role: 'summary', content: '旧摘要正文' }),
      msg({ role: 'user', content: '新问题' }),
    ])

    expect(r.summary).toContain('## Earlier summary')
    expect(r.summary).toContain('旧摘要正文')
    expect(r.summary).toContain('## User')
    expect(r.summary).toContain('新问题')
  })

  it('没有工具调用时不必产生 toolNames 映射也不报错', () => {
    const r = buildRawSummary([msg({ role: 'tool', content: '孤立结果' })])
    expect(r.summary).toContain('## Tool result')
    expect(r.summary).toContain('孤立结果')
  })

  // 回归：线上事故 —— 按码元裸切会把 emoji 切成孤立代理，
  // 经 JSON.stringify + Rust serde_json 直接报 "unexpected end of hex escape"。
  it('截断工具结果时不会把 emoji 切成孤立代理（头截断）', () => {
    // TOOL_RESULT_HEAD_CHARS = 500：让 '😀'(U+D83D U+DE00) 正好跨在切点上
    const body = 'a'.repeat(499) + '😀' + 'b'.repeat(400)
    const r = buildRawSummary([
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
      }),
      msg({ role: 'tool', content: body, toolCallId: 't1' }),
    ])
    expect(r.summary).toContain('characters omitted')
    expect(hasLoneSurrogate(r.summary)).toBe(false)
  })

  it('截断工具结果时不会把 emoji 切成孤立代理（尾截断）', () => {
    // TOOL_RESULT_TAIL_CHARS = 200：让切点正好落在低代理上
    const body = 'a'.repeat(700) + '😀' + 'b'.repeat(199)
    const r = buildRawSummary([msg({ role: 'tool', content: body })])
    expect(r.summary).toContain('b'.repeat(199))
    expect(hasLoneSurrogate(r.summary)).toBe(false)
  })

  it('截断工具参数时不会把 emoji 切成孤立代理', () => {
    // TOOL_ARGS_MAX_CHARS = 300：JSON 前缀 `{"path":"` 占 9 字符，
    // 290 个 x 后紧跟 emoji，让切点正落在其低代理上
    const r = buildRawSummary([
      msg({
        role: 'assistant',
        content: '调用工具',
        toolCalls: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'write_file',
            input: { path: 'x'.repeat(290) + '😀' + 'y'.repeat(10) },
          },
        ],
      }),
    ])
    expect(r.summary).toContain('characters omitted')
    expect(hasLoneSurrogate(r.summary)).toBe(false)
  })
})
