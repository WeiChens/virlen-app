/**
 * SideBySideDiff 测试。
 *
 * 覆盖：
 * - 全屏按钮是内置的（文件头右侧，不依赖调用方 actions）
 * - 点击后通过 createPortal 把「铺满」形态挂到 body
 * - 原位 diff 照常保留（搬走/卸载会让虚拟列表条目高度变化、带偏滚动锚点）
 * - 再点一次 / 按 Esc 均可退出
 * - 两栏各是一个滚动容器（纵 + 横）：列头与这一栏的行都在同一个 .diff-pane 里，文件头留在外面
 * - 两栏各占可视宽的一半（不是按内容宽）→ 不会出现「一边大一边小」；一栏滚动另一栏跟着走
 *   （横向 + 纵向，见 syncPanes）
 * - 超长行**不折行**：栏内内容宽 = max(100%, 最长一行) 写进 --diff-max-ch（两栏同宽）；
 *   行号 / 列头标签 sticky 钉在栏的左边（这几条只靠 CSS，样式契约测试守着）
 * - DOM 顺序按栏连续（左栏整栏在前）→ 拖选左栏的选区不会跨过右栏（选区是文档顺序上的连续区间）
 * - **行内片段**：改动的字符包成 `.diff-part--removed / --added`（整行底色之外再深一档）
 * - 右键菜单（复制 / 全选）：选区在开菜单那一刻快照；全选只选右键那一侧；复制不含换行标记
 * - **单栏**（`singleSide`）：只有一侧有内容时只画那一栏，另一栏连表头一起不画
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as sass from 'sass'

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
import { NL_MARK } from '@/utils/diff'
import {
  SideBySideDiff,
  type SideBySideRow,
} from '@/ui/pages/chat/components/message/SideBySideDiff'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** 编译真实的 diff 样式（样式契约测试用）：注释要去掉，否则注释里的字会被断言误命中 */
function diffCss(): string {
  return sass
    .compileString(
      readFileSync(
        resolve(
          process.cwd(),
          'src/ui/pages/chat/components/message/SideBySideDiff.scss',
        ),
        'utf8',
      ),
    )
    .css.replace(/\/\*[\s\S]*?\*\//g, '')
}

const ROWS: SideBySideRow[] = [
  {
    type: 'equal',
    leftLineNo: 1,
    rightLineNo: 1,
    left: [{ type: 'equal', value: 'const a = 1' }],
    right: [{ type: 'equal', value: 'const a = 1' }],
  },
  {
    type: 'modified',
    leftLineNo: 2,
    rightLineNo: 2,
    left: [
      { type: 'equal', value: 'const b = ' },
      { type: 'removed', value: '2' },
    ],
    right: [
      { type: 'equal', value: 'const b = ' },
      { type: 'added', value: '3' },
    ],
  },
  {
    type: 'added',
    leftLineNo: null,
    rightLineNo: 3,
    left: [],
    right: [{ type: 'added', value: 'const c = 4' }],
  },
]

async function mount(
  rows: SideBySideRow[] = ROWS,
  singleSide?: 'old' | 'new',
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <SideBySideDiff
        diffRows={rows}
        fileName="demo.ts"
        singleSide={singleSide}
      />,
    )
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

  it('节点类名保留：改动行左右高亮、行内片段、省略行渲染为 ⋯（双栏各一份）', async () => {
    const { host, root } = await mount([...ROWS, { type: 'gap' }])

    // modified 行两侧都算改动；added 行只有右半算 —— 左半不该被整行染红
    expect(host.querySelectorAll('.diff-line--highlight-old').length).toBe(1)
    expect(host.querySelectorAll('.diff-line--highlight-new').length).toBe(2)
    // 行内片段：改了哪几个字（这是换掉手写 LCS 的主要收益）
    expect(host.querySelectorAll('.diff-part--removed').length).toBe(1)
    expect(host.querySelectorAll('.diff-part--added').length).toBe(1)
    expect(host.querySelector('.diff-part--removed')?.textContent).toBe('2')
    // 省略行（只有 edit_file 的多处编辑之间才会出现）
    expect(host.querySelectorAll('.diff-line--gap').length).toBe(2)

    await act(async () => root.unmount())
  })
})

describe('SideBySideDiff 两栏各自的滚动容器', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('列头与这一栏的行都在同一个 .diff-pane 里，文件头留在滚动区外', async () => {
    const { host, root } = await mount()

    const body = host.querySelector('.diff-body') as HTMLElement
    const oldPane = host.querySelector('.diff-pane--old') as HTMLElement
    const newPane = host.querySelector('.diff-pane--new') as HTMLElement
    expect(body).toBeTruthy()
    expect(oldPane.parentElement).toBe(body)
    expect(newPane.parentElement).toBe(body)
    // 列头长在自己那一栏的滚动容器里（纵向吸顶、横向跟着这一栏滚）
    expect(oldPane.querySelector('.diff-col-header--old')).toBeTruthy()
    expect(newPane.querySelector('.diff-col-header--new')).toBeTruthy()
    // 行也各自在自己那一栏里，两栏行数相同（两栏的行按序号一一对应，行高由行盒决定）
    expect(oldPane.querySelectorAll('.diff-line--old').length).toBe(ROWS.length)
    expect(newPane.querySelectorAll('.diff-line--new').length).toBe(ROWS.length)
    expect(body.querySelectorAll('.diff-line').length).toBe(ROWS.length * 2)
    // 栏内内容容器：宽度由 --diff-max-ch 撑开（横向滚动范围就在它身上）
    expect(oldPane.querySelectorAll('.diff-pane-inner').length).toBe(1)
    // 文件头留在滚动区外：不随内容滚动
    expect(body.querySelector('.diff-header')).toBeNull()
    expect(host.querySelectorAll('.diff-header').length).toBe(1)

    await act(async () => root.unmount())
  })

  it('横向滚动的宽度写进 .diff-body 的 --diff-max-ch（取最长一行）', async () => {
    const rows: SideBySideRow[] = [
      ...ROWS,
      {
        type: 'modified',
        leftLineNo: 4,
        rightLineNo: 4,
        left: [{ type: 'equal', value: 'x'.repeat(123) }],
        right: [{ type: 'equal', value: '短' }],
      },
    ]
    const { host, root } = await mount(rows)

    // 列宽（CSS）读这个变量：不写 / 写错时超长行会被裁掉或被折行，编译期不报
    const body = host.querySelector('.diff-body') as HTMLElement
    expect(body.style.getPropertyValue('--diff-max-ch')).toBe('123')

    await act(async () => root.unmount())
  })

  it('左栏整栏在前、右栏整栏在后（选区是文档顺序上的连续区间）', async () => {
    const { host, root } = await mount()

    const panes = [...host.querySelectorAll<HTMLElement>('.diff-pane')]
    expect(panes.length).toBe(2)
    // 栏顺序 = DOM 顺序：拖选左栏时选区不会跨过中间那些右半
    expect(panes[0].classList.contains('diff-pane--old')).toBe(true)
    expect(panes[1].classList.contains('diff-pane--new')).toBe(true)
    // 每一栏里只有自己那一侧的行，行序与 diffRows 一致（两栏行数相同才能逐行对齐）
    const oldRows = [...panes[0].querySelectorAll<HTMLElement>('.diff-line')]
    const newRows = [...panes[1].querySelectorAll<HTMLElement>('.diff-line')]
    expect(oldRows.every((el) => el.classList.contains('diff-line--old'))).toBe(true)
    expect(newRows.every((el) => el.classList.contains('diff-line--new'))).toBe(true)
    expect(oldRows.length).toBe(ROWS.length)
    expect(newRows.length).toBe(ROWS.length)
    // 行不再靠内联 grid 落位（那是「一个容器两栏」时代的做法）：栏宽 / 栏位一律由 CSS 给
    expect(oldRows[0].style.gridRow).toBe('')
    expect(oldRows[0].style.gridColumn).toBe('')

    await act(async () => root.unmount())
  })

  /**
   * jsdom 不做布局：scrollLeft / scrollTop 的赋值会被夹成 0，所以用访问器替身记「写到了哪个元素、
   * 写了多少」，直接验证同步逻辑本身（两栏内容同宽时浏览器不会夹，这一点由样式契约守着）。
   */
  function mockScrollBox(el: HTMLElement) {
    const state = { left: 0, top: 0 }
    Object.defineProperty(el, 'scrollLeft', {
      configurable: true,
      get: () => state.left,
      set: (v: number) => {
        state.left = v
      },
    })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => state.top,
      set: (v: number) => {
        state.top = v
      },
    })
    return state
  }

  it('一栏滚动，另一栏跟着走（横向 + 纵向）', async () => {
    const { host, root } = await mount()

    const oldPane = host.querySelector('.diff-pane--old') as HTMLElement
    const newPane = host.querySelector('.diff-pane--new') as HTMLElement
    const oldState = mockScrollBox(oldPane)
    const newState = mockScrollBox(newPane)

    // 右栏滚到某处 → 左栏跟上（两个方向都得通：用户可能滚任意一栏）
    newState.left = 420
    newState.top = 800
    await act(async () => {
      newPane.dispatchEvent(new Event('scroll'))
    })
    expect(oldState.left).toBe(420)
    expect(oldState.top).toBe(800)

    oldState.left = 40
    oldState.top = 100
    await act(async () => {
      oldPane.dispatchEvent(new Event('scroll'))
    })
    expect(newState.left).toBe(40)
    expect(newState.top).toBe(100)

    await act(async () => root.unmount())
  })
})

/** 行号刻意取 11/22/33：与正文不同，好断言「复制出来的东西里没有行号」 */
const MENU_ROWS: SideBySideRow[] = [
  {
    type: 'equal',
    leftLineNo: 11,
    rightLineNo: 11,
    left: [{ type: 'equal', value: 'AAA' }],
    right: [{ type: 'equal', value: 'AAA' }],
  },
  {
    type: 'removed',
    leftLineNo: 22,
    rightLineNo: null,
    left: [{ type: 'removed', value: 'BBB' }],
    right: [],
  },
  {
    type: 'added',
    leftLineNo: null,
    rightLineNo: 33,
    left: [],
    right: [{ type: 'added', value: 'CCC' }],
  },
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

  it('复制出来的是真实内容：行内换行标记 ↵ 不进剪贴板', async () => {
    const rows: SideBySideRow[] = [
      {
        type: 'modified',
        leftLineNo: 1,
        rightLineNo: 1,
        left: [{ type: 'equal', value: 'ab' }],
        right: [
          { type: 'equal', value: 'a' },
          { type: 'added', value: NL_MARK },
        ],
      },
      {
        type: 'equal',
        leftLineNo: null,
        rightLineNo: 2,
        left: [{ type: 'equal', value: 'b' }],
        right: [{ type: 'equal', value: 'b' }],
      },
    ]
    const { host, root } = await mount(rows)
    expect(host.querySelector('.diff-part--nl')).toBeTruthy()

    await rightClick(host.querySelector('.diff-line--new')!)
    await act(async () => {
      menuButtons()[1].click()
    })
    await act(async () => {
      menuButtons()[0].click()
    })

    // 右栏两行：第 1 行是 `a` + ↵ 标记、第 2 行是 `b`
    expect(copyText).toHaveBeenCalledWith('a\nb')
    expect(vi.mocked(copyText).mock.calls[0][0]).not.toContain(NL_MARK)

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

/**
 * 单栏（`singleSide`）—— 只有一侧有内容时（git 里的删除 / 新增 / 未合并）只画那一栏。
 *
 * 错了也看不出来的那条：留着另一栏的表头，是同一句「新文件」对着空白。
 */
describe('SideBySideDiff 单栏', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
    vi.mocked(copyText).mockClear()
  })

  it('singleSide="old"（删除）：只画原文件那一栏，新文件那一栏连表头一起不画', async () => {
    const { host, root } = await mount(ROWS, 'old')

    const rootEl = host.querySelector('.diff-side-by-side') as HTMLElement
    expect(rootEl.classList.contains('is-single')).toBe(true)
    expect(host.querySelectorAll('.diff-col-header').length).toBe(1)
    expect(host.querySelector('.diff-col-header--old')).toBeTruthy()
    expect(host.querySelector('.diff-col-header--new')).toBeNull()

    // 只剩左栏这一栏（铺满整宽靠 .is-single 的 flex-basis: 100%，见样式契约）
    const panes = [...host.querySelectorAll<HTMLElement>('.diff-pane')]
    expect(panes.length).toBe(1)
    expect(panes[0].classList.contains('diff-pane--old')).toBe(true)
    const halves = [...host.querySelectorAll<HTMLElement>('.diff-line')]
    expect(halves.length).toBe(ROWS.length)
    expect(host.querySelector('.diff-line--new')).toBeNull()
    expect(halves.every((el) => el.classList.contains('diff-line--old'))).toBe(true)

    await act(async () => root.unmount())
  })

  it('singleSide="new"（新增 / 未跟踪）：只画新文件那一栏', async () => {
    const { host, root } = await mount(ROWS, 'new')

    expect(host.querySelector('.diff-col-header--old')).toBeNull()
    expect(host.querySelector('.diff-col-header--new')).toBeTruthy()
    expect(host.querySelector('.diff-line--old')).toBeNull()

    const panes = [...host.querySelectorAll<HTMLElement>('.diff-pane')]
    expect(panes.length).toBe(1)
    expect(panes[0].classList.contains('diff-pane--new')).toBe(true)
    const halves = [...host.querySelectorAll<HTMLElement>('.diff-line')]
    expect(halves.length).toBe(ROWS.length)
    expect(halves.every((el) => el.classList.contains('diff-line--new'))).toBe(true)

    await act(async () => root.unmount())
  })

  it('右键落在单栏外（根节点 / 空白）时「全选」指向唯一那一栏，而不是写死的原文件', async () => {
    const { host, root } = await mount(MENU_ROWS, 'new')

    await rightClick(host.querySelector('.diff-side-by-side')!)
    expect(menuLabels()).toEqual(['复制', '全选新文件'])

    await act(async () => {
      menuButtons()[1].click()
    })
    await act(async () => {
      menuButtons()[0].click()
    })
    expect(copyText).toHaveBeenCalledWith(NEW_TEXT)

    await act(async () => root.unmount())
  })

  it('样式契约：单栏那一栏铺满整宽，且不再画左栏的列界线', () => {
    // 单栏只靠这个类名生效；规则被写错 / 被覆盖时那栏只会占半边（编译期、tsc 都不报）
    const css = diffCss()
    expect(css).toMatch(
      /\.diff-side-by-side\.is-single\s+\.diff-pane\s*\{[^}]*flex-basis:\s*100%/, 
    )
    expect(css).toMatch(
      /\.diff-side-by-side\.is-single\s+\.diff-pane--old\s*\{[^}]*border-right:\s*none/,
    )
  })

  it('样式契约：两栏各占一半、各带一条横向滚动条，栏内宽度由 --diff-max-ch 给出', () => {
    // 这几条是「两栏等宽 + 各滚各的」的全部依据，改错任何一条都不会报错、但界面完全不是那么回事：
    // - 两栏各占一半（flex: 0 0 50%）而不是「各按内容宽」：否则超长行一来就一栏铺满、另一栏一条缝；
    // - 滚动落到栏里（.diff-body 自己不再滚）：外层再叠一层 overflow: auto 会把两栏的滚动条废掉；
    // - 栏内内容宽度 = max(100%, 最长行)：宽度给不出时超长行会被裁掉；
    // - .diff-code 不折行（pre）：折行会把超长行挤在同一栏的几行里，看着像与下面几行互相覆盖；
    // - 兜底用 clip 不能用 hidden：hidden 会把这一格变成滚动容器，sticky 行号就再也不滚了；
    // - 屏外行靠 content-visibility 跳过布局（大文件的关键），**必须**同时给
    //   contain-intrinsic-height，否则行高塌成 min-height（实测 18.6px → 18px），总高跟着错。
    const css = diffCss()
    expect(css).toMatch(
      /\.diff-body\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/,
    )
    expect(css).toMatch(/\.diff-pane\s*\{[^}]*flex:\s*0\s+0\s+50%[^}]*overflow:\s*auto/)
    expect(css).toMatch(/\.diff-pane-inner\s*\{[^}]*min-width:\s*max\(\s*100%/)
    // 左栏的纵向滚动条只留位置不留形（可视区里只该有一条纵滚动条）
    expect(css).toMatch(
      /\.diff-pane--old::-webkit-scrollbar-thumb:vertical[^{]*\{[^}]*background-color:\s*transparent/,
    )
    expect(css).toMatch(/\.diff-code\s*\{[^}]*white-space:\s*pre;/)
    expect(css).toMatch(/\.diff-code\s*\{[^}]*overflow:\s*clip;/)
    expect(css).not.toMatch(/\.diff-code\s*\{[^}]*overflow:\s*hidden/)
    expect(css).toMatch(
      /\.diff-line\s*\{[^}]*content-visibility:\s*auto[^}]*contain-intrinsic-height:\s*auto\s*calc\(/,
    )
    // 横向滚时行号 / 列头标签钉在栏的左边
    expect(css).toMatch(/\.diff-linenum\s*\{[^}]*position:\s*sticky/)
    expect(css).toMatch(/\.diff-col-header-label\s*\{[^}]*position:\s*sticky/)
  })
})
