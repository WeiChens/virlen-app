/**
 * WebSearchMessage — 网络搜索结果在消息流里的展开列表
 *
 * 三条口径：
 *   ① 展开态一条结果一行（标题 / 摘要 / 地址），整条可点，标题不再是独立的 `<a>`；
 *   ② 点整条 → **右侧栏网页标签**（与正文里的链接同一个出口 `browser-open-service`），
 *      地址先过 `sidePanelUrlOf`（只放行绝对的 http(s)，并规范化成地址栏那一种写法）；
 *   ③ 没有宿主（不在聊天页 / 用例里没注入）→ 退回系统浏览器；非 http(s) 的结果谁都不开
 *      （面板视图在本应用的源里跑，搜索结果里混进来的 `javascript:` / `file:` 一律不吃）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import WebSearchMessage from '@/ui/pages/chat/components/tool-call/WebSearchMessage'
import { setSidePanelBrowserHandler } from '@/services/browser-open-service'
import type { Message, ToolUseContent } from '@/types'

const { openUrlMock } = vi.hoisted(() => ({
  openUrlMock: vi.fn(() => Promise.resolve()),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ITEMS = [
  { title: 'Tokio 教程', url: 'https://docs.rs/tokio', snippet: '异步运行时', icon: '' },
  { title: '示例站', url: 'https://Example.COM/a/b?q=1', snippet: '第二个结果' },
]

const inst = new WebSearchMessage()

function toolUse(query = 'rust 异步') {
  return {
    type: 'tool_use',
    id: 'tc1',
    name: 'web_search',
    input: { query },
  } as ToolUseContent
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

/** 挂上展开视图，返回行元素与卸载函数 */
function expand(uiData?: Record<string, any>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(
      inst.getExpandView({
        useContent: toolUse(),
        message: resultMessage(uiData),
      }) as any,
    )
  })
  return {
    host,
    rows: () => Array.from(host.querySelectorAll<HTMLElement>('.web-search-item')),
    done: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function press(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('WebSearchMessage', () => {
  beforeEach(() => {
    openUrlMock.mockClear()
    setSidePanelBrowserHandler(null)
  })

  it('工具名与标签（标签走 i18n）', () => {
    expect(inst.getToolName()).toBe('web_search')
    expect(inst.getToolLabel()).toBe('网络搜索')
  })

  it('折叠态：关键词 + 结果数', () => {
    const html = renderToStaticMarkup(
      inst.getShortText({
        useContent: toolUse(),
        message: resultMessage({ length: 2, items: ITEMS }),
      }) as any,
    )
    expect(html).toContain('rust 异步')
    expect(html).toContain('2项结果')
  })

  it('展开态：一条结果一行（标题 / 摘要 / 地址都铺出来，行上带完整地址的 tooltip）', () => {
    const view = expand({ length: 2, items: ITEMS })
    const rows = view.rows()
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.web-search-item-title')?.textContent).toBe('Tokio 教程')
    expect(rows[0].querySelector('.web-search-item-snippet')?.textContent).toBe('异步运行时')
    expect(rows[0].querySelector('.web-search-item-url')?.textContent).toBe(
      'https://docs.rs/tokio',
    )
    expect(rows[0].getAttribute('title')).toBe('https://docs.rs/tokio')
    // 行上展示的是原样地址；规范化只发生在“点开”那一刻
    expect(rows[1].querySelector('.web-search-item-url')?.textContent).toBe(
      'https://Example.COM/a/b?q=1',
    )
    // 标题不再是独立链接：整条才是那一个点击目标（否则会叠成两次打开）
    expect(view.host.querySelector('.web-search-item-title')?.tagName).toBe('SPAN')
    view.done()
  })

  it('点整条 → 右侧栏网页标签，地址先规范化（主机小写）', () => {
    const opened: string[] = []
    const dispose = setSidePanelBrowserHandler((url) => opened.push(url))
    const view = expand({ length: 2, items: ITEMS })

    click(view.rows()[0])
    click(view.rows()[1])

    expect(opened).toEqual(['https://docs.rs/tokio', 'https://example.com/a/b?q=1'])
    // 有宿主时不该再拉起系统浏览器
    expect(openUrlMock).not.toHaveBeenCalled()

    dispose()
    view.done()
  })

  it('键盘也能开（Enter / 空格，与行上的 role="button" 对齐）', () => {
    const opened: string[] = []
    const dispose = setSidePanelBrowserHandler((url) => opened.push(url))
    const view = expand({ length: 2, items: ITEMS })

    press(view.rows()[0], 'Enter')
    press(view.rows()[1], ' ')
    // 其它键不动
    press(view.rows()[0], 'a')

    expect(opened).toEqual(['https://docs.rs/tokio', 'https://example.com/a/b?q=1'])

    dispose()
    view.done()
  })

  it('没有右侧面板宿主 → 退回系统浏览器（别让点击变成什么都没发生）', () => {
    const view = expand({ length: 2, items: ITEMS })
    click(view.rows()[0])
    expect(openUrlMock).toHaveBeenCalledWith('https://docs.rs/tokio')
    view.done()
  })

  it('非 http(s) 的结果谁都不开（面板视图在本应用的源里跑）', () => {
    const opened: string[] = []
    const dispose = setSidePanelBrowserHandler((url) => opened.push(url))
    const view = expand({
      length: 2,
      items: [
        { title: '伪协议', url: 'javascript:alert(1)', snippet: '' },
        { title: '本地文件', url: 'file:///C:/secret.txt', snippet: '' },
      ],
    })

    for (const row of view.rows()) click(row)

    expect(opened).toEqual([])
    expect(openUrlMock).not.toHaveBeenCalled()

    dispose()
    view.done()
  })

  it('没有 uiData 时不动结构化列表（走原文本兜底，不给空行）', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        inst.getExpandView({
          useContent: toolUse(),
          message: resultMessage(undefined, { content: '[1] 无结构化结果' }),
        }) as any,
      )
    })
    expect(host.querySelectorAll('.web-search-item')).toHaveLength(0)
    expect(host.querySelector('.web-search-raw')?.textContent).toContain('无结构化结果')
    act(() => root.unmount())
    host.remove()
  })
})
