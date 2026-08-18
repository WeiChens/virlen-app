/**
 * read_file 工具 — 行内字符上限保护测试
 *
 * 回归场景：文件只有一行但内容极大（minified JS/CSS、超长 JSON/base64 等），
 * 仅靠 max_lines 行数限制无法裁剪，会导致 AI token 急剧飙升甚至超出上下文。
 * 修复后 read_file 增加 max_line_chars 行内字符上限，超长行会被截断并标记，
 * 普通多行文件仍可完整返回 max_lines 行。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { toolRegistry } from '@/domain/tools'
import type {
  ToolContext,
  ToolExecutorResponse,
} from '@/domain/tools/types'

// Mock 安全服务：resolveSafePath 直接返回输入路径，避免依赖真实工作区逻辑
vi.mock('@/services/security-service', () => ({
  securityService: {
    resolveSafePath: vi.fn(async (p: string) => p),
    getSkipEachDirs: vi.fn(async () => []),
  },
}))

// 引入文件工具模块（触发 read_file 等工具注册）
import '@/infrastructure/tools/file-tools'

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    toolCallId: 'test-call',
    abortSignal: new AbortController().signal,
    write: () => {},
  }
}

/** 从工具返回值中提取纯文本内容 */
function toText(result: ToolExecutorResponse): string {
  if (typeof result === 'string') return result
  if ('content' in result) return result.content
  return JSON.stringify(result)
}

describe('read_file 行内字符上限保护', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('单行超大文件应被 max_line_chars 截断并标记，防止 token 爆炸', async () => {
    const hugeLine = 'x'.repeat(200_000)
    vi.mocked(invoke).mockResolvedValue({
      content: hugeLine,
      hash: 'hash-huge',
      line_count: 1,
      byte_size: hugeLine.length,
    })

    const tool = await toolRegistry.get('read_file')
    expect(tool).toBeDefined()

    const result = await tool!.executor({ path: '/mock/huge.txt' }, makeCtx())
    const text = toText(result)

    // 默认 max_line_chars=2000，返回内容应远小于 20 万字符原文
    expect(text.length).toBeLessThan(3000)
    // 截断标记 + max_line_chars 提示必须存在，AI 才能知道内容不完整
    expect(text).toContain('已截断')
    expect(text).toContain('max_line_chars')
    // 表头仍应包含元信息
    expect(text).toContain('SHA256: hash-huge')
  })

  it('普通多行文件不触发截断', async () => {
    const content = 'line1\nline2\nline3'
    vi.mocked(invoke).mockResolvedValue({
      content,
      hash: 'hash-normal',
      line_count: 3,
      byte_size: content.length,
    })

    const tool = await toolRegistry.get('read_file')
    const result = await tool!.executor({ path: '/mock/a.txt' }, makeCtx())
    const text = toText(result)

    expect(text).toContain('line1')
    expect(text).toContain('line3')
    expect(text).not.toContain('已截断')
  })

  it('多行超长内容应逐行截断并统计截断行数', async () => {
    const lines = Array.from({ length: 5 }, () => 'y'.repeat(5000))
    const content = lines.join('\n')
    vi.mocked(invoke).mockResolvedValue({
      content,
      hash: 'hash-longlines',
      line_count: 5,
      byte_size: content.length,
    })

    const tool = await toolRegistry.get('read_file')
    const result = await tool!.executor({ path: '/mock/long.txt' }, makeCtx())
    const text = toText(result)

    // 每行 5000 字符 > 默认 max_line_chars=2000，5 行都应被截断
    expect(text).toContain('已截断')
    expect(text).toContain('有 5 行内容过长')
    expect(text).toContain('max_line_chars')
    // 总长度应远小于原文 5 × 5000
    expect(text.length).toBeLessThan(5 * 2100 + 500)
  })

  it('短行文件按 max_lines 返回，不截断行内容', async () => {
    const total = 3000
    const content = Array.from({ length: total }, (_, i) => `line${i}`).join(
      '\n',
    )
    vi.mocked(invoke).mockResolvedValue({
      content,
      hash: 'hash-short',
      line_count: total,
      byte_size: content.length,
    })

    const tool = await toolRegistry.get('read_file')
    const result = await tool!.executor({ path: '/mock/short.txt' }, makeCtx())
    const text = toText(result)

    // 默认 max_lines=2000，剩余 1000 行；短行不触发行内截断
    expect(text).toContain('剩余 1000 行')
    expect(text).not.toContain('已截断')
  })
})
