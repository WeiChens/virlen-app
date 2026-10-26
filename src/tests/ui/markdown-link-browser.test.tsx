/**
 * Markdown 正文里的链接 → 右侧栏网页标签。
 *
 * 三组断言：
 * ① **改道口径**：只有绝对的 http(s) 链接被接管，`#锚点` / 相对路径 / `mailto:` / `file:` 一律原样；
 *    地址要先规范化（同一个页面不能开出两个标签身份）；
 * ② **点击口径**：修饰键与非左键不接管（那是用户在说「我不在这儿开」）；
 * ③ **没人接就不拦**：宿主没登记时**不能** `preventDefault`，否则点了等于没反应 ——
 *    这条最容易在重构时丢掉（比如为了「一定有反应」而无条件 preventDefault）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownRenderer from '@/ui/pages/chat/components/message/markdown-renderer'
import {
  handleMarkdownLinkClick,
  sidePanelUrlOf,
} from '@/ui/pages/chat/components/message/markdown-link'
import { setSidePanelBrowserHandler } from '@/services/browser-open-service'

// MarkdownRenderer 的正文会拉起 code-block → CodePreview（monaco 在 jsdom / happy-dom 里起不来）
vi.mock('@/ui/components/code-preview/CodePreview', () => ({
  default: ({ code }: any) => <pre className="mock-code-preview">{code}</pre>,
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('链接改道口径：只认绝对的 http(s)', () => {
  it('http(s) 链接原样规范化后接管', () => {
    expect(sidePanelUrlOf('https://docs.rs/tokio')).toBe('https://docs.rs/tokio')
    expect(sidePanelUrlOf('http://localhost:5173/a?b=1')).toBe('http://localhost:5173/a?b=1')
    // 前后空白来自 Markdown 解析器的宽容，喂给地址栏前要清掉
    expect(sidePanelUrlOf('  https://a.com/x  ')).toBe('https://a.com/x')
  })

  it('不是网页标签能吃的东西就不接管', () => {
    // 锚点是文档内的跳转
    expect(sidePanelUrlOf('#section-1')).toBe('')
    // 相对路径：面板的「无协议补 https」规则会把它当成主机名，开出一个空白外网标签
    expect(sidePanelUrlOf('./src/a.ts')).toBe('')
    expect(sidePanelUrlOf('images/a.png')).toBe('')
    // 其它协议：地址校验只放行 http(s)
    expect(sidePanelUrlOf('mailto:me@example.com')).toBe('')
    expect(sidePanelUrlOf('file:///C:/a.ts')).toBe('')
    expect(sidePanelUrlOf('javascript:alert(1)')).toBe('')
    // 协议相对地址没有自己的身份，不当网页标签用
    expect(sidePanelUrlOf('//example.com/a')).toBe('')
    // 空值
    expect(sidePanelUrlOf('')).toBe('')
    expect(sidePanelUrlOf(undefined)).toBe('')
    expect(sidePanelUrlOf(null)).toBe('')
  })

  it('带凭据的地址不接管（与地址栏同一条红线）', () => {
    expect(sidePanelUrlOf('https://user:pass@a.com/')).toBe('')
  })
})

describe('点击口径：修饰键 / 非左键不接管', () => {
  let opens: string[]

  beforeEach(() => {
    opens = []
    setSidePanelBrowserHandler((url) => opens.push(url))
  })
  afterEach(() => {
    setSidePanelBrowserHandler(null)
  })

  it('普通左键点击 → 交给宿主，地址已规范化', () => {
    expect(handleMarkdownLinkClick({ button: 0 }, 'https://docs.rs/tokio')).toBe(true)
    // 规范化：`https://docs.rs` 与 `https://docs.rs/` 是同一个页面
    expect(handleMarkdownLinkClick({ button: 0 }, 'https://docs.rs')).toBe(true)
    expect(opens).toEqual(['https://docs.rs/tokio', 'https://docs.rs/'])
  })

  it('按了修饰键就不接管（Ctrl / Cmd / Shift / Alt 都不拦）', () => {
    for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
      expect(handleMarkdownLinkClick({ button: 0, [key]: true }, 'https://a.com/')).toBe(false)
    }
    expect(opens).toEqual([])
  })

  it('中键 / 右键不接管', () => {
    expect(handleMarkdownLinkClick({ button: 1 }, 'https://a.com/')).toBe(false)
    expect(handleMarkdownLinkClick({ button: 2 }, 'https://a.com/')).toBe(false)
    expect(opens).toEqual([])
  })

  it('不是 http(s) 的链接点击不接管', () => {
    expect(handleMarkdownLinkClick({ button: 0 }, '#anchor')).toBe(false)
    expect(opens).toEqual([])
  })
})

describe('没有人接（宿主编译期外的环境 / 不在聊天页）', () => {
  afterEach(() => {
    setSidePanelBrowserHandler(null)
  })

  it('返回 false，且不抛错', () => {
    setSidePanelBrowserHandler(null)
    expect(handleMarkdownLinkClick({ button: 0 }, 'https://a.com/')).toBe(false)
  })

  it('注销后不再接：晚到的 handler 不能顶掉新的', () => {
    const first: string[] = []
    const second: string[] = []
    const offFirst = setSidePanelBrowserHandler((url) => first.push(url))
    setSidePanelBrowserHandler((url) => second.push(url))
    // 旧实例卸载时的注销不能把新实例的入口清掉
    offFirst()
    expect(handleMarkdownLinkClick({ button: 0 }, 'https://a.com/')).toBe(true)
    expect(first).toEqual([])
    expect(second).toEqual(['https://a.com/'])
  })
})

describe('渲染出来真的接上了（不是只有纯函数能用）', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let opens: string[]

  beforeEach(() => {
    opens = []
    setSidePanelBrowserHandler((url) => opens.push(url))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setSidePanelBrowserHandler(null)
  })

  /** 挂一段 Markdown，返回正文里的第一个链接 */
  function renderLink(markdown: string): HTMLAnchorElement {
    act(() => root.render(<MarkdownRenderer content={markdown} />))
    const link = container.querySelector('.md-link') as HTMLAnchorElement
    expect(link).toBeTruthy()
    return link
  }

  it('点 http(s) 链接 → 右侧栏接管且吃掉默认跳转', () => {
    const link = renderLink('文档见 [Tokio](https://docs.rs/tokio)。')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    act(() => {
      link.dispatchEvent(ev)
    })
    expect(opens).toEqual(['https://docs.rs/tokio'])
    // 没吃掉默认行为的话，webview 会把整个应用导航走（或弹一个新窗口）
    expect(ev.defaultPrevented).toBe(true)
    // 原属性保持不变：真被放行时仍然是「新窗口 + 不带 referrer」
    expect(link.getAttribute('href')).toBe('https://docs.rs/tokio')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('Ctrl + 点击不接管，也不吃掉默认行为', () => {
    const link = renderLink('[Tokio](https://docs.rs/tokio)')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    act(() => {
      link.dispatchEvent(ev)
    })
    expect(opens).toEqual([])
    expect(ev.defaultPrevented).toBe(false)
  })

  it('本地路径 / 锚点照旧不接管（真被放行时仍然是原 attr）', () => {
    renderLink('[配置](./vite.config.ts) 与 [跳转](#top)')
    const links = Array.from(container.querySelectorAll('.md-link')) as HTMLAnchorElement[]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['./vite.config.ts', '#top'])
    // 不在这里真点：happy-dom 会把 href 当 URL 去请求（噪声，不是被测行为）。
    // 拦截口径本身由上面的 `sidePanelUrlOf` / `handleMarkdownLinkClick` 两组守。
    expect(sidePanelUrlOf('./vite.config.ts')).toBe('')
    expect(sidePanelUrlOf('#top')).toBe('')
  })
})
