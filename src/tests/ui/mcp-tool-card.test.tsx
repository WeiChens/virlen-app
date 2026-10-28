/**
 * McpToolMessage —— 任意 MCP 服务器工具的卡片（`mcp__<server>__<raw>`）。
 *
 * 这张卡是**唯一**给所有 MCP 工具用的：前端在编译期不知道服务器会提供哪些工具，所以它是
 * 按 Rust `mcp/results.rs::project` 下发的 `uiData.blocks[]` 通用渲染的。本文件守五条：
 *   ① `mcp__*` 前缀兜底到本卡片（不是逐个注册），其它名字仍精确匹配；
 *   ② 收起态那一行 = 首个文本块的首个非空行（超长截断）；
 *   ③ 展开态按块类型渲染（文本 / 图片诊断 / 结构化 JSON / 链接）；
 *   ④ 图片块**只报大小**，绝不出现 base64（结果里本来也没有）；
 *   ⑤ `isError` 走红色通道，且优先显示错误正文。
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import McpToolMessage from '@/ui/pages/chat/components/tool-call/McpToolMessage'
import { getToolCallMessage } from '@/ui/pages/chat/components/tool-call/IToolCallMessage'
import type { Message, ToolUseContent } from '@/types'

// Monaco 在 happy-dom 里跑不起来（`@mono-codicon/codicon.css` 与 worker 都无法解析）。
// 这里只为了能 import `IToolCallMessage` 的注册表（它会把所有卡片拉进来），不影响 MCP 卡片。
vi.mock('@/monaco/setupMonaco', () => ({ monaco: {}, virlenDarkTheme: {} }))
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: ({ code }: any) => <pre className="mock-code-preview">{code}</pre>,
}))

const inst = new McpToolMessage()

const useContent: ToolUseContent = {
  type: 'tool_use',
  id: 'tc1',
  name: 'mcp__fs__read_file',
  input: { path: '/tmp/a.txt' },
}

function result(over: Partial<Message> = {}): Message {
  return {
    id: 'r1',
    role: 'tool',
    content: 'RAW_MODEL_TEXT',
    timestamp: 0,
    ...over,
  } as Message
}

/** 与 `tool-call/index.tsx` 的 `ToolCallExpandView` 同构：把 getExpandView 的结果渲染成 HTML */
function html(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>)
}

describe('McpToolMessage —— 通用 MCP 工具卡片', () => {
  it('`mcp__*` 前缀兜底到本卡片，其它未知名字仍退 DefaultMessage', () => {
    const mcp = getToolCallMessage('mcp__fs__read_file')
    expect(mcp.getToolLabel('mcp__fs__read_file')).toContain('fs')

    const unknown = getToolCallMessage('no_such_tool')
    // DefaultMessage 的标签就是工具名本身（不做任何美化）
    expect(unknown.getToolLabel('no_such_tool')).toBe('no_such_tool')
  })

  it('标签 = MCP · <server>；解析不出形状时退回通用文案', () => {
    expect(inst.getToolLabel('mcp__fs__read_file')).toBe('MCP · fs')
    expect(inst.getToolLabel('mcp__broken')).toBe('MCP 工具')
  })

  it('收起态：首个文本块的首个非空行，超长截断', () => {
    const short = inst.getShortText({
      useContent,
      message: result({
        uiData: {
          type: 'mcp_tool',
          blocks: [{ type: 'text', text: '\n  第一行内容  \n第二行' }],
        },
      }),
    })
    expect(short).toBe('第一行内容')

    const long = 'x'.repeat(200)
    const truncated = inst.getShortText({
      useContent,
      message: result({ uiData: { blocks: [{ type: 'text', text: long }] } }),
    })
    expect(String(truncated).length).toBeLessThan(long.length)
    expect(String(truncated).endsWith('…')).toBe(true)
  })

  it('没有结果消息（还在跑）时显示参数摘要', () => {
    const text = String(inst.getShortText({ useContent }))
    expect(text).toContain('/tmp/a.txt')
  })

  it('展开态：文本 / 图片诊断 / 结构化 JSON 各按块类型渲染', () => {
    const out = html(
      inst.getExpandView({
        useContent,
        message: result({
          uiData: {
            type: 'mcp_tool',
            blocks: [
              { type: 'text', text: 'line 1\nline 2' },
              { type: 'image', mediaType: 'image/png', bytes: 2048 },
              { type: 'json', value: { count: 2 } },
            ],
          },
        }),
        expand: true,
      }),
    )
    // 文本原样（多行不被吃掉）
    expect(out).toContain('line 1\nline 2')
    // 图片只报类型与大小，绝不出现 base64 / data URI
    expect(out).toContain('image/png')
    expect(out).toContain('2 KB')
    expect(out).not.toContain('data:image')
    // 结构化结果收在 <details> 里（一次调用可能几百行）
    expect(out).toContain('<details')
    expect(out).toContain('&quot;count&quot;: 2')
    // 三块各一层容器
    expect(out.match(/class="mcp-block"/g)?.length).toBe(3)
  })

  it('没有结构化块（旧会话 / 其它宿主）时退回纯文本正文', () => {
    const out = html(
      inst.getExpandView({
        useContent,
        message: result({ content: 'plain fallback text' }),
        expand: true,
      }),
    )
    expect(out).toContain('plain fallback text')
  })

  it('结果被截断时给出说明', () => {
    const out = html(
      inst.getExpandView({
        useContent,
        message: result({
          uiData: { blocks: [{ type: 'text', text: 'x' }], truncated: true },
        }),
        expand: true,
      }),
    )
    expect(out).toContain('mcp-note')
    expect(out).toContain('截断')
  })

  it('isError：走红色通道并显示错误正文', () => {
    const out = html(
      inst.getExpandView({
        useContent,
        message: result({ content: 'ENOENT: no such file', isError: true }),
        expand: true,
      }),
    )
    expect(out).toContain('class="error"')
    expect(out).toContain('ENOENT: no such file')

    const short = inst.getShortText({
      useContent,
      message: result({ content: 'ENOENT: no such file', isError: true }),
    })
    expect(short).toBe('ENOENT: no such file')
  })

  it('不认识的结果形状不抛异常（宁可显示正文，也不要白屏）', () => {
    const out = html(
      inst.getExpandView({
        useContent,
        message: result({ uiData: { blocks: 'not-an-array' } as any }),
        expand: true,
      }),
    )
    expect(out).toContain('RAW_MODEL_TEXT')
  })
})
