/**
 * 用户气泡超长正文折叠 —— 自然高度 > 70vh 时先只给 40vh，点「显示更多」全部展开、再点「收起」折回去。
 *
 * jsdom 没有真实排版（`scrollHeight` 恒 0、`scrollIntoView` 未实现），所以这里替身掉 `scrollHeight`，
 * 把「正文自然高度」当输入喂进去，专测**判据与开关**（40vh / 70vh 两个数各只有一处，见最后一个用例）：
 *  · ≤ 70vh 不折叠 —— 不该凭空多出一个按钮；
 *  · > 70vh 折叠 + 按钮，点开后 class / 箭头 / 文案一起翻面，再点又折回去（正文一直在，折叠只改展示）；
 *  · 每次翻面都要先「按住滚动偏移」（否则列表的跟底补偿会把阅读位置甩到消息末尾），
 *    收起方向是「先自行拉回视野、再重新按住」；
 *  · 助手气泡不折叠 —— 长回答是要连着读的；
 *  · 视口变化要复量 —— 阈值本身就是 0.7 × 视口高。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))
vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { warn: vi.fn(async () => false) },
  useMessageBox: () => ({ MessageBox: { warn: vi.fn(async () => false) } }),
}))
/** Monaco 在 jsdom 里跑不起来（缺 CSS.escape / canvas）——气泡会经 ToolCallMessage 间接拉到它 */
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): any[] => [] } },
  virlenDarkTheme: {},
}))
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  default: ({ children }: any) => <pre className="code-block-body">{children}</pre>,
}))

import MessageBubble from '@/ui/pages/chat/components/message/message-bubble'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 视口高度（jsdom 默认 768，这里钉死成 800 好算：阈值 = 560） */
const VIEWPORT_HEIGHT = 800
/** 正文「自然高度」，由各用例写入 */
let contentHeight = 0

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  return { host, root }
}

const userMessage = (content: string) =>
  ({ id: 'u1', role: 'user', content, timestamp: 0 }) as any
const assistantMessage = (content: string) =>
  ({ id: 'a1', role: 'assistant', content, timestamp: 0 }) as any

const originalScrollHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight',
)

/** 收起时会把气泡拉回视野 —— jsdom 未实现 `scrollIntoView`，这里补一个可断言的替身 */
const scrollIntoView = vi.fn()

beforeEach(() => {
  contentHeight = 0
  scrollIntoView.mockClear()
  ;(Element.prototype as any).scrollIntoView = scrollIntoView
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: VIEWPORT_HEIGHT,
  })
  // 只有正文那层有「内容高度」，其余元素保持 jsdom 的 0
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('message-content') ? contentHeight : 0
    },
  })
})

afterEach(() => {
  delete (Element.prototype as any).scrollIntoView
  if (originalScrollHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollHeight',
      originalScrollHeight,
    )
  }
})

describe('用户气泡超长正文折叠', () => {
  it('自然高度恰好 70vh：不折叠（判据是「大于」，不是「达到」）', async () => {
    contentHeight = VIEWPORT_HEIGHT * 0.7
    const { host, root } = await render(<MessageBubble message={userMessage('短文本')} />)

    expect(host.querySelector('.message-content')).not.toBeNull()
    expect(host.querySelector('.message-content.is-collapsed')).toBeNull()
    expect(host.querySelector('.message-content-more')).toBeNull()

    await act(async () => root.unmount())
  })

  it('自然高度 > 70vh：折叠 + 「显示更多」，点开后全部展开、再点收起', async () => {
    contentHeight = 4000
    const holdScrollOffset = vi.fn()
    const { host, root } = await render(
      <MessageBubble
        message={userMessage('很长的一段正文')}
        onHoldScrollOffset={holdScrollOffset}
      />,
    )

    const content = () => host.querySelector('.message-content')!
    const more = () => host.querySelector<HTMLButtonElement>('.message-content-more')!
    expect(content().classList.contains('is-collapsed')).toBe(true)
    expect(more().textContent).toContain('显示更多')
    expect(more().classList.contains('is-expanded')).toBe(false)
    // 首次判定出折叠不许动列表（用户可能正在别处阅读）
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(holdScrollOffset).not.toHaveBeenCalled()

    await act(async () => {
      more().click()
    })
    // 展开：不再折叠，按钮翻成「收起」（同一个下箭头在样式里转 180°）
    expect(content().classList.contains('is-collapsed')).toBe(false)
    expect(more().textContent).toContain('收起')
    expect(more().classList.contains('is-expanded')).toBe(true)
    expect(scrollIntoView).not.toHaveBeenCalled()
    // 展开只按住偏移（把阅读位置原样留住），不自己滚
    expect(holdScrollOffset).toHaveBeenCalledTimes(1)

    await act(async () => {
      more().click()
    })
    // 收起：折回去，开关仍留着（否则展开后就再也回不到折叠态）
    expect(content().classList.contains('is-collapsed')).toBe(true)
    expect(more().textContent).toContain('显示更多')
    expect(content().textContent).toContain('很长的一段正文')
    // 收起这一拍：点击先按住偏移 → 拉回视野 → 再重新按住（顺序很重要，反了就把刚拉回来的气泡又推走）
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(holdScrollOffset).toHaveBeenCalledTimes(3)
    expect(holdScrollOffset.mock.invocationCallOrder[2]).toBeGreaterThan(
      scrollIntoView.mock.invocationCallOrder[0],
    )

    await act(async () => root.unmount())
  })

  it('助手气泡不折叠（长回答要连着读）', async () => {
    contentHeight = 4000
    const { host, root } = await render(
      <MessageBubble message={assistantMessage('很长的回答')} />,
    )

    expect(host.querySelector('.message-content.is-collapsed')).toBeNull()
    expect(host.querySelector('.message-content-more')).toBeNull()

    await act(async () => root.unmount())
  })

  it('视口变高后复量：同一个高度不再折叠（阈值随视口走）', async () => {
    contentHeight = 600 // 800 高时阈值 560 → 折
    const { host, root } = await render(<MessageBubble message={userMessage('中等长度')} />)
    expect(
      host.querySelector('.message-content')!.classList.contains('is-collapsed'),
    ).toBe(true)

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 1000, // 阈值 700 > 600 → 不再折
    })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(
      host.querySelector('.message-content')!.classList.contains('is-collapsed'),
    ).toBe(false)

    await act(async () => root.unmount())
  })

  it('40vh / 70vh 两个数各只有一处（样式与判据都不许漂）', () => {
    const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8')
    expect(
      read('src/ui/pages/chat/components/message/message-bubble.scss'),
    ).toMatch(/&\.is-collapsed\s*\{[^}]*max-height:\s*40vh/)
    expect(
      read('src/ui/pages/chat/components/message/message-bubble.tsx'),
    ).toMatch(/COLLAPSE_TRIGGER_RATIO = 0\.7/)
    // 开关文案成对出现，别只留一个「显示更多」
    expect(read('src/ui/pages/chat/components/message/message-bubble.tsx')).toContain(
      "t('收起')",
    )
  })
})
