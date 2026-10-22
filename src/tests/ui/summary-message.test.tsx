/**
 * 上下文压缩产物在消息列表里的呈现。
 *
 * 钉住的契约：
 * - 列表态**只**渲染提示条，摘要正文一律不进消息流（正文压缩产物可达数万字符，
 *   铺开会让虚拟列表的测量与 Markdown 渲染成本飙升）；
 * - 点提示条 → **右侧抽屉**（portal 到 body）打开，正文只在抽屉里出现一次；
 * - 只有正文压缩（compressMode='raw'）才展示「压缩后约 N tokens」——
 *   AI 摘要的 usage 是那次调用的消耗，不是压缩后的上下文大小，展示会误导。
 *
 * 抽屉自身的关闭口径（Esc / 遮罩 / ×）在 `summary-drawer.test.tsx` 里。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import SummaryMessage from '@/ui/pages/chat/components/message/summary-message'
import { summaryMetaText } from '@/ui/pages/chat/components/message/summary-meta'
import type { Message } from '@/types'

/** 真实 MarkdownRenderer 静态引 monaco（jsdom 加载不了）：换成直出文本的替身 */
vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => (
    <div className="mock-markdown">{content}</div>
  ),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const SUMMARY_BODY = 'SUMMARY_BODY_ONLY_IN_DRAWER'

function makeSummary(overrides: Partial<Message> = {}): Message {
  return {
    id: 'summary-1',
    role: 'summary',
    content: SUMMARY_BODY,
    timestamp: 1700000000000,
    ...overrides,
  }
}

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function mount(element: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(element))
}

const card = () => document.querySelector<HTMLButtonElement>('.compress-summary-card')
const drawer = () => document.querySelector<HTMLElement>('.summary-drawer')

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

it('列表态只渲染提示条，不铺开摘要正文', () => {
  const html = renderToStaticMarkup(<SummaryMessage message={makeSummary()} />)
  expect(html).toContain('compress-summary-card')
  expect(html).toContain('上下文已压缩')
  expect(html).not.toContain(SUMMARY_BODY)
})

it('点提示条 → 右侧抽屉打开，正文只出现在抽屉里', () => {
  mount(<SummaryMessage message={makeSummary()} />)
  expect(drawer()).toBeNull()

  act(() => card()!.click())

  expect(drawer()).not.toBeNull()
  expect(drawer()!.getAttribute('role')).toBe('dialog')
  expect(drawer()!.textContent).toContain(SUMMARY_BODY)
  // 提示条自己仍然不带正文（正文只有一个渲染点）
  expect(card()!.textContent).not.toContain(SUMMARY_BODY)
})

it('抽屉 portal 到 body：不在消息行里面（虚拟列表卸行也不影响）', () => {
  mount(<SummaryMessage message={makeSummary()} />)
  act(() => card()!.click())

  const panel = drawer()!
  expect(panel.closest('.message-compress-summary')).toBeNull()
  // body > .summary-drawer-overlay > .summary-drawer
  expect(panel.parentElement?.parentElement).toBe(document.body)
})

it('关掉抽屉后正文彻底从 DOM 消失（不常驻、不缓存）', () => {
  mount(<SummaryMessage message={makeSummary()} />)
  act(() => card()!.click())
  expect(document.body.textContent).toContain(SUMMARY_BODY)

  act(() => {
    document.querySelector<HTMLButtonElement>('.summary-drawer-close')!.click()
  })

  expect(drawer()).toBeNull()
  expect(document.body.textContent).not.toContain(SUMMARY_BODY)
})

it('正文压缩展示压缩后估算占用与压缩方式', () => {
  const meta = summaryMetaText(
    makeSummary({ uiData: { compressMode: 'raw', contextTokens: 12500 } }),
  )
  expect(meta).toContain('正文压缩')
  expect(meta).toContain('12.5k')
})

it('AI 摘要不展示上下文占用（那是调用消耗，不是压缩后大小）', () => {
  const meta = summaryMetaText(
    makeSummary({
      uiData: { compressMode: 'ai' },
      usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 },
    }),
  )
  expect(meta).toContain('AI 摘要')
  expect(meta).not.toContain('tokens')
})

it('没有压缩方式的老数据：副标题只剩时间，不出现空壳分隔符', () => {
  const meta = summaryMetaText(makeSummary())
  expect(meta.startsWith(' · ')).toBe(false)
  expect(meta.trim().length).toBeGreaterThan(0)
})
