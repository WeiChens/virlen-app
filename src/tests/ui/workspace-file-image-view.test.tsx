/**
 * ImageViewer — 图片预览的交互口径。
 *
 * 1. **滚轮只缩放**（不滚外层），百分比跟着变；
 * 2. **按住拖动平移**（document 上收尾，指针移出面板也不断）；
 * 3. **旋转按钮 / 右键菜单**都在，且旋转只改查看；
 * 4. **右键「复制图片」要把 mime 传下去**：面板里是 blob URL，没有扩展名，
 *    不传就会被浏览器兜底当成 PNG。
 *
 * 视图数学由 `tests/domain/image-view.test.ts` 守；这里只验「接上了没有」。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ImageViewer from '@/ui/pages/chat/components/workspace-file/image-viewer'

const { copyMock, saveMock } = vi.hoisted(() => ({
  copyMock: vi.fn(),
  saveMock: vi.fn(),
}))

vi.mock('@/utils/clipboard', () => ({
  copyImageToClipboard: copyMock,
  saveImageAs: saveMock,
  defaultImageName: () => 'image-1',
}))

vi.mock('@/ui/components/shared/Toast', () => ({ showToast: () => {} }))

let root: ReturnType<typeof createRoot> | null = null
let systemOpened = 0

// React 19 的 `act()` 要求显式声明「这是测试环境」，否则每个 await act 都打一行警告
// （只影响本文件：该标记是全局的，但重复设为 true 无副作用）
beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ImageViewer
        src="blob:test"
        name="pic.png"
        mime="image/png"
        onOpenInSystem={() => {
          systemOpened += 1
        }}
      />,
    )
  })
}

const container = () => document.querySelector<HTMLElement>('.wfp-image')!
const image = () => document.querySelector<HTMLImageElement>('.wfp-image-content')!
const percentBtn = () =>
  document.querySelector<HTMLButtonElement>('.wfp-image-btn.is-percent')!
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.wfp-image-btn')].find(
    (el) => el.getAttribute('aria-label') === label,
  )!
const menuLabels = () =>
  [...document.querySelectorAll<HTMLElement>('.context-menu-item')].map((el) => el.textContent)
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
    (el) => el.textContent === label,
  )!

beforeEach(() => {
  document.body.innerHTML = ''
  systemOpened = 0
  copyMock.mockReset()
  saveMock.mockReset()
  copyMock.mockResolvedValue(true)
  saveMock.mockResolvedValue('')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('工具栏', () => {
  it('默认适应窗口 100%，点「＋」按倍率放大', async () => {
    await mount()
    expect(percentBtn().textContent).toBe('100%')

    act(() => button('放大').click())
    expect(percentBtn().textContent).toBe('125%')

    act(() => button('缩小').click())
    expect(percentBtn().textContent).toBe('100%')
  })

  it('点百分比 = 回到适应窗口', async () => {
    await mount()
    act(() => button('放大').click())
    act(() => button('放大').click())
    expect(percentBtn().textContent).toBe('156%')

    act(() => percentBtn().click())
    expect(percentBtn().textContent).toBe('100%')
    expect(image().style.transform).toContain('scale(1)')
  })

  it('旋转按钮只改 transform，不碰图片字节', async () => {
    await mount()
    act(() => button('向右旋转').click())
    expect(image().style.transform).toContain('rotate(90deg)')

    act(() => button('向左旋转').click())
    expect(image().style.transform).toContain('rotate(0deg)')
  })
})

describe('滚轮与拖动', () => {
  it('滚轮向上放大、向下缩小', async () => {
    await mount()
    const el = container()

    act(() => {
      el.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }),
      )
    })
    expect(percentBtn().textContent).toBe('125%')

    act(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    })
    expect(percentBtn().textContent).toBe('100%')
  })

  it('按住拖动改变平移量，松手结束', async () => {
    await mount()
    const el = container()

    act(() => {
      el.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
      )
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 130 }))
    })
    expect(image().style.transform).toContain('translate(50px, 30px)')

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    // 松手后继续移动不再影响视图
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 400 }))
    })
    expect(image().style.transform).toContain('translate(50px, 30px)')
  })

  it('工具栏上的按下不触发拖动（否则点一下图片就跟着跑）', async () => {
    await mount()
    act(() => {
      percentBtn().dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      )
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 80 }))
    })
    expect(image().style.transform).toContain('translate(0px, 0px)')
  })
})

describe('右键菜单', () => {
  async function openMenu() {
    act(() => {
      container().dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
      )
    })
  }

  it('列出复制 / 另存为 / 旋转 / 视图 / 系统打开', async () => {
    await mount()
    await openMenu()

    expect(menuLabels()).toEqual([
      '复制图片',
      '另存为',
      '向左旋转',
      '向右旋转',
      '实际大小',
      '适应窗口',
      '在系统程序中打开',
    ])
  })

  it('复制图片把 mime 传给剪贴板（blob URL 没有扩展名）', async () => {
    await mount()
    await openMenu()

    await act(async () => menuItem('复制图片').click())
    expect(copyMock).toHaveBeenCalledWith('blob:test', { mime: 'image/png' })
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('菜单里的「适应窗口」重置视图，「在系统程序中打开」透传给宿主', async () => {
    await mount()
    act(() => button('放大').click())
    await openMenu()
    await act(async () => menuItem('适应窗口').click())
    expect(percentBtn().textContent).toBe('100%')

    await openMenu()
    await act(async () => menuItem('在系统程序中打开').click())
    expect(systemOpened).toBe(1)
  })
})
