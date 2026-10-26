/**
 * PresentMessage — 交付物（`present`）在消息流里的一行
 *
 * 四条口径：
 *   ① 折叠态只说「哪个交付物（+ 还有几个）」，路径靠 title / 展开态；有文件时文件优先，
 *      只有网址时用主机；
 *   ② 展开态是交付条（文件 = `FileChip`：图标 / 文件名 / 体积；网址 = 主机 + 地址），一项一条；
 *   ③ 点条子 → 走 `present-service` / `browser-open-service` 的同一个出口（右侧面板再打开一次）；
 *   ④ 工具还没跑完（没有 uiData）时退化为入参（带 `://` 的当网址），不显示空行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import PresentMessage from '@/ui/pages/chat/components/tool-call/PresentMessage'
import { setPresentRevealHandler } from '@/services/present-service'
import { setSidePanelBrowserHandler } from '@/services/browser-open-service'
import type { Message, ToolUseContent } from '@/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const FILES = [
  { path: 'E:/out/季度报告.xlsx', name: '季度报告.xlsx', sizeBytes: 2048 },
  { path: 'E:/out/发布会.pptx', name: '发布会.pptx', sizeBytes: 1048576 },
]

const inst = new PresentMessage()

function toolUse(input: Record<string, any> = { paths: FILES.map((f) => f.path) }) {
  return { type: 'tool_use', id: 'tc1', name: 'present', input } as ToolUseContent
}

function resultMessage(uiData?: Record<string, any>, over: Record<string, any> = {}) {
  return {
    id: 'r1',
    role: 'tool',
    content: 'RAW_MODEL_TEXT',
    toolCallId: 'tc1',
    uiData,
    timestamp: 0,
    ...over,
  } as Message
}

describe('PresentMessage', () => {
  it('工具名与标签（标签走 i18n）', () => {
    expect(inst.getToolName()).toBe('present')
    expect(inst.getToolLabel()).toBe('交付文件')
  })

  it('折叠态：第一个文件名 + 剩余个数', () => {
    const html = renderToStaticMarkup(
      inst.getShortText({
        useContent: toolUse(),
        message: resultMessage({ type: 'present', files: FILES, skipped: [] }),
      }) as any,
    )
    expect(html).toContain('季度报告.xlsx')
    expect(html).toContain('+1')
  })

  it('工具还没跑完（没有 uiData）→ 用入参路径兜底', () => {
    const html = renderToStaticMarkup(
      inst.getShortText({ useContent: toolUse({ path: 'E:/out/a.docx' }) }) as any,
    )
    expect(html).toContain('a.docx')
    expect(html).not.toContain('+')
  })

  it('折叠时不挂载展开视图；展开时每个交付物一条文件条', () => {
    const ui = { type: 'present', files: FILES, skipped: [] as any[] }
    expect(
      inst.getExpandView({ useContent: toolUse(), message: resultMessage(ui), expand: false }),
    ).toBeNull()

    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => {
      root.render(
        inst.getExpandView({
          useContent: toolUse(),
          message: resultMessage(ui),
          expand: true,
        }) as any,
      )
    })

    const chips = host.querySelectorAll('.present-files .file-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].getAttribute('title')).toBe(FILES[0].path)
    expect(host.textContent).toContain('季度报告')
    expect(host.textContent).toContain('发布会')

    act(() => root.unmount())
  })

  it('被跳过的路径单独列出（原因照抄工具原文，便于排查）', () => {
    const ui = {
      type: 'present',
      files: [FILES[0]],
      skipped: [{ path: 'E:/out/missing.pdf', reason: 'file does not exist' }],
    }
    const html = renderToStaticMarkup(
      inst.getExpandView({
        useContent: toolUse(),
        message: resultMessage(ui),
        expand: true,
      }) as any,
    )
    expect(html).toContain('E:/out/missing.pdf')
    expect(html).toContain('file does not exist')
  })

  it('失败结果按原文显示错误', () => {
    const html = renderToStaticMarkup(
      inst.getExpandView({
        useContent: toolUse(),
        message: resultMessage(undefined, {
          isError: true,
          content: 'Error: no file was presented',
        }),
        expand: true,
      }) as any,
    )
    expect(html).toContain('no file was presented')
  })

  describe('点文件条 → 右侧面板再打开一次', () => {
    let host: HTMLDivElement
    let root: ReturnType<typeof createRoot>
    let seen: { paths: string[]; urls: string[] }[]

    beforeEach(() => {
      seen = []
      setPresentRevealHandler((payload) => seen.push(payload))
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      act(() => {
        root.render(
          inst.getExpandView({
            useContent: toolUse(),
            message: resultMessage({ type: 'present', files: FILES, skipped: [] }),
            expand: true,
          }) as any,
        )
      })
    })

    afterEach(() => {
      setPresentRevealHandler(null)
      act(() => root.unmount())
      host.remove()
    })

    it('点第二个文件条 → 只打开那一个（绝对路径，来自 uiData）', () => {
      const buttons = host.querySelectorAll<HTMLButtonElement>('.file-chip-body')
      expect(buttons).toHaveLength(2)
      act(() => {
        buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(seen).toEqual([{ paths: [FILES[1].path], urls: [] }])
    })
  })

  describe('交付网址', () => {
    const LINKS = [
      { url: 'https://docs.rs/tokio', name: 'docs.rs' },
      { url: 'https://example.com/a/b', name: 'example.com' },
    ]

    it('展开态把网址按主机 + 地址列出来（完整地址放 title）', () => {
      const host = document.createElement('div')
      const root = createRoot(host)
      act(() => {
        root.render(
          inst.getExpandView({
            useContent: toolUse(),
            message: resultMessage({ type: 'present', files: [], links: LINKS, skipped: [] }),
            expand: true,
          }) as any,
        )
      })

      const rows = host.querySelectorAll<HTMLButtonElement>('.present-link')
      expect(rows).toHaveLength(2)
      expect(rows[0].getAttribute('title')).toBe(LINKS[0].url)
      expect(rows[0].querySelector('.present-link-host')?.textContent).toBe('docs.rs')
      expect(rows[1].textContent).toContain('example.com/a/b')

      act(() => root.unmount())
    })

    it('只有网址时折叠态显示主机（不当成「交付文件」四个字）', () => {
      const html = renderToStaticMarkup(
        inst.getShortText({
          useContent: toolUse(),
          message: resultMessage({ type: 'present', files: [], links: LINKS, skipped: [] }),
        }) as any,
      )
      expect(html).toContain('docs.rs')
      expect(html).toContain('+1')
    })

    it('点网址条 → 右侧栏网页标签（与正文里的链接同一个出口）', () => {
      const opened: string[] = []
      const dispose = setSidePanelBrowserHandler((url) => opened.push(url))
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      act(() => {
        root.render(
          inst.getExpandView({
            useContent: toolUse(),
            message: resultMessage({ type: 'present', files: [], links: LINKS, skipped: [] }),
            expand: true,
          }) as any,
        )
      })

      const rows = host.querySelectorAll<HTMLButtonElement>('.present-link')
      act(() => {
        rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(opened).toEqual([LINKS[1].url])

      dispose()
      act(() => root.unmount())
      host.remove()
    })
  })
})
