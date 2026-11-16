/**
 * 全局兜底右键菜单（`ContextMenu/global.tsx`）
 *
 * 三条用户可见的承诺：
 *  1. **有选中文本** → 右键弹一个只有「复制」的菜单，复制的就是那份选区；
 *  2. **没有选中文本** → 跳过（什么都不弹，也不去猜「这里该干什么」）；
 *  3. **子级已有自己的右键菜单** → 让位（既不覆盖、也不叠加）。
 *
 * 第 3 条是整套设计的关键：全局监听挂在 document 的**冒泡阶段**，各处的
 * `useContextMenu().openAt` 在更深的节点上就 `preventDefault + stopPropagation` 了，
 * 事件根本冒不上来。这里用真实的 `openAt` 接线来钉它（而不是伪造一个 preventDefault），
 * 同时补一条「只 preventDefault、没 stopPropagation」的用例 —— 两条路都不能盖掉子级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
  copyImageToClipboard: vi.fn(() => Promise.resolve(true)),
  saveImageAs: vi.fn(() => Promise.resolve('E:/tmp/a.png')),
  defaultImageName: vi.fn(() => 'image-1'),
  imageMimeOf: vi.fn(() => 'image/png'),
  imageExtOf: vi.fn(() => 'png'),
  readImageBytes: vi.fn(() => Promise.resolve(new Uint8Array())),
}))
vi.mock('@/ui/components/shared/Toast', () => ({
  showToast: vi.fn(),
  useToast: (): any => ({ Toast: (): any => null, showToast: vi.fn() }),
}))

import { copyText } from '@/utils/clipboard'
import { showToast } from '@/ui/components/shared/Toast'
import ContextMenu, { useContextMenu } from '@/ui/components/shared/ContextMenu'
import GlobalTextMenu from '@/ui/components/shared/ContextMenu/global'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement | null = null
let root: Root | null = null

async function mount(node: React.ReactNode): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(node)
  })
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
  host?.remove()
  host = null
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.mocked(copyText).mockClear()
  vi.mocked(showToast).mockClear()
})

/** 菜单里的项文案（按 DOM 顺序） */
const menuLabels = (): (string | null)[] =>
  Array.from(document.querySelectorAll('.context-menu-item')).map(
    (el) => el.textContent,
  )

const menuButtons = (): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll('.context-menu-item'))

/** 把 el 的内容整个选中（真实拖选的最小等价物） */
function selectContents(el: Node): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** 在元素上右键；返回派发出去的事件（用于检查原生菜单会不会出现） */
async function rightClick(
  el: Element,
  point: { x: number; y: number } = { x: 100, y: 100 },
): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
  })
  await act(async () => {
    el.dispatchEvent(event)
  })
  return event
}

/** 一段可被选中的正文 */
function page(): React.ReactNode {
  return (
    <div className="page">
      <p className="target">hello world</p>
      <GlobalTextMenu />
    </div>
  )
}

describe('全局兜底右键菜单：有选中文本才有「复制」', () => {
  it('有选中文本：弹一个只有「复制」的菜单，点它复制的就是选区', async () => {
    await mount(page())
    selectContents(document.querySelector('.target')!)

    await rightClick(document.querySelector('.target')!)
    expect(menuLabels()).toEqual(['复制'])

    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('hello world')
    expect(showToast).toHaveBeenCalledWith('已复制到剪贴板')

    // 点完即关（普通项行为）
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('选区里的首尾空白原样复制（不悄悄 trim 掉用户选中的内容）', async () => {
    await mount(page())
    const textNode = document.querySelector('.target')!.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 11) // 含中间的空白，整体带 "hello world"
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    await rightClick(document.querySelector('.target')!)
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith('hello world')
  })

  it('没有选中文本：跳过（不弹菜单）', async () => {
    await mount(page())
    window.getSelection()!.removeAllRanges()

    await rightClick(document.querySelector('.target')!)
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('选区只有空白：同样跳过（空白没有可复制的意义）', async () => {
    await mount(page())
    const textNode = document.querySelector('.target')!.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 5) // "hello world" 里的空格
    range.setEnd(textNode, 6)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    await rightClick(document.querySelector('.target')!)
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('菜单已经开着时在菜单上右键：不重开、也不挪位置', async () => {
    await mount(page())
    selectContents(document.querySelector('.target')!)

    await rightClick(document.querySelector('.target')!, { x: 100, y: 100 })
    const menu = document.querySelector('.context-menu') as HTMLElement
    expect(menu.style.left).toBe('100px')

    await rightClick(menu, { x: 300, y: 300 })
    expect(document.querySelector('.context-menu')).toBe(menu)
    // 位置没被重开（重开的话会变成 300px）
    expect(menu.style.left).toBe('100px')
  })
})

describe('全局兜底右键菜单：不覆盖子级', () => {
  /** 子级自己接管右键（各处自绘菜单的真实接线方式） */
  function ChildWithOwnMenu() {
    const menu = useContextMenu()
    return (
      <div
        className="child"
        onContextMenu={(e) => menu.openAt(e, undefined)}>
        <p className="child-text">child</p>
        {menu.state && (
          <ContextMenu
            position={menu.state.position}
            onClose={menu.close}
            items={[
              { key: 'copy', label: '复制', onClick: () => {} },
              { key: 'delete', label: '删除', onClick: () => {} },
            ]}
          />
        )}
      </div>
    )
  }

  it('子级的 openAt（preventDefault + stopPropagation）→ 只出子级的菜单', async () => {
    await mount(
      <>
        <ChildWithOwnMenu />
        <GlobalTextMenu />
      </>,
    )
    selectContents(document.querySelector('.child-text')!)

    await rightClick(document.querySelector('.child-text')!)
    // 子级菜单是「复制 / 删除」；全局兜底菜单只有「复制」→ 这一条就说明没被覆盖
    expect(menuLabels()).toEqual(['复制', '删除'])
    expect(document.querySelectorAll('.context-menu')).toHaveLength(1)
  })

  it('子级只 preventDefault（没 stopPropagation）→ 同样让位', async () => {
    await mount(
      <>
        <div className="child" onContextMenu={(e) => e.preventDefault()}>
          <p className="child-text">child</p>
        </div>
        <GlobalTextMenu />
      </>,
    )
    selectContents(document.querySelector('.child-text')!)

    await rightClick(document.querySelector('.child-text')!)
    expect(document.querySelector('.context-menu')).toBeNull()
  })
})

describe('全局兜底右键菜单：原生菜单何时被挡掉', () => {
  it('开发期没有选中文本：把原生菜单留着（Inspect 要用），不拦', async () => {
    await mount(page())
    window.getSelection()!.removeAllRanges()

    const event = await rightClick(document.querySelector('.target')!)
    expect(event.defaultPrevented).toBe(false)
  })

  it('生产期没有选中文本：原生菜单也不出现（自绘窗口的老约定）', async () => {
    // 用 vi.stubEnv 把 import.meta.env.DEV 置假，走生产分支
    vi.stubEnv('DEV', false)
    await mount(page())
    window.getSelection()!.removeAllRanges()

    const event = await rightClick(document.querySelector('.target')!)
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('有选中文本：开发期也接管（弹我们自己的菜单，原生菜单不同时出现）', async () => {
    await mount(page())
    selectContents(document.querySelector('.target')!)

    const event = await rightClick(document.querySelector('.target')!)
    expect(event.defaultPrevented).toBe(true)
    expect(menuLabels()).toEqual(['复制'])
  })
})
