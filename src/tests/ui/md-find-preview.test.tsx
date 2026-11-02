/**
 * 预览里的查找（Ctrl/Cmd+F）：VirtualMarkdown + 查找浮层的联动用例。
 *
 * 守四件事：
 * 1. **开关条件**：焦点在预览里（或面板内）才接管 Ctrl+F；焦点在别的输入控件、或在面板外，
 *    一律不插手（不 preventDefault，原生查找照旧）；
 * 2. **计数**：查询变化即重算，`1/2` → `2/2` 循环，无命中显示「无结果」，区分大小写可切换；
 * 3. **键盘**：Enter 下一个、Shift+Enter 上一个、Escape 关闭（并清掉查询，高亮跟着消失）；
 * 4. **不挡别的链路**：关掉浮层后 Ctrl+F 又回到「不接管」。
 *
 * markdown 渲染器换成直出文本的替身（真实渲染器静态引 Monaco，happy-dom 起不来）；
 * CSS Custom Highlight 在 happy-dom 里没有，高亮由 md-find.test.ts 用替身单独覆盖。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import VirtualMarkdown from '@/ui/pages/chat/components/workspace-file/virtual-markdown'

vi.mock('@/ui/pages/chat/components/message/markdown-renderer', () => ({
  // 直出文本（真实渲染器静态引 Monaco，happy-dom 起不来）。用 innerHTML 是为了让用例里的
  // `<details>` 能真的成为元素（查找命中在收起的折叠块里时要能被展开）。
  default: ({ content }: { content: string }) => (
    <div className="mock-markdown" dangerouslySetInnerHTML={{ __html: content }} />
  ),
}))

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

/** 短文档（< MIN_VIRTUALIZE_CHARS）走整篇渲染那条路：DOM 确定，不依赖虚拟层的测量 */
const CONTENT = ['# 标题', '', '改法 1：借用', '', '改法 2：克隆', '', '结尾'].join('\n')

async function mount(content = CONTENT) {
  const host = document.createElement('div')
  host.className = 'workspace-file-panel'
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<VirtualMarkdown content={content} />))
  await act(async () => {})
}

const preview = () => document.querySelector<HTMLElement>('.wfp-preview')
const widget = () => document.querySelector<HTMLElement>('.wfp-find')
const input = () => document.querySelector<HTMLInputElement>('.wfp-find-input')
const count = () => document.querySelector('.wfp-find-count')?.textContent

/** 按 Ctrl+F（target 默认是 window：监听就挂在 window 的捕获阶段） */
function pressFind(target: EventTarget = window, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

/** 往查找框里输内容（走原生 setter，React 才认这次 input） */
async function type(value: string) {
  const el = input()!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  await act(async () => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressKey(key: string, shiftKey = false) {
  const el = input()!
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
  })
}

/** 把「用户选中了 text」模拟出来（happy-dom 不做真实选区） */
function stubSelection(text: string, container: Node): void {
  const fake = {
    isCollapsed: text === '',
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: container }),
    toString: () => text,
  }
  vi.spyOn(window, 'getSelection').mockReturnValue(fake as unknown as Selection)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

it('焦点在预览里时 Ctrl+F 打开浮层，并自动聚焦输入框', async () => {
  await mount()
  preview()!.focus()

  const event = pressFind()
  await act(async () => {})

  expect(event.defaultPrevented).toBe(true)
  expect(widget()).not.toBeNull()
  expect(document.activeElement).toBe(input())
})

it('焦点在面板外（正文没人点过）时不接管，原生查找照旧', async () => {
  await mount()
  // 焦点还在 body，鼠标也不在预览上
  const event = pressFind()
  await act(async () => {})

  expect(event.defaultPrevented).toBe(false)
  expect(widget()).toBeNull()
})

it('焦点在别的输入框里时不接管（那边有自己的查找）', async () => {
  await mount()
  const other = document.createElement('input')
  document.body.appendChild(other)
  other.focus()

  const event = pressFind()
  await act(async () => {})

  expect(event.defaultPrevented).toBe(false)
  expect(widget()).toBeNull()
})

it('查询 → 计数 → Enter / Shift+Enter 循环', async () => {
  await mount()
  preview()!.focus()
  pressFind()
  await act(async () => {})

  await type('改法')
  expect(count()).toBe('1/2')

  await pressKey('Enter')
  expect(count()).toBe('2/2')

  // 到底再往下走回到第一处（循环，不卡在末尾）
  await pressKey('Enter')
  expect(count()).toBe('1/2')

  await pressKey('Enter', true)
  expect(count()).toBe('2/2')
})

it('没有命中时显示「无结果」', async () => {
  await mount()
  preview()!.focus()
  pressFind()
  await act(async () => {})

  await type('根本不存在的词')

  expect(count()).toBe('无结果')
})

it('区分大小写开关改变命中数', async () => {
  await mount('Hello hello')
  preview()!.focus()
  pressFind()
  await act(async () => {})

  await type('hello')
  expect(count()).toBe('1/2')

  const caseBtn = document.querySelector<HTMLButtonElement>('.wfp-find-case')!
  await act(async () => caseBtn.click())
  expect(count()).toBe('1/1')
  expect(caseBtn.getAttribute('aria-pressed')).toBe('true')
})

it('Escape 关闭浮层，且把查询清干净（不留高亮残影）', async () => {
  await mount()
  preview()!.focus()
  pressFind()
  await act(async () => {})
  await type('改法')

  await pressKey('Escape')

  expect(widget()).toBeNull()

  // 再打开是空查询，计数区什么都不显示（输入框卸载后焦点回到 body，先重新聚焦预览）
  preview()!.focus()
  pressFind()
  await act(async () => {})
  expect(input()?.value).toBe('')
  expect(count()).toBe('')
})

it('关闭按钮同样能关掉；关掉后 Ctrl+F 回到「不接管」', async () => {
  await mount()
  preview()!.focus()
  pressFind()
  await act(async () => {})

  const closeBtn = [...document.querySelectorAll<HTMLButtonElement>('.wfp-find-btn')].pop()!
  await act(async () => closeBtn.click())
  expect(widget()).toBeNull()

  // 浮层没了、焦点回到 body：这次不该接管
  act(() => (document.activeElement as HTMLElement | null)?.blur?.())
  const event = pressFind()
  await act(async () => {})
  expect(event.defaultPrevented).toBe(false)
  expect(widget()).toBeNull()
})

it('当前命中在收起的 <details> 里时，自动把它展开', async () => {
  // 高亮要 CSS Custom Highlight（happy-dom 没有）：装一套替身，否则拿不到「当前 Range」
  ;(globalThis as unknown as { CSS: unknown }).CSS = {
    highlights: { set: () => {}, delete: () => false },
  }
  ;(globalThis as unknown as { Highlight: unknown }).Highlight = class {
    ranges: unknown[]
    constructor(...ranges: unknown[]) {
      this.ranges = ranges
    }
  }

  try {
    await mount('<details><summary>答案</summary>\n\n隐藏词在这里\n\n</details>\n\n尾')
    expect(document.querySelector('details')?.open).toBe(false)

    preview()!.focus()
    pressFind()
    await act(async () => {})
    await type('隐藏词')
    await act(async () => {})

    // ⚠️ 断言要**重新取节点**：替身渲染器每次重渲染都重建 innerHTML，手里那个引用已经是旧节点
    expect(document.querySelector('details')?.open).toBe(true)
  } finally {
    delete (globalThis as unknown as { CSS?: unknown }).CSS
    delete (globalThis as unknown as { Highlight?: unknown }).Highlight
  }
})

it('Ctrl+F 把选中的文本直接填进搜索框', async () => {
  await mount()
  preview()!.focus()
  stubSelection('改法 2', preview()!.querySelector('.mock-markdown')!)

  pressFind()
  await act(async () => {})

  expect(input()?.value).toBe('改法 2')
  expect(count()).toBe('1/1')
})

it('浮层已打开时再 Ctrl+F：选中文本替换掉原来的查询', async () => {
  await mount()
  preview()!.focus()
  pressFind()
  await act(async () => {})
  await type('改法')
  expect(count()).toBe('1/2')

  stubSelection('克隆', preview()!.querySelector('.mock-markdown')!)
  pressFind()
  await act(async () => {})

  expect(input()?.value).toBe('克隆')
  expect(count()).toBe('1/1')
})

it('没选中时 Ctrl+F 只重选旧词，不清空查询', async () => {
  await mount()
  preview()!.focus()
  pressFind()
  await act(async () => {})
  await type('改法')

  stubSelection('', preview()!.querySelector('.mock-markdown')!)
  pressFind()
  await act(async () => {})

  expect(input()?.value).toBe('改法')
  expect(count()).toBe('1/2')
})

it('选区不在预览里时不拿它当查询词', async () => {
  await mount()
  preview()!.focus()
  pressFind()
  await act(async () => {})
  await type('改法')

  // 选区落在面板之外的元素里（比如聊天消息里的选中）
  const outside = document.createElement('div')
  outside.textContent = '聊天里的字'
  document.body.appendChild(outside)
  stubSelection('聊天里的字', outside)

  pressFind()
  await act(async () => {})

  expect(input()?.value).toBe('改法')
})

it('多行选区只取第一行（跨块查询几乎必然零命中）', async () => {
  await mount()
  preview()!.focus()
  stubSelection('改法 1：借用\n\n改法 2：克隆', preview()!.querySelector('.mock-markdown')!)

  pressFind()
  await act(async () => {})

  expect(input()?.value).toBe('改法 1：借用')
  expect(count()).toBe('1/1')
})

/**
 * 点正文会把焦点收回滚动容器（Ctrl+F 的「预览在前台」判据靠它）—— 但代码块里的 Monaco
 * 必须例外：它在自己的 mousedown 里聚焦隐藏 textarea 并 preventDefault，我们晚一步 focus
 * 就会把它拽出来，Ctrl+C 从此落不到编辑器上（Monaco 的选区不进 window.getSelection）。
 */
async function pressMouseDown(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
}

it('点普通正文时把焦点收回预览容器', async () => {
  await mount()
  // 替身渲染器只是直出 innerHTML，没有真正的 <p>：直接点渲染出来的正文容器
  const line = preview()!.querySelector('.mock-markdown')!

  await pressMouseDown(line)

  expect(document.activeElement).toBe(preview())
})

it('点代码块里的 Monaco 时不抢焦点（否则 Ctrl+C 复制失效）', async () => {
  await mount(
    ['正文段落', '', '<div class="monaco-editor"><textarea class="inputarea"></textarea></div>'].join(
      '\n',
    ),
  )
  const textarea = document.querySelector<HTMLTextAreaElement>('.monaco-editor textarea')!
  textarea.focus()

  await pressMouseDown(textarea)

  expect(document.activeElement).toBe(textarea)
})
