/**
 * ImportMessageList（「导入知识库」弹窗里的消息选择列表）单测。
 *
 * 只钉这一层的三件事：虚拟滚动的渲染范围 / 勾选回调恰好一次 / 右键菜单的范围与详情。
 * jsdom 没有布局引擎、也没有 ResizeObserver —— 必须自己喂尺寸，否则虚拟库的渲染区间为空，
 * 「一条都没渲染」也能让断言通过（假绿）。替身口径与 `message-list-tool-group.test.tsx` 一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Message } from '@/types'
import ImportMessageList from '@/ui/pages/chat/components/sidebar/import-message-list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** 滚动容器高度（对应 style.scss 里 .import-kb-msg-list 的 max-height） */
const LIST_HEIGHT = 240
/**
 * 单行高度：**故意取一个不等于组件内部估算值的尺寸**（估算值 29），
 * 这样「行位置按实测高度累加」才真正证明 measureElement 的 ref 接上了 ——
 * 若退化成只用估算值，断言会停在 29px。
 */
const ROW_HEIGHT = 40

// 虚拟库在构造时 new ResizeObserver(...)（观测容器与每个条目），jsdom 里没有就会直接抛错
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver

// jsdom 没有布局：按类名给尺寸。虚拟库的 getRect 读 offsetWidth/offsetHeight（不是 getBoundingClientRect）
function sizeOf(el: Element): { width: number; height: number } {
  const cls = el.className
  if (typeof cls === 'string') {
    if (cls.includes('import-kb-msg-list')) return { width: 400, height: LIST_HEIGHT }
    if (cls.includes('import-kb-msg-item')) return { width: 400, height: ROW_HEIGHT }
  }
  return { width: 800, height: 600 }
}
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return sizeOf(this).height
  },
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return sizeOf(this).width
  },
})
Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  const { width, height } = sizeOf(this)
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

function makeMessages(count: number, content?: (i: number) => string): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: content ? content(i) : `第 ${i} 条消息`,
    timestamp: i,
  })) as Message[]
}

interface MountOptions {
  selectedIds?: Set<string>
  onToggle?: (id: string) => void
  onSelectMessages?: (ids: string[]) => void
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(messages: Message[], opts: MountOptions = {}): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <ImportMessageList
        messages={messages}
        selectedIds={opts.selectedIds ?? new Set()}
        onToggle={opts.onToggle ?? (() => {})}
        onSelectMessages={opts.onSelectMessages ?? (() => {})}
      />,
    )
  })
}

const rows = (): HTMLElement[] =>
  Array.from(container!.querySelectorAll<HTMLElement>('.import-kb-msg-item'))

const rowAt = (index: number): HTMLElement => {
  const row = rows().find((r) => r.dataset.index === String(index))
  if (!row) throw new Error(`第 ${index} 行未渲染`)
  return row
}

/** 右键某一行（ContextMenu 通过 openAt 接 clientX/clientY） */
function openMenuAt(index: number): void {
  act(() => {
    rowAt(index).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
    )
  })
}

function menuItem(text: string): HTMLElement {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>('.context-menu-item'),
  ).find((i) => (i.textContent ?? '').includes(text))
  if (!item) throw new Error(`菜单项未找到：${text}`)
  return item
}

function clickMenu(text: string): void {
  act(() => menuItem(text).click())
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
})

describe('ImportMessageList：虚拟滚动', () => {
  it('500 条消息只渲染视口附近的若干行', () => {
    mount(makeMessages(500))

    const rendered = rows()
    // 至少铺满一屏（否则不是「虚拟化」而是「没渲染」）
    expect(rendered.length).toBeGreaterThanOrEqual(Math.ceil(LIST_HEIGHT / ROW_HEIGHT))
    // 上限宽松取 60：一屏 6 行 + overscan，与 500 无关
    expect(rendered.length).toBeLessThan(60)
    // 从第 0 条开始，且渲染区间连续
    expect(rendered[0].dataset.index).toBe('0')
    expect(rendered[rendered.length - 1].dataset.index).toBe(
      String(rendered.length - 1),
    )
  })

  it('行的 top 位置按实测行高累加（字号可调，靠实测而不是写死）', () => {
    mount(makeMessages(30))

    expect(rowAt(1).style.top).toBe(`${ROW_HEIGHT}px`)
  })

  it('已选中的消息：行带 checked、勾选框为选中态', () => {
    mount(makeMessages(10), { selectedIds: new Set(['m0', 'm1']) })

    const first = rowAt(0)
    expect(first.classList.contains('checked')).toBe(true)
    expect(first.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
    const third = rowAt(2)
    expect(third.classList.contains('checked')).toBe(false)
    expect(third.querySelector<HTMLInputElement>('input')!.checked).toBe(false)
  })

  it('点击整行 → onToggle 收到该消息 id，且只触发一次', () => {
    const onToggle = vi.fn()
    mount(makeMessages(10), { onToggle })

    act(() => rowAt(1).click())
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('m1')
  })

  it('点击勾选框 → 也只触发一次（stopPropagation 挡住行上的 onClick）', () => {
    const onToggle = vi.fn()
    mount(makeMessages(10), { onToggle })

    const box = rowAt(1).querySelector<HTMLInputElement>('input')!
    act(() => box.click())
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('m1')
  })

  it('没有消息时不渲染行也不报错', () => {
    mount([])
    expect(rows().length).toBe(0)
    // 总高 0 → 内部撑高容器不占位
    const inner = container!.querySelector<HTMLElement>('.import-kb-msg-inner')
    expect(inner?.style.height).toBe('0px')
  })
})

describe('ImportMessageList：行右键菜单', () => {
  it('右键一行弹出菜单，三项都在', () => {
    mount(makeMessages(10))

    openMenuAt(2)
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('.context-menu-item'),
    ).map((i) => i.textContent)
    expect(labels).toEqual(['前面全选', '后面全选', '查看详情'])
  })

  it('「前面全选」→ 交出 0..该条（含端点）的 id，由父组件决定追加', () => {
    const onSelectMessages = vi.fn()
    mount(makeMessages(10), { onSelectMessages })

    openMenuAt(3)
    clickMenu('前面全选')
    expect(onSelectMessages).toHaveBeenCalledTimes(1)
    expect(onSelectMessages).toHaveBeenCalledWith(['m0', 'm1', 'm2', 'm3'])
  })

  it('「后面全选」→ 交出 该条..末条 的 id', () => {
    const onSelectMessages = vi.fn()
    mount(makeMessages(10), { onSelectMessages })

    openMenuAt(7)
    clickMenu('后面全选')
    expect(onSelectMessages).toHaveBeenCalledWith(['m7', 'm8', 'm9'])
  })

  it('菜单项点完即关闭', () => {
    mount(makeMessages(10))

    openMenuAt(1)
    expect(document.querySelector('.context-menu')).not.toBeNull()
    clickMenu('前面全选')
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('「查看详情」→ 弹窗给完整正文（列表预览只截 60 字）+ 思考过程', () => {
    const long = 'A'.repeat(200)
    const messages = makeMessages(10, (i) => (i === 1 ? long : `第 ${i} 条`))
    messages[1].reasoningContent = '推理过程正文'
    mount(messages)

    // 列表行上确实是截断预览
    expect(rowAt(1).querySelector('.import-kb-msg-preview')!.textContent).toHaveLength(60)

    openMenuAt(1)
    clickMenu('查看详情')

    const modal = document.querySelector('.msg-detail-modal')
    expect(modal).not.toBeNull()
    expect(modal!.textContent).toContain('助手') // m1 是 assistant
    expect(modal!.textContent).toContain('第 2 条')
    // 正文不截断
    const texts = Array.from(modal!.querySelectorAll('.msg-detail-text')).map(
      (t) => t.textContent ?? '',
    )
    expect(texts).toContain(long)
    expect(texts).toContain('推理过程正文')
  })
})
