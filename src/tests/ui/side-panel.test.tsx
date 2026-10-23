/**
 * 右侧面板容器的口径（标签页 + 宽度）。
 *
 * 五条被钉住的行为：
 * 1. **切标签不卸载**：所有标签的内容一直在 DOM 里，只切 `hidden` ——
 *    卸载会把草稿 / 撤销栈 / 滚动位置一起抹掉（这是加标签页最容易踩的坑）；
 * 2. **关标签前确认**：有未保存草稿先问一句，干净就直接关（面板自己那颗关闭按钮
 *    已经确认过一次，走 `onCloseTab` 直通，不重复问）；
 * 3. **脏标记汇总**：任一标签脏就上报宿主（切会话 / 切工作目录要拦一下），
 *    标签关掉后顺手归零（否则「任一脏」会一直是 true）；
 * 4. **宽度归容器**：挂载时按「聊天区 + 面板」可用宽度的一半定宽，加标签 / 切标签不重算；
 * 5. **占满**：聊天区被压到不足 300px 时面板铺满并通知宿主藏起聊天区，卸载时恢复。
 *
 * 文件面板本身被替换成桩：这里只验容器怎么摆它、怎么汇总它，真实文件语义在
 * `workspace-file-panel` / `workspace-file-watch` 两个用例里。
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SidePanel from '@/ui/pages/chat/components/side-panel'
import { fileTab, type SidePanelTab } from '@/ui/pages/chat/components/side-panel/tabs'

const { messageBoxMock } = vi.hoisted(() => ({ messageBoxMock: vi.fn() }))

vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: messageBoxMock },
}))
/**
 * 标签右键菜单里的文件类动作会拉这几个能力（打开 / 编辑器打开 / 复制路径 / 提示）：
 * 本文件只验「菜单项在不在、对不对」，不真的落地动作 —— 那些在 `context-menu.test.tsx` 里。
 */
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
  useToast: (): unknown => ({ Toast: (): null => null, showToast: vi.fn() }),
}))
vi.mock('@/services/editor-service', () => ({
  editorService: {
    isEnabled: vi.fn(() => true),
    getSelectedConfig: vi.fn(() => undefined),
    getSelectedCommand: vi.fn(() => ''),
    openFile: vi.fn(() => Promise.resolve({ ok: true })),
    openWithConfig: vi.fn(() => Promise.resolve({ ok: true })),
  },
}))
/** 文件面板换成桩：容器只依赖它的 props（path / hideTitle / onDirtyChange / onClose） */
vi.mock('@/ui/pages/chat/components/workspace-file', () => ({
  default: (props: {
    path: string
    hideTitle?: boolean
    onDirtyChange?: (dirty: boolean) => void
    onClose: () => void
  }) => (
    <div
      className="workspace-file-panel"
      data-path={props.path}
      data-hide-title={String(!!props.hideTitle)}>
      <button type="button" className="stub-dirty" onClick={() => props.onDirtyChange?.(true)}>
        dirty
      </button>
      <button type="button" className="stub-clean" onClick={() => props.onDirtyChange?.(false)}>
        clean
      </button>
      <button type="button" className="stub-close" onClick={props.onClose}>
        close
      </button>
    </div>
  ),
}))

/** 稳定引用：容器里的 effect 依赖这几个回调，内联箭头会让它们每帧重跑 */
const activeChanges: string[] = []
const closedIds: string[] = []
/** 批量关闭（标签右键菜单）：一次回调带来一批 id */
const closedBatches: string[][] = []
const dirtyReports: boolean[] = []
const expandedReports: boolean[] = []

function onActiveChange(id: string) {
  activeChanges.push(id)
}
function onCloseTab(id: string) {
  closedIds.push(id)
}
function onCloseTabs(ids: string[]) {
  closedBatches.push(ids)
}
function onDirtyChange(dirty: boolean) {
  dirtyReports.push(dirty)
}
function onExpandedChange(expanded: boolean) {
  expandedReports.push(expanded)
}

const TAB_A = fileTab('E:/repo/src/a.ts')
const TAB_B = fileTab('E:/repo/src/b.ts')
const TAB_C = fileTab('E:/repo/src/c.ts')

;(globalThis as never as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: ReturnType<typeof createRoot> | null = null

/**
 * jsdom 没有布局引擎：容器宽度全靠 `getBoundingClientRect` 量。
 * 给「左侧栏 + 聊天区 + 面板」三个角色喂假尺寸；`layout = null` 时保持 jsdom 原本的零尺寸。
 */
let layout: { available: number; inset: number } | null = null
const realRect = Element.prototype.getBoundingClientRect

function fakeRect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 800,
    height: 800,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

/** 挂一个 `.chat-view`：聊天区 + 面板是同一行的兄弟（容器就这样量可用宽度） */
async function renderPanel(
  tabs: SidePanelTab[],
  activeId: string | null,
  opts: { batch?: boolean } = {},
) {
  if (!root) {
    const host = document.createElement('div')
    host.className = 'chat-view'
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <>
        <div className="chat-main" />
        <SidePanel
          tabs={tabs}
          activeId={activeId}
          onActiveChange={onActiveChange}
          onCloseTab={onCloseTab}
          // 不传时容器退化为逐个 onCloseTab（保留既有用例的断言口径）
          onCloseTabs={opts.batch ? onCloseTabs : undefined}
          onDirtyChange={onDirtyChange}
          onExpandedChange={onExpandedChange}
        />
      </>,
    )
  })
}

const panel = () => document.querySelector('.side-panel') as HTMLElement
const tabsEls = () =>
  [...document.querySelectorAll<HTMLElement>('.side-panel-tab')]
const panes = () => [...document.querySelectorAll<HTMLElement>('.side-panel-pane')]
const stub = (path: string) =>
  document.querySelector<HTMLElement>(`.workspace-file-panel[data-path="${path}"]`)

/** 菜单本体 portal 到 body：按文案取项，比按下标稳 */
const menuItems = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')]
const menuLabels = () => menuItems().map((el) => el.textContent)
const menuButton = (label: string) =>
  menuItems().find((el) => el.textContent === label) ?? null

/** 在某个标签上右键（标签栏是唯一会开菜单的地方） */
async function rightClickTab(index: number) {
  await act(async () => {
    tabsEls()[index].dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 120,
      }),
    )
  })
}

/** 点菜单里的某一项（动作可能带确认框，act 内把微任务跑完） */
async function clickMenu(label: string) {
  const button = menuButton(label)
  expect(button).not.toBeNull()
  await act(async () => {
    button!.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (!layout) return realRect.call(this)
    const { available, inset } = layout
    const right = inset + available
    if (this.classList.contains('chat-view')) return fakeRect(0, right)
    if (this.classList.contains('chat-main')) return fakeRect(inset, available)
    if (this.classList.contains('side-panel')) {
      const width = Number.parseFloat((this as HTMLElement).style.width) || 0
      return fakeRect(right - width, width)
    }
    return fakeRect(0, 0)
  }
})

beforeEach(() => {
  document.body.innerHTML = ''
  activeChanges.length = 0
  closedIds.length = 0
  closedBatches.length = 0
  dirtyReports.length = 0
  expandedReports.length = 0
  messageBoxMock.mockReset()
  messageBoxMock.mockResolvedValue(true)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  layout = null
})

it('每个标签一颗按钮，激活态靠 aria-selected；点别的标签上报宿主', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)

  expect(tabsEls().length).toBe(2)
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.side-panel-tab-btn')]
  expect(buttons.map((btn) => btn.textContent)).toEqual(['a.ts', 'b.ts'])
  expect(buttons[0].getAttribute('aria-selected')).toBe('true')
  expect(buttons[1].getAttribute('aria-selected')).toBe('false')

  act(() => buttons[1].click())
  expect(activeChanges).toEqual([TAB_B.id])
})

/**
 * 标签栏只有横向溢出（`overflow-y: hidden`）：纵向滚轮得自己接成横向滚动，否则标签一多
 * 就只能去够底下那条 4px 的滚动条。jsdom 不做布局（clientWidth / scrollWidth 恒 0），
 * 这里手动造出「内容比可视区宽」。
 */
it('标签栏溢出时：纵向滚轮被换算成横向滚动并吞掉', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)
  const bar = document.querySelector<HTMLElement>('.side-panel-tabs')!
  Object.defineProperty(bar, 'clientWidth', { value: 100, configurable: true })
  Object.defineProperty(bar, 'scrollWidth', { value: 300, configurable: true })

  const wheel = new WheelEvent('wheel', { deltaY: 60, cancelable: true, bubbles: true })
  bar.dispatchEvent(wheel)
  expect(wheel.defaultPrevented).toBe(true)
})

/** 反例：标签都放得下（jsdom 默认量到 0）时不能拦，滚轮该继续去滚外层 */
it('标签栏不溢出时：滚轮照常冒泡', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)
  const wheel = new WheelEvent('wheel', {
    deltaY: 60,
    cancelable: true,
    bubbles: true,
  })
  document.querySelector<HTMLElement>('.side-panel-tabs')!.dispatchEvent(wheel)
  expect(wheel.defaultPrevented).toBe(false)
})

it('切标签**不卸载**：两块内容都在 DOM，非激活那块只是 hidden', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)

  // 两块内容都在（草稿 / 撤销栈才活得下来），只有激活那块能看见
  expect(panes().length).toBe(2)
  expect(panes()[0].hasAttribute('hidden')).toBe(false)
  expect(panes()[1].hasAttribute('hidden')).toBe(true)
  // 内容拿到的是「标题在标签上」的那一版
  expect(stub('E:/repo/src/a.ts')!.dataset.hideTitle).toBe('true')

  await renderPanel([TAB_A, TAB_B], TAB_B.id)
  expect(panes()[0].hasAttribute('hidden')).toBe(true)
  expect(panes()[1].hasAttribute('hidden')).toBe(false)
  // 换激活不会把另一个的内容重建（同一个 DOM 节点还在）
  expect(stub('E:/repo/src/a.ts')).not.toBeNull()
})

it('干净标签点 ×：直接关，不弹确认', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)

  await act(async () => {
    tabsEls()[1].querySelector<HTMLButtonElement>('.side-panel-tab-close')!.click()
  })

  expect(messageBoxMock).not.toHaveBeenCalled()
  expect(closedIds).toEqual([TAB_B.id])
})

/** 面板自己那颗关闭按钮已经确认过一次（见 `workspace-file`）：容器这条路径不再问第二遍 */
it('面板自己的关闭按钮直通，不重复确认', async () => {
  await renderPanel([TAB_A], TAB_A.id)
  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-close')!.click())

  expect(messageBoxMock).not.toHaveBeenCalled()
  expect(closedIds).toEqual([TAB_A.id])
})

it('脏标签点 ×：先问；取消不关，确认才关', async () => {
  await renderPanel([TAB_A], TAB_A.id)
  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())

  messageBoxMock.mockResolvedValueOnce(false)
  await act(async () => {
    tabsEls()[0].querySelector<HTMLButtonElement>('.side-panel-tab-close')!.click()
  })
  expect(messageBoxMock).toHaveBeenCalledTimes(1)
  expect(closedIds).toEqual([])

  messageBoxMock.mockResolvedValueOnce(true)
  await act(async () => {
    tabsEls()[0].querySelector<HTMLButtonElement>('.side-panel-tab-close')!.click()
  })
  expect(closedIds).toEqual([TAB_A.id])
})

it('脏标记：标签上出圆点、并把「任一脏」报给宿主；标签关掉后归零', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)
  expect(dirtyReports[dirtyReports.length - 1]).toBe(false)

  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())
  expect(dirtyReports[dirtyReports.length - 1]).toBe(true)
  expect(tabsEls()[0].querySelector('.side-panel-tab-dirty')).not.toBeNull()
  expect(tabsEls()[1].querySelector('.side-panel-tab-dirty')).toBeNull()

  // 那个标签没了 → 脏状态跟着清（否则宿主会一直被拦着确认草稿）
  await renderPanel([TAB_B], TAB_B.id)
  expect(dirtyReports[dirtyReports.length - 1]).toBe(false)
})

it('脏了又干净：汇总值跟着回 false，不是一次脏就永远脏', async () => {
  await renderPanel([TAB_A], TAB_A.id)
  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())
  expect(dirtyReports[dirtyReports.length - 1]).toBe(true)

  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-clean')!.click())
  expect(dirtyReports[dirtyReports.length - 1]).toBe(false)
  expect(tabsEls()[0].querySelector('.side-panel-tab-dirty')).toBeNull()
})

/** 宽度口径：挂载时按「聊天区 + 面板」可用宽度的一半，加标签 / 切标签都不重算 */
it('宽度：按可用宽度的一半，切标签不重算（重开才重算）', async () => {
  layout = { available: 1200, inset: 260 }
  await renderPanel([TAB_A], TAB_A.id)
  expect(panel().style.width).toBe('600px')
  expect(panel().classList.contains('is-full')).toBe(false)

  // 再开一个标签：用户可能已经拖过宽度，这里不该被改回去
  await renderPanel([TAB_A, TAB_B], TAB_B.id)
  expect(panel().style.width).toBe('600px')

  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''

  // 整块面板重新打开（新会话）：按那时的可用宽度重算
  layout = { available: 800, inset: 260 }
  await renderPanel([TAB_A], TAB_A.id)
  expect(panel().style.width).toBe('400px')
})

/** 聊天区连 300 都留不住：面板占满，并通知宿主把聊天区先藏起来 */
it('聊天区不足 300px：面板占满，且通知宿主藏起聊天区', async () => {
  layout = { available: 500, inset: 260 }
  await renderPanel([TAB_A], TAB_A.id)

  expect(panel().classList.contains('is-full')).toBe(true)
  expect(panel().style.width).toBe('500px')
  expect(expandedReports[expandedReports.length - 1]).toBe(true)

  // 面板整个卸载（最后一个标签关掉）时要把聊天区放回来
  act(() => root?.unmount())
  root = null
  expect(expandedReports[expandedReports.length - 1]).toBe(false)
})

/** 拖到聊天区不足 300 → 面板占满；往回拖过那条线 → 聊天区回来 */
it('拖到聊天区不足 300px 时面板占满，拖回来再恢复', async () => {
  layout = { available: 1000, inset: 200 }
  await renderPanel([TAB_A], TAB_A.id)
  expect(panel().style.width).toBe('500px')

  const right = 1200 // inset 200 + 可用 1000
  act(() => {
    document
      .querySelector('.side-panel-resizer')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: right - 750 }))
  })
  expect(panel().classList.contains('is-full')).toBe(true)
  expect(panel().style.width).toBe('1000px')
  expect(expandedReports[expandedReports.length - 1]).toBe(true)

  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: right - 600 }))
  })
  expect(panel().classList.contains('is-full')).toBe(false)
  expect(panel().style.width).toBe('600px')
  expect(expandedReports[expandedReports.length - 1]).toBe(false)

  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
})

/**
 * 标签右键菜单（VS Code 口径）：关闭类动作都作用于「右键的那个标签」，与当前激活的是谁无关。
 * 顺序与禁用条件一并钉住 —— 最后一个标签还能点「关闭右侧标签页」就是 bug。
 */
it('标签右键：弹出关闭类 + 文件类菜单，禁用条件跟着位置走', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)
  await rightClickTab(0)

  expect(menuLabels()).toEqual([
    '关闭',
    '关闭其他',
    '关闭右侧标签页',
    '关闭已保存',
    '全部关闭',
    '编辑器打开',
    '在文件管理器中显示',
    '复制路径',
  ])
  // A 右边还有 B；两个标签也够「关闭其他」
  expect(menuButton('关闭右侧标签页')!.disabled).toBe(false)
  expect(menuButton('关闭其他')!.disabled).toBe(false)

  // 右键最后一个标签：右边没东西可关
  await rightClickTab(1)
  expect(menuButton('关闭右侧标签页')!.disabled).toBe(true)

  // 两个都脏 = 「关闭已保存」没得关
  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())
  act(() => stub('E:/repo/src/b.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())
  await rightClickTab(0)
  expect(menuButton('关闭已保存')!.disabled).toBe(true)
})

it('只有一个标签：「关闭其他」「关闭右侧标签页」都禁用', async () => {
  await renderPanel([TAB_A], TAB_A.id)
  await rightClickTab(0)

  expect(menuButton('关闭其他')!.disabled).toBe(true)
  expect(menuButton('关闭右侧标签页')!.disabled).toBe(true)
  expect(menuButton('关闭已保存')!.disabled).toBe(false)
  expect(menuButton('全部关闭')!.disabled).toBe(false)
})

/** 一次回调带一批 id（而不是逐个 onCloseTab）：宿主一次落库，激活态不会中途跳别处 */
it('关闭其他 / 关闭右侧 / 全部关闭：一次上报一批 id', async () => {
  await renderPanel([TAB_A, TAB_B, TAB_C], TAB_A.id, { batch: true })

  // 右键中间的 B：右侧只有 C
  await rightClickTab(1)
  await clickMenu('关闭右侧标签页')
  expect(closedBatches[closedBatches.length - 1]).toEqual([TAB_C.id])
  expect(closedIds).toEqual([])

  // 右键 A：其他 = B、C
  await rightClickTab(0)
  await clickMenu('关闭其他')
  expect(closedBatches[closedBatches.length - 1]).toEqual([TAB_B.id, TAB_C.id])

  // 任何位置点「全部关闭」都是全部（按标签栏顺序）
  await rightClickTab(2)
  await clickMenu('全部关闭')
  expect(closedBatches[closedBatches.length - 1]).toEqual([TAB_A.id, TAB_B.id, TAB_C.id])

  // 都是干净标签：一个字也不该问
  expect(messageBoxMock).not.toHaveBeenCalled()
})

/** 批量关里面夹着一个脏标签：只问一次，取消就一个都不关（不能关一半） */
it('批量关闭里有脏标签：只确认一次；取消则一个都不关', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id, { batch: true })
  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())

  messageBoxMock.mockResolvedValueOnce(false)
  await rightClickTab(1)
  await clickMenu('关闭其他')
  expect(messageBoxMock).toHaveBeenCalledTimes(1)
  expect(closedBatches).toEqual([])

  messageBoxMock.mockResolvedValueOnce(true)
  await rightClickTab(1)
  await clickMenu('关闭其他')
  expect(closedBatches).toEqual([[TAB_A.id]])
})

it('关闭已保存跳过脏标签；「关闭」只关右键的那个（脏的则要确认）', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id, { batch: true })
  act(() => stub('E:/repo/src/a.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())

  await rightClickTab(0)
  expect(menuButton('关闭已保存')!.disabled).toBe(false)
  await clickMenu('关闭已保存')
  expect(closedBatches[closedBatches.length - 1]).toEqual([TAB_B.id])
  // 干净的不用问
  expect(messageBoxMock).not.toHaveBeenCalled()

  await rightClickTab(0)
  await clickMenu('关闭')
  expect(closedBatches[closedBatches.length - 1]).toEqual([TAB_A.id])
  // A 是脏的：这一次要问
  expect(messageBoxMock).toHaveBeenCalledTimes(1)
})
