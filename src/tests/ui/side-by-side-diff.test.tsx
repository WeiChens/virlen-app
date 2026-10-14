/**
 * SideBySideDiff 测试。
 *
 * 覆盖：
 * - 全屏按钮是内置的（文件头右侧，不依赖调用方 actions）
 * - 点击后通过 createPortal 把「铺满」形态挂到 body
 * - 原位 diff 照常保留（搬走/卸载会让虚拟列表条目高度变化、带偏滚动锚点）
 * - 再点一次 / 按 Esc 均可退出
 * - 只有一个滚动容器（纵向）：双栏表头与每一行的左右两半都在 .diff-body 内
 * - 行结构是「每行左右两半共用一个 grid 行」→ 列宽恒为一半一半、行高左右一致
 * - DOM 顺序按列连续（左半全部在前），两半靠内联 grid-column / grid-row 落位
 *   → 拖选左栏的选区不会跨过右半（选区是文档顺序上的连续区间）
 * - 右键菜单（复制 / 全选）：选区在开菜单那一刻快照；全选只选右键那一侧
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// Monaco 在 jsdom 里跑不起来：只验证浮层的 DOM 结构，词法着色不在此测
vi.mock('@/monaco/setupMonaco', () => ({
  monaco: { editor: { tokenize: (): unknown[] => [] } },
  virlenDarkTheme: { rules: [] as unknown[] },
}))
// code-block 会连带引入 CodePreview(Monaco)：这里只用它的 toMonacoLang，换成最小替身
vi.mock('@/ui/pages/chat/components/message/code-block', () => ({
  toMonacoLang: (): string | undefined => undefined,
  default: (): null => null,
}))
// 剪贴板 / Toast 会真的调 Tauri：右键菜单的两条副作用路径换成替身
vi.mock('@/utils/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
  readClipboardText: vi.fn(() => Promise.resolve('')),
  copyImageToClipboard: vi.fn(() => Promise.resolve(true)),
  saveImageAs: vi.fn(() => Promise.resolve('')),
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
import {
  SideBySideDiff,
  type SideBySideRow,
} from '@/ui/pages/chat/components/message/SideBySideDiff'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ROWS: SideBySideRow[] = [
  {
    type: 'equal',
    oldLine: 'const a = 1',
    newLine: 'const a = 1',
    oldLineNum: 1,
    newLineNum: 1,
  },
  {
    type: 'delete',
    oldLine: 'const b = 2',
    newLine: null,
    oldLineNum: 2,
    newLineNum: null,
  },
  {
    type: 'insert',
    oldLine: null,
    newLine: 'const b = 3',
    oldLineNum: null,
    newLineNum: 2,
  },
]

async function mount(rows: SideBySideRow[] = ROWS) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<SideBySideDiff diffRows={rows} fileName="demo.ts" />)
  })
  return { host, root }
}

const fullscreenBtn = (host: HTMLElement) =>
  host.querySelector('.diff-fullscreen-btn') as HTMLButtonElement
const layer = () =>
  document.querySelector('.diff-fullscreen-layer') as HTMLElement | null

describe('SideBySideDiff 全屏', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('文件头带内置全屏按钮，默认不渲染浮层', async () => {
    const { host, root } = await mount()

    expect(fullscreenBtn(host)).toBeTruthy()
    expect(layer()).toBeNull()

    await act(async () => root.unmount())
  })

  it('点击后把 .is-fullscreen 挂到 body，原位 diff 照常保留', async () => {
    const { host, root } = await mount()

    await act(async () => fullscreenBtn(host).click())

    const el = layer()
    expect(el).toBeTruthy()
    // 必须挂在 body 下（不受消息条目祖先的 transform/overflow 影响才能铺满）
    expect(el!.parentElement).toBe(document.body)
    expect(el!.querySelector('.diff-side-by-side.is-fullscreen')).toBeTruthy()
    // 双栏内容照常渲染（每一行各一个左半 + 右半）
    expect(el!.querySelectorAll('.diff-line--old').length).toBe(ROWS.length)
    expect(el!.querySelectorAll('.diff-line--new').length).toBe(ROWS.length)
    // 原位 diff 仍在，且不是全屏形态
    expect(host.querySelector('.diff-side-by-side')).toBeTruthy()
    expect(host.querySelector('.diff-side-by-side.is-fullscreen')).toBeNull()

    await act(async () => root.unmount())
  })

  it('再点一次退出，Esc 也能退出', async () => {
    const { host, root } = await mount()

    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeTruthy()
    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeNull()

    await act(async () => fullscreenBtn(host).click())
    expect(layer()).toBeTruthy()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(layer()).toBeNull()

    await act(async () => root.unmount())
  })

  it('节点类名保留：变更行左右高亮、省略行渲染为 ⋯（双栏各一份）', async () => {
    const { host, root } = await mount([...ROWS, { type: 'gap' }])

    expect(host.querySelectorAll('.diff-line--highlight-old').length).toBe(1)
    expect(host.querySelectorAll('.diff-line--highlight-new').length).toBe(1)
    expect(host.querySelectorAll('.diff-line--gap').length).toBe(2)

    await act(async () => root.unmount())
  })
})

describe('SideBySideDiff 单一滚动容器', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('双栏表头与每一行的左右两半都在 .diff-body 内，文件头留在滚动区外', async () => {
    const { host, root } = await mount()

    const body = host.querySelector('.diff-body') as HTMLElement
    expect(body).toBeTruthy()
    // 表头进了滚动区：纵向吸顶，且跨两列（内部两个标题各占一半）
    expect(body.querySelector('.diff-column-headers')).toBeTruthy()
    expect(body.querySelectorAll('.diff-col-header').length).toBe(2)
    // 内容都在同一个滚动容器里 → 滚动位置天然一致，不存在「另一半慢一帧」
    expect(body.querySelectorAll('.diff-line').length).toBe(ROWS.length * 2)
    // 文件头留在滚动区外：不随内容滚动
    expect(body.querySelector('.diff-header')).toBeNull()
    expect(host.querySelectorAll('.diff-header').length).toBe(1)

    await act(async () => root.unmount())
  })

  it('左半全部在前、右半全部在后，两半由内联 grid 落位（同一 grid 行）', async () => {
    const { host, root } = await mount()

    // 同一 grid 行 = 两半同宽（各占一半）、行高一致（一侧折行另一侧跟着变高）
    const body = host.querySelector('.diff-body') as HTMLElement
    const halves = [...body.querySelectorAll<HTMLElement>('.diff-line')]
    expect(halves.length).toBe(ROWS.length * 2)
    halves.forEach((el, i) => {
      expect(el.parentElement).toBe(body)
      // DOM 顺序按列连续：拖选左栏时选区不会跨过中间那些右半
      const isOld = i < ROWS.length
      expect(el.classList.contains(isOld ? 'diff-line--old' : 'diff-line--new')).toBe(
        true,
      )
      // 位置不靠 DOM 顺序：左半恒第 1 列、右半恒第 2 列，同一行号共用第 rowIndex+2 行
      const rowIndex = isOld ? i : i - ROWS.length
      expect(el.style.gridColumn).toBe(isOld ? '1' : '2')
      expect(el.style.gridRow).toBe(String(rowIndex + 2))
    })

    // 不再有独立的两栏容器，也不再有任何 JS 量宽（--diff-col-w 已删）：
    // 列宽由 CSS 的 1fr 1fr 给出，量错一次就会变成「左宽右窄」的那类 bug 不复存在
    expect(body.querySelector('.diff-panel')).toBeNull()
    const rootEl = host.querySelector('.diff-side-by-side') as HTMLElement
    expect(rootEl.style.getPropertyValue('--diff-col-w')).toBe('')

    await act(async () => root.unmount())
  })
})

/** 行号刻意取 11/22/33：与正文不同，好断言「复制出来的东西里没有行号」 */
const MENU_ROWS: SideBySideRow[] = [
  { type: 'equal', oldLine: 'AAA', newLine: 'AAA', oldLineNum: 11, newLineNum: 11 },
  { type: 'delete', oldLine: 'BBB', newLine: null, oldLineNum: 22, newLineNum: null },
  { type: 'insert', oldLine: null, newLine: 'CCC', oldLineNum: null, newLineNum: 33 },
]
const OLD_TEXT = 'AAA\nBBB'
const NEW_TEXT = 'AAA\nCCC'

const menuLabels = () =>
  Array.from(document.querySelectorAll('.context-menu-item')).map(
    (el) => el.textContent,
  )
const menuButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'))

async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      }),
    )
  })
}

/** 在节点内容里拉一段真实选区（jsdom 支持 Range/Selection，但不模拟鼠标拖选） */
function selectText(node: Node, start: number, end: number) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

describe('SideBySideDiff 右键菜单', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
    vi.mocked(copyText).mockClear()
    vi.mocked(showToast).mockClear()
  })

  it('右键弹出「复制 / 全选原文件」（落点不在两栏时按原文件），且不冒泡到外层（消息行）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    // 外层模拟消息行的右键处理：被触发即为回归
    const outerContextMenu = vi.fn()
    await act(async () => {
      root.render(
        <div onContextMenu={outerContextMenu}>
          <SideBySideDiff diffRows={ROWS} fileName="demo.ts" />
        </div>,
      )
    })

    await rightClick(host.querySelector('.diff-side-by-side')!)
    expect(menuLabels()).toEqual(['复制', '全选原文件'])
    expect(outerContextMenu).not.toHaveBeenCalled()

    // 右键右栏 → 标签随落点变成「全选新文件」
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const root2 = createRoot(host2)
    await act(async () => {
      root2.render(<SideBySideDiff diffRows={ROWS} fileName="demo.ts" />)
    })
    await rightClick(host2.querySelector('.diff-line--new')!)
    expect(menuLabels()).toEqual(['复制', '全选新文件'])

    await act(async () => root2.unmount())
  })

  it('有选区时「复制」只复制选区（开菜单时快照，不因菜单项 mousedown 而丢失）', async () => {
    const { host, root } = await mount()
    // 左栏第 1 行里拖选一段
    selectText(host.querySelector('.diff-code')!.firstChild!, 0, 5)

    await rightClick(host.querySelector('.diff-side-by-side')!)
    // 模拟点菜单项：mousedown 会把 window 选区弄丢（§11.38 同一类坑）
    window.getSelection()!.removeAllRanges()
    await act(async () => {
      menuButtons()[0].click()
    })

    expect(copyText).toHaveBeenCalledWith('const')
    expect(showToast).toHaveBeenCalledWith('已复制到剪贴板')

    await act(async () => root.unmount())
  })

  it('无选区时「复制」只提示先选，不碰剪贴板', async () => {
    const { host, root } = await mount()

    await rightClick(host.querySelector('.diff-side-by-side')!)
    await act(async () => {
      menuButtons()[0].click()
    })

    expect(showToast).toHaveBeenCalledWith('请先选择要复制的内容')
    expect(copyText).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('「全选原文件」只选左栏，菜单保持打开', async () => {
    const { host, root } = await mount(MENU_ROWS)

    await rightClick(host.querySelector('.diff-line--old')!)
    await act(async () => {
      menuButtons()[1].click()
    })
    // 「全选」不关菜单（keepOpen），方便紧接着「复制」
    expect(document.querySelector('.context-menu')).toBeTruthy()
    // 视觉上确实选中了东西
    expect(window.getSelection()!.rangeCount).toBe(1)

    await act(async () => {
      menuButtons()[0].click()
    })
    // 文本由行数据生成（不是序列化 DOM 选区）：行号 11/22/33 不该出现在剪贴板里
    expect(copyText).toHaveBeenCalledWith(OLD_TEXT)
    expect(vi.mocked(copyText).mock.calls[0][0]).not.toContain('11')

    await act(async () => root.unmount())
  })

  it('「全选新文件」只选右栏（左栏各行不进文本）', async () => {
    const { host, root } = await mount(MENU_ROWS)

    await rightClick(host.querySelector('.diff-line--new')!)
    await act(async () => {
      menuButtons()[1].click()
    })
    await act(async () => {
      menuButtons()[0].click()
    })

    expect(copyText).toHaveBeenCalledWith(NEW_TEXT)
    expect(vi.mocked(copyText).mock.calls[0][0]).not.toContain('BBB')

    await act(async () => root.unmount())
  })

  it('全屏里右键：全选作用在被点的那一份实例与那一栏', async () => {
    const { host, root } = await mount(MENU_ROWS)

    await act(async () => fullscreenBtn(host).click())
    const full = layer()!
    await rightClick(full.querySelector('.diff-line--new')!)
    expect(menuLabels()).toEqual(['复制', '全选新文件'])
    await act(async () => {
      menuButtons()[1].click()
    })

    // 选区落在全屏那一份里（两份实例同挂载，接错就会作用到看不见的那份）
    const sel = window.getSelection()!
    expect(full.contains(sel.getRangeAt(0).startContainer)).toBe(true)
    expect(
      host
        .querySelector('.diff-side-by-side')!
        .contains(sel.getRangeAt(0).startContainer),
    ).toBe(false)
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith(NEW_TEXT)

    window.getSelection()!.removeAllRanges()
    await act(async () => root.unmount())
  })
})
