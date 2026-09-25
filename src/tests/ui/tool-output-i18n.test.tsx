/**
 * Group A 组件「只依赖结构化 uiData 本地化」测试（P4b）
 *
 * 目的：把「模型侧固定英文」与「界面跟随用户语言」钉开 ——
 * 组件有 uiData 时**不得**再渲染模型侧英文原文（旧数据除外）。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// ListFilesMessage 展开视图用 CodeBlock 渲染树文本，而 CodeBlock 会拉起 monaco
// （jsdom 下 `CSS.escape` 直接报错）。本文件只关心「渲染的是 uiData 还是模型侧原文」，
// 故把 CodeBlock 换成透传容器（vi.mock 会被提升到模块顶部）。
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: (props: any) => props.children,
}))
import GetCurrentTimeMessage from '@/ui/pages/chat/components/tool-call/GetCurrentTimeMessage'
import { getCurrentLanguage } from '@/ui/i18n'
import ListSkillsMessage from '@/ui/pages/chat/components/tool-call/ListSkillsMessage'
import MkdirMessage from '@/ui/pages/chat/components/tool-call/MkdirMessage'
import FileInfoMessage from '@/ui/pages/chat/components/tool-call/FileInfoMessage'
import DeleteFileMessage from '@/ui/pages/chat/components/tool-call/DeleteFileMessage'
import ListFilesMessage from '@/ui/pages/chat/components/tool-call/ListFilesMessage'

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>)
}

function msg(over: Record<string, any>) {
  return {
    id: 'm1',
    role: 'tool',
    content: '',
    timestamp: 0,
    ...over,
  } as any
}

const timeUseContent: any = {
  id: '1',
  name: 'get_current_time',
  input: { timezone: 'UTC' },
}

describe('GetCurrentTimeMessage', () => {
  it('有 uiData.timestamp → 按 UI 语言本地化，不渲染模型侧英文原文', () => {
    const cmp = new GetCurrentTimeMessage()
    const html = render(
      cmp.getExpandView({
        useContent: timeUseContent,
        message: msg({
          content: 'RAW_MODEL_TEXT',
          uiData: { timestamp: 1700000000000, timezone: 'UTC' },
        }),
      }),
    )
    expect(html).not.toContain('RAW_MODEL_TEXT')
    expect(html.length).toBeGreaterThan(0)
  })

  it('无 uiData（旧数据）→ 回落 message.content', () => {
    const cmp = new GetCurrentTimeMessage()
    const html = render(
      cmp.getExpandView({
        useContent: timeUseContent,
        message: msg({ content: 'LEGACY_RAW_TEXT' }),
      }),
    )
    expect(html).toContain('LEGACY_RAW_TEXT')
  })

  it('失败 + uiData.errorKind=invalid_timezone → 按 UI 语言本地化，不直显模型侧英文', () => {
    const cmp = new GetCurrentTimeMessage()
    const html = render(
      cmp.getExpandView({
        useContent: timeUseContent,
        message: msg({
          content: 'Invalid time zone: "Not/AZone"',
          isError: true,
          uiData: { errorKind: 'invalid_timezone', timezone: 'Not/AZone' },
        }),
      }),
    )
    // 时区名是用户数据，两种语言下都原样保留
    expect(html).toContain('Not/AZone')
    const zh = getCurrentLanguage().startsWith('zh')
    expect(html).toContain(zh ? '无效的时区' : 'Invalid time zone')
    // 渲染的是本地化文案（中文界面下不应出现英文原文）
    if (zh) expect(html).not.toContain('Invalid time zone')
  })

  it('失败但无结构化 uiData（旧消息）→ 回落英文原文', () => {
    const cmp = new GetCurrentTimeMessage()
    const html = render(
      cmp.getExpandView({
        useContent: timeUseContent,
        message: msg({ content: 'LEGACY_FAIL', isError: true }),
      }),
    )
    expect(html).toContain('LEGACY_FAIL')
  })
})

describe('ListSkillsMessage', () => {
  const useContent: any = { id: '1', name: 'list_skills', input: {} }

  it('有 uiData.skills → 由结构本地化渲染，不渲染模型侧英文原文', () => {
    const cmp = new ListSkillsMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({
          content: 'Enabled skills (2)',
          uiData: {
            skills: [
              { name: 'alpha', description: 'A skill', version: '1.0.0', tags: ['x'] },
              { name: 'beta' },
            ],
          },
        }),
      }),
    )
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
    expect(html).not.toContain('Enabled skills (2)')
  })

  it('有 uiData.skills 时短文本取结构化数量', () => {
    const cmp = new ListSkillsMessage()
    const text = render(
      cmp.getShortText({
        useContent,
        message: msg({ uiData: { skills: [{ name: 'alpha' }, { name: 'beta' }] } }),
      }),
    )
    expect(text).toContain('2')
  })

  it('无 uiData（旧数据）→ 回落 message.content', () => {
    const cmp = new ListSkillsMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({ content: 'LEGACY_SKILLS_TEXT' }),
      }),
    )
    expect(html).toContain('LEGACY_SKILLS_TEXT')
  })
})

// ==================== file 组（P4b-②） ====================
// 这批工具在 P3 中只改了 Rust 侧文案，中文界面 + 默认（Rust）引擎下
// 展开视图直接渲染英文结果 —— 组件改走 uiData 后闭掉这个回归。

describe('MkdirMessage（file 组）', () => {
  const useContent: any = { id: '1', name: 'mkdir', input: { path: '/a/b' } }

  it('有 uiData → 按结构化结果渲染，不渲染模型侧英文原文', () => {
    const cmp = new MkdirMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({
          content: 'RAW_MODEL_TEXT',
          uiData: { created: ['/a/b'], existed: [], errors: [] },
        }),
      }),
    )
    expect(html).toContain('/a/b')
    expect(html).not.toContain('RAW_MODEL_TEXT')
  })

  it('无 uiData（旧数据）→ 回落 message.content', () => {
    const cmp = new MkdirMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({ content: 'LEGACY_MKDIR_TEXT' }),
      }),
    )
    expect(html).toContain('LEGACY_MKDIR_TEXT')
  })
})

describe('FileInfoMessage（file 组）', () => {
  const useContent: any = { id: '1', name: 'file_info', input: { path: '/a.txt' } }

  it('有 uiData → 本地化标签 + 结构化大小，不渲染模型侧英文原文', () => {
    const cmp = new FileInfoMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({
          content: 'RAW_MODEL_TEXT',
          uiData: {
            path: '/a.txt',
            isDirectory: false,
            sizeBytes: 1536,
            atimeMs: 1_700_000_000_000,
            mtimeMs: 1_700_000_000_000,
          },
        }),
      }),
    )
    expect(html).toContain('/a.txt')
    expect(html).toContain('1.5 KB')
    expect(html).not.toContain('RAW_MODEL_TEXT')
  })

  it('无 uiData（旧数据）→ 回落 message.content', () => {
    const cmp = new FileInfoMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({ content: 'LEGACY_FILE_INFO_TEXT' }),
      }),
    )
    expect(html).toContain('LEGACY_FILE_INFO_TEXT')
  })
})

describe('DeleteFileMessage（file 组）', () => {
  const useContent: any = {
    id: '1',
    name: 'delete_file',
    input: { paths: ['/a', '/b'] },
  }

  it('有 uiData.deleted → 结构化清单渲染，不渲染模型侧英文原文', () => {
    const cmp = new DeleteFileMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({
          content: 'RAW_MODEL_TEXT',
          uiData: { deleted: ['/a', '/b'], errors: [] },
        }),
        expand: true,
      }),
    )
    expect(html).toContain('/a')
    expect(html).toContain('/b')
    expect(html).not.toContain('RAW_MODEL_TEXT')
  })
})

describe('ListFilesMessage（file 组）', () => {
  const useContent: any = { id: '1', name: 'list_files', input: { path: '/r' } }

  it('有 uiData.nodes → 由语言无关目录树渲染，不渲染模型侧英文原文', () => {
    const cmp = new ListFilesMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({
          content: 'RAW_MODEL_TREE',
          uiData: {
            rootPath: '/r',
            nodes: [{ name: 'a.ts', isDir: false, size: 2048 }],
            totalItems: 1,
            maxItems: 600,
            truncated: false,
          },
        }),
      }),
    )
    expect(html).toContain('/r')
    expect(html).toContain('a.ts')
    expect(html).not.toContain('RAW_MODEL_TREE')
  })

  it('无 uiData（旧数据）→ 回落 message.content', () => {
    const cmp = new ListFilesMessage()
    const html = render(
      cmp.getExpandView({
        useContent,
        message: msg({ content: 'LEGACY_TREE_TEXT' }),
      }),
    )
    expect(html).toContain('LEGACY_TREE_TEXT')
  })
})
