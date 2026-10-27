/**
 * popoverFit — 标题栏「定宽气泡」夹进窗口可视区（任务清单 `.todo-popover` / 源代码管理 `.git-popover`）。
 *
 * 三组断言：
 * ① **纯函数**：溢出算位移的方向与数值、量不到视口时一律不动（jsdom / happy-dom 的假 rect 全是 0，
 *    拿 0 当真值会算出「凭空位移 8px」）；
 * ② **hook**：打开的第一帧就写样式、关闭复位、**resize 重算不能把已施加的位移再算一遍**
 *    （否则夹过的位置被当成原始位置 → 位移清零、气泡弹回出界状态）；**位移与高度上限是分开的两份**
 *    （`frameStyle` / `bodyStyle` —— 气泡里的绝对定位浮层不能被气泡自己的滚动裁掉，§11.66）；
 * ③ **接线**：两个入口各自把这两份摊到对的地方（单层的摊同一个元素、两层的分开），
 *    且两份 style.scss 的锚点仍是 `right: 0` —— 位移是按这个锚点算的相对偏移（见 popoverFit.ts 的 ⚠️）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  POPOVER_FIT_NONE,
  POPOVER_VIEWPORT_MARGIN,
  fitPopoverInViewport,
  usePopoverViewportFit,
} from '@/ui/components/shared/popoverFit'

const VW = 1200
const VH = 768

type Rect = { left: number; right: number; top: number; height: number }

const zeroRect = (): DOMRect =>
  ({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect

function rectOf(r: Rect): DOMRect {
  return {
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.top + r.height,
    width: r.right - r.left,
    height: r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect
}

describe('fitPopoverInViewport（纯函数）', () => {
  const viewport = { width: VW, height: VH }

  it('窗口够宽：横向一动不动，高度上限 = 窗口高 − 安全距 − 顶边', () => {
    const fit = fitPopoverInViewport(
      { left: 400, right: 1080, top: 56, height: 300 },
      viewport,
    )
    expect(fit.shiftRight).toBe(0)
    expect(fit.maxHeight).toBe(VH - POPOVER_VIEWPORT_MARGIN - 56)
  })

  it('左缘越界（680px 气泡顶出窗口左边）：整体右移到安全距', () => {
    // 左缘落在 -120：要往右挪 120 + 8
    expect(
      fitPopoverInViewport({ left: -120, right: 560, top: 56, height: 300 }, viewport)
        .shiftRight,
    ).toBe(128)
  })

  it('右缘越界也兜住（拖动窗口的那一帧）：给负位移往回拉', () => {
    expect(
      fitPopoverInViewport({ left: 900, right: 1300, top: 56, height: 300 }, viewport)
        .shiftRight,
    ).toBe(VW - POPOVER_VIEWPORT_MARGIN - 1300)
  })

  it('顶边压在窗口最下：高度上限夹到 0，不为负', () => {
    expect(
      fitPopoverInViewport({ left: 400, right: 800, top: 1000, height: 300 }, viewport)
        .maxHeight,
    ).toBe(0)
  })

  it('量不到视口（width / height 为 0）：原样不动', () => {
    const rect = { left: -120, right: 560, top: 56, height: 300 }
    expect(fitPopoverInViewport(rect, { width: 0, height: VH })).toEqual(POPOVER_FIT_NONE)
    expect(fitPopoverInViewport(rect, { width: VW, height: 0 })).toEqual(POPOVER_FIT_NONE)
  })

  it('元素自己没有布局（假 rect 全 0）：同样不算位移', () => {
    expect(
      fitPopoverInViewport({ left: 0, right: 0, top: 0, height: 0 }, viewport),
    ).toEqual(POPOVER_FIT_NONE)
  })
})

/* ==================== hook ==================== */

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** 被测气泡（单层）：位移与高度上限摊在同一个元素上，与任务清单入口的写法一致 */
function Harness({ open }: { open: boolean }) {
  const { ref, frameStyle, bodyStyle } = usePopoverViewportFit(open)
  if (!open) return null
  return (
    <div className="probe-popover" ref={ref} style={{ ...frameStyle, ...bodyStyle }} />
  )
}

/** 被测气泡（两层）：气泡本体只拿位移，高度上限归内部滚动体，与源代码管理入口的写法一致 */
function SplitHarness({ open }: { open: boolean }) {
  const { ref, frameStyle, bodyStyle } = usePopoverViewportFit(open)
  if (!open) return null
  return (
    <div className="probe-popover" ref={ref} style={frameStyle}>
      <div className="probe-scroll-body" style={bodyStyle} />
    </div>
  )
}

let root: ReturnType<typeof createRoot> | null = null
let host: HTMLDivElement | null = null
let current: Rect | null = null

function stubRect(rect: Rect | null): void {
  current = rect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.className !== 'probe-popover' || !current) return zeroRect()
    return rectOf(current)
  })
}

function render(open: boolean): void {
  act(() => root!.render(<Harness open={open} />))
}

const probe = (): HTMLElement => document.querySelector('.probe-popover') as HTMLElement

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VW })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VH })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  stubRect(null)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  current = null
  vi.restoreAllMocks()
})

describe('usePopoverViewportFit', () => {
  it('打开的第一帧就写位移与高度上限', () => {
    stubRect({ left: -120, right: 560, top: 56, height: 300 })
    render(true)
    const el = probe()
    expect(el.style.right).toBe('-128px')
    expect(el.style.maxHeight).toBe(`${VH - POPOVER_VIEWPORT_MARGIN - 56}px`)
    expect(el.style.overflowY).toBe('auto')
    // 另一轴显式关掉：否则「一个轴不是 visible，另一轴算成 auto」会冒出横向滚动条
    expect(el.style.overflowX).toBe('hidden')
  })

  it('放得下就只压高度上限，不写位移', () => {
    stubRect({ left: 400, right: 1080, top: 56, height: 300 })
    render(true)
    const el = probe()
    expect(el.style.right).toBe('')
    expect(el.style.maxHeight).toBe(`${VH - POPOVER_VIEWPORT_MARGIN - 56}px`)
  })

  it('没有布局引擎（rect 全 0）：样式一个都不写', () => {
    render(true)
    const el = probe()
    expect(el.style.right).toBe('')
    expect(el.style.maxHeight).toBe('')
    expect(el.style.overflowY).toBe('')
  })

  it('关掉复位：再打开按新位置重新算，不带上次的位移', () => {
    stubRect({ left: -120, right: 560, top: 56, height: 300 })
    render(true)
    expect(probe().style.right).toBe('-128px')

    render(false)
    // 位置变了（比如窗口拉宽了）：再打开时应当不再位移
    stubRect({ left: 400, right: 1080, top: 56, height: 300 })
    render(true)
    expect(probe().style.right).toBe('')
  })

  it('resize 重算不会把已施加的位移再算一遍（量到的是夹过后的位置）', () => {
    stubRect({ left: -120, right: 560, top: 56, height: 300 })
    render(true)
    expect(probe().style.right).toBe('-128px')

    // 夹紧之后真实位置是 left=8（-120 + 128）：若直接按这个矩形重算，会得出「不越界」→ 位移清零
    stubRect({ left: 8, right: 688, top: 56, height: 300 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(probe().style.right).toBe('-128px')
  })

  /**
   * 气泡里还有绝对定位的子浮层（git 的分支 / 合并）时必须**分开摊**：气泡本体一旦带上
   * `max-height` + `overflow-y: auto`，比面板高的子浮层就会把气泡撑出滚动条，还跟着面板一起滚。
   */
  it('两份样式是分开的：位移归气泡本体，高度上限与自滚归滚动体', () => {
    stubRect({ left: -120, right: 560, top: 56, height: 300 })
    act(() => root!.render(<SplitHarness open />))

    const frame = probe()
    expect(frame.style.right).toBe('-128px')
    expect(frame.style.maxHeight).toBe('')
    expect(frame.style.overflowY).toBe('')

    const body = document.querySelector('.probe-scroll-body') as HTMLElement
    expect(body.style.maxHeight).toBe(`${VH - POPOVER_VIEWPORT_MARGIN - 56}px`)
    expect(body.style.overflowY).toBe('auto')
    expect(body.style.overflowX).toBe('hidden')
    expect(body.style.right).toBe('')
  })
})

/* ==================== 接线 / 样式锚点契约 ==================== */

const readProjectFile = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), 'utf8')

/** 取某个选择器的声明块（这些浮层的规则都在最外层，`{` 到第一个 `}` 就是全部） */
function ruleBody(src: string, selector: string): string {
  const at = src.indexOf(`${selector} {`)
  expect(at).toBeGreaterThanOrEqual(0)
  return src.slice(at, src.indexOf('}', at))
}

describe('接线与样式锚点', () => {
  it('任务清单是单层气泡：位移与高度上限都摊在气泡本体上', () => {
    const src = readProjectFile('src/ui/pages/chat/components/todo/TodoEntry.tsx')
    expect(src).toContain('usePopoverViewportFit(open)')
    // 气泡里没有绝对定位的子浮层 → 两份样式摊在同一个元素上
    expect(src).toMatch(
      /ref=\{popover\.ref\}[\s\S]{0,80}style=\{\{ \.\.\.popover\.frameStyle, \.\.\.popover\.bodyStyle \}\}/,
    )
  })

  it('源代码管理是两层：位移归气泡本体，高度上限归内部滚动体', () => {
    const src = readProjectFile('src/ui/pages/chat/components/git/GitEntry.tsx')
    expect(src).toContain('usePopoverViewportFit(open)')
    expect(src).toMatch(/ref=\{popover\.ref\} style=\{popover\.frameStyle\}/)
    expect(src).toMatch(/bodyStyle=\{popover\.bodyStyle\}/)
    // 气泡本体自己滚 = 分支 / 合并浮层被裁 + 把气泡撑出滚动条（§11.66 的原始 bug）
    expect(src).not.toContain('style={popover.style}')
  })

  it('两份 style.scss 的气泡锚点仍是 `right: 0`（位移按这个锚点算）', () => {
    const cases: Array<[string, string]> = [
      ['src/ui/pages/chat/components/todo/style.scss', '.todo-popover'],
      ['src/ui/pages/chat/components/git/style.scss', '.git-popover'],
    ]
    for (const [file, selector] of cases) {
      const body = ruleBody(readProjectFile(file), selector)
      expect(body).toMatch(/position:\s*absolute/)
      expect(body).toMatch(/right:\s*0;/)
    }
  })
})
