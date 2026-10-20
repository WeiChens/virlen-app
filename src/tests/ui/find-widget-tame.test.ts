/**
 * `src/monaco/findWidget.ts::tameFindWidget` 的行为契约。
 *
 * 两条都只会在运行期露出来，编译器与「文件里有没有那句话」的契约测试都守不住：
 *  ① **气泡断源**：捕获阶段的 `mouseover` 必须真的拦住挂在 `.find-widget` 子节点上的监听
 *    （Monaco 的 `setupDelayedHover` 就是这么挂的）—— 拦不住就等于气泡照旧被切一半；
 *  ② **位置夹紧**：编辑器比可视区高、上半被滚动祖先裁掉时（聊天里的消息列表 / 弹窗），
 *    查找框的 `top` 必须落进「编辑器 ∩ 所有滚动祖先 ∩ 视口」的可见交集；都看得见时必须是 0。
 *    （纵向滚动现在归 Monaco 自己 —— 内置滚动条不带动 overlay widget，这里只剩下裁切这一档兜底。）
 *
 * 几何全靠 `getBoundingClientRect` / `getComputedStyle`，jsdom 两者都不算布局，因此这里显式打桩。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { tameFindWidget } from '@/monaco/findWidget'
import type * as MonacoNs from 'monaco-editor'

/** 伪造一个够用的编辑器实例（只实现 tameFindWidget 用到的那几个成员） */
function fakeEditor(container: HTMLElement): MonacoNs.editor.IStandaloneCodeEditor {
  const noopListener = (): MonacoNs.IDisposable => ({ dispose: () => {} })
  return {
    getContainerDomNode: () => container,
    onDidFocusEditorWidget: noopListener,
    onDidChangeCursorSelection: noopListener,
    onDidLayoutChange: noopListener,
  } as unknown as MonacoNs.editor.IStandaloneCodeEditor
}

function stubRect(element: Element, rect: { top: number; bottom: number }): void {
  element.getBoundingClientRect = () =>
    ({
      ...rect,
      left: 0,
      right: 400,
      width: 400,
      height: rect.bottom - rect.top,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect
}

/** jsdom 没有 rAF 时兜底（schedule 会在没有 rAF 的宿主里直接跳过） */
function ensureRaf(): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((cb: (t: number) => void) =>
      setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame
  }
}

/** 等两帧（apply 排的是「自己 + 下一帧」两连拍） */
const waitTwoFrames = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60))

interface Scene {
  scroller: HTMLDivElement
  host: HTMLDivElement
  widget: HTMLDivElement
}

function mountScene(options: {
  scroller: { top: number; bottom: number }
  host: { top: number; bottom: number }
}): Scene {
  const scroller = document.createElement('div')
  scroller.dataset.overflow = 'auto'
  const host = document.createElement('div')
  const overlay = document.createElement('div')
  overlay.className = 'overlayWidgets'
  const widget = document.createElement('div')
  widget.className = 'find-widget'
  overlay.appendChild(widget)
  host.appendChild(overlay)
  scroller.appendChild(host)
  document.body.appendChild(scroller)

  stubRect(scroller, options.scroller)
  stubRect(host, options.host)
  // 查找框高度：Monaco 的 FIND_INPUT_AREA_HEIGHT
  Object.defineProperty(widget, 'offsetHeight', { value: 33, configurable: true })
  return { scroller, host, widget }
}

describe('tameFindWidget', () => {
  beforeEach(() => {
    ensureRaf()
    // jsdom 的 getComputedStyle 不吐 overflowY 的有效值：按 data-overflow 打桩
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element: Element) =>
        ({
          overflowY: (element as HTMLElement).dataset.overflow ?? 'visible',
        }) as unknown as CSSStyleDeclaration,
    )
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('气泡断源：.find-widget 内的 mouseover 不落到目标节点上，框外照常', () => {
    const { host, widget } = mountScene({
      scroller: { top: 0, bottom: 1000 },
      host: { top: 0, bottom: 400 },
    })
    const handle = tameFindWidget(fakeEditor(host))

    const inside = vi.fn()
    const outside = vi.fn()
    widget.addEventListener('mouseover', inside)
    host.addEventListener('mouseover', outside)

    widget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(inside).not.toHaveBeenCalled()

    host.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(outside).toHaveBeenCalled()

    handle.dispose()
  })

  it('位置夹紧：编辑器上半截滚出可视区时，搜索框被按到可见区顶边', async () => {
    // 编辑器：-400 ~ 1200；可见区（滚动祖先）：100 ~ 300
    const { scroller, host, widget } = mountScene({
      scroller: { top: 100, bottom: 300 },
      host: { top: -400, bottom: 1200 },
    })
    const handle = tameFindWidget(fakeEditor(host))

    scroller.dispatchEvent(new Event('scroll'))
    await waitTwoFrames()

    // 100 - (-400) = 500：框顶正好压在可见区顶边
    expect(widget.style.top).toBe('500px')
    handle.dispose()
  })

  it('位置夹紧：整体都在可视区里时保持原位（top: 0），不与 Monaco 自己的定位打架', async () => {
    const { scroller, host, widget } = mountScene({
      scroller: { top: 0, bottom: 1000 },
      host: { top: 50, bottom: 900 },
    })
    const handle = tameFindWidget(fakeEditor(host))

    scroller.dispatchEvent(new Event('scroll'))
    await waitTwoFrames()

    expect(widget.style.top).toBe('0px')
    handle.dispose()
  })

  it('dispose 摘干净：气泡拦截与滚动重算都不再发生', async () => {
    const { scroller, host, widget } = mountScene({
      scroller: { top: 100, bottom: 300 },
      host: { top: -400, bottom: 1200 },
    })
    const handle = tameFindWidget(fakeEditor(host))
    handle.dispose()

    const inside = vi.fn()
    widget.addEventListener('mouseover', inside)
    widget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(inside).toHaveBeenCalled()

    scroller.dispatchEvent(new Event('scroll'))
    await waitTwoFrames()
    expect(widget.style.top).toBe('')
  })

  it('没有真实 DOM 容器（单测里的假编辑器）时返回空句柄，不抛', () => {
    const fake = {
      getContainerDomNode: (): HTMLElement => undefined as unknown as HTMLElement,
    } as unknown as MonacoNs.editor.IStandaloneCodeEditor
    const handle = tameFindWidget(fake)
    expect(() => handle.dispose()).not.toThrow()
  })

  it('查找框还没创建（没按过 Ctrl+F）时不报错、不写样式', async () => {
    const { scroller, host } = mountScene({
      scroller: { top: 100, bottom: 300 },
      host: { top: -400, bottom: 1200 },
    })
    host.querySelector('.find-widget')?.remove()
    const handle = tameFindWidget(fakeEditor(host))

    scroller.dispatchEvent(new Event('scroll'))
    await waitTwoFrames()
    expect(host.querySelector('.find-widget')).toBeNull()
    handle.dispose()
  })
})
