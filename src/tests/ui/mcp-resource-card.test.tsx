/**
 * McpResourceMessage —— MCP **资源**工具（`list_mcp_resources` / `read_mcp_resource`）的卡片。
 *
 * 这张卡吃的是 `virlen-core/src/mcp/resources.rs::project_*` 下发的 `uiData`（形状即契约）。
 * 本文件守五条：
 *   ① 两个工具名都精确注册到本卡片（不是前缀兜底）；
 *   ② 标签区分「资源列表」与「单份资源」；
 *   ③ 列表收起态 = 「N 个资源（M 个服务器）」，展开态一台服务器一段、资源逐条；
 *   ④ 单份资源：有正文就渲染正文，纯二进制只报大小（绝不显示 base64）；
 *   ⑤ 形状不对不抛异常（宁可退回正文，也不要白屏）。
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import McpResourceMessage from '@/ui/pages/chat/components/tool-call/McpResourceMessage'
import { getToolCallMessage } from '@/ui/pages/chat/components/tool-call/IToolCallMessage'
import type { Message, ToolUseContent } from '@/types'

// Monaco 在 happy-dom 里跑不起来（注册表会把所有卡片拉进来）
vi.mock('@/monaco/setupMonaco', () => ({ monaco: {}, virlenDarkTheme: {} }))
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: ({ code }: any) => <pre className="mock-code-preview">{code}</pre>,
}))

const inst = new McpResourceMessage()

const listUse: ToolUseContent = {
  type: 'tool_use',
  id: 'tc-list',
  name: 'list_mcp_resources',
  input: { server: 'fs' },
}

const readUse: ToolUseContent = {
  type: 'tool_use',
  id: 'tc-read',
  name: 'read_mcp_resource',
  input: { server: 'fs', uri: 'file:///a.md' },
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

function html(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>)
}

const listUi = {
  type: 'mcp_resources',
  servers: [
    {
      server: 'fs',
      state: 'ready',
      resources: [
        {
          uri: 'file:///notes.md',
          name: 'notes',
          mimeType: 'text/markdown',
          size: 120,
          description: '项目笔记',
        },
      ],
    },
    {
      server: 'db',
      state: 'connecting',
      resources: [] as any[],
      error: 'MCP server "db" is not connected (connecting)',
    },
  ],
}

describe('McpResourceMessage —— MCP 资源卡片', () => {
  it('两个工具名都精确注册到本卡片', () => {
    const list = getToolCallMessage('list_mcp_resources')
    const read = getToolCallMessage('read_mcp_resource')
    expect(list).toBeInstanceOf(McpResourceMessage)
    expect(read).toBeInstanceOf(McpResourceMessage)
    expect(list.getToolLabel('list_mcp_resources')).toBe('MCP 资源列表')
    expect(read.getToolLabel('read_mcp_resource')).toBe('MCP 资源')
  })

  it('收起态：列表报「N 个资源（M 个服务器）」，单份资源报 uri', () => {
    const list = String(inst.getShortText({ useContent: listUse, message: result({ uiData: listUi }) }))
    expect(list).toContain('1 个资源')
    expect(list).toContain('2 个服务器')

    const read = String(
      inst.getShortText({
        useContent: readUse,
        message: result({ uiData: { type: 'mcp_resource', uri: 'file:///a.md' } }),
      }),
    )
    expect(read).toBe('file:///a.md')
  })

  it('没有结果（还在跑）时显示参数摘要', () => {
    expect(String(inst.getShortText({ useContent: readUse }))).toContain('file:///a.md')
  })

  it('空列表给明确结论（不是空白一行）', () => {
    const text = String(
      inst.getShortText({
        useContent: listUse,
        message: result({ uiData: { type: 'mcp_resources', servers: [] } }),
      }),
    )
    expect(text).toBe('没有可用的 MCP 资源')
  })

  it('展开态：一台服务器一段，资源逐条（uri / mime / 大小 / 描述）', () => {
    const out = html(
      inst.getExpandView({ useContent: listUse, message: result({ uiData: listUi }), expand: true }),
    )
    expect(out).toContain('fs')
    expect(out).toContain('file:///notes.md')
    expect(out).toContain('text/markdown')
    expect(out).toContain('120 B')
    expect(out).toContain('项目笔记')
    // 连不上的服务器如实说明原因，而不是从列表里消失
    expect(out).toContain('服务器暂时不可用')
    expect(out).toContain('not connected')
    // 两个服务器各一层 mcp-block
    expect(out.match(/class="mcp-block"/g)?.length).toBe(2)
  })

  it('单份资源：有正文渲染正文，纯二进制只报大小', () => {
    const text = html(
      inst.getExpandView({
        useContent: readUse,
        message: result({
          uiData: {
            type: 'mcp_resource',
            server: 'fs',
            uri: 'file:///a.md',
            mimeType: 'text/markdown',
            bytes: 0,
            contents: 1,
            text: '# 标题\n正文',
          },
        }),
        expand: true,
      }),
    )
    expect(text).toContain('# 标题\n正文')

    const binary = html(
      inst.getExpandView({
        useContent: readUse,
        message: result({
          uiData: {
            type: 'mcp_resource',
            server: 'fs',
            uri: 'file:///b.bin',
            mimeType: 'application/octet-stream',
            bytes: 2048,
            contents: 1,
          },
        }),
        expand: true,
      }),
    )
    expect(binary).toContain('2 KB')
    expect(binary).toContain('未显示')
    expect(binary).not.toContain('base64')
  })

  it('结果被截断时给出说明', () => {
    const out = html(
      inst.getExpandView({
        useContent: listUse,
        message: result({ uiData: { ...listUi, truncated: true } }),
        expand: true,
      }),
    )
    expect(out).toContain('截断')
  })

  it('isError：走红色通道并显示错误正文', () => {
    const out = html(
      inst.getExpandView({
        useContent: listUse,
        message: result({ content: 'MCP server "ghost" is not configured', isError: true }),
        expand: true,
      }),
    )
    expect(out).toContain('class="error"')
    expect(out).toContain('not configured')
  })

  it('不认识的形状不抛异常（退回正文纯文本）', () => {
    const out = html(
      inst.getExpandView({
        useContent: listUse,
        message: result({ uiData: { servers: 'not-an-array' } as any }),
        expand: true,
      }),
    )
    expect(out).toContain('没有可用的 MCP 资源')
  })
})
