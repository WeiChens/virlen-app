/**
 * 右侧面板容器的口径（标签页 + 宽度）。
 *
 * 六条被钉住的行为：
 * 1. **切标签不卸载**：所有标签的内容一直在 DOM 里，只切 `hidden` ——
 *    卸载会把草稿 / 撤销栈 / 滚动位置一起抹掉（这是加标签页最容易踩的坑）；
 * 2. **关标签前确认**：有未保存草稿先问一句，干净就直接关（面板自己那颗关闭按钮
 *    已经确认过一次，走 `onCloseTab` 直通，不重复问）；
 * 3. **脏标记汇总**：任一标签脏就上报宿主（切会话 / 切工作目录要拦一下），
 *    标签关掉后顺手归零（否则「任一脏」会一直是 true）；
 * 4. **宽度归容器**：挂载时按「聊天区 + 面板」可用宽度的一半定宽，加标签 / 切标签不重算；
 *    拖宽**没有固定上限**，最多拖到面板占满（上限 = 可用宽度）；
 * 5. **占满**：聊天区被压到不足 450px（`CHAT_MIN_WIDTH`）时面板铺满并通知宿主藏起聊天区，卸载时恢复；
 * 6. **拖标签换顺序**：用鼠标事件（HTML5 拖拽在 `dragDropEnabled: true` 下收不到，§11.8），
 *    被拖的标签跟着指针（内联 `transform`），拖动中就地预览、松手才上报一次最终下标
 *    （下标口径见 `tabs.ts::moveTab`）；**内容块按打开顺序排，不跟着标签排序** —— 挪 DOM 会重连
 *    子树的 effect，`@monaco-editor/react` 会把编辑器误 dispose 再 `setModel` 上去。
 * 7. **别的会话的标签靠 `parkedTabs` 一直挂着**（不显示、不进标签栏）：切会话不清状态的
 *    实现就是「从来没卸载过」，所以切过去再切回来，草稿 / 撤销栈 / 终端屏幕都是原样；
 *    脏标记仍按标签记，但**上报给宿主的只算本会话**（否则后台会话的草稿会拦住眼前的操作）。
 * 8. **但盯着磁盘 / 目录的只有一个**：常驻挂载 ≠ 常驻订阅。文件面板与文件树只在
 *    `active`（= 当前激活标签 **且** 面板没收起）时才订 watcher —— 否则藏着的那批标签
 *    各盯一个父目录，一次落盘换来十几次整文件重读（见 `workspace-file-watch` 用例）。
 *
 * 文件面板本身被替换成桩：这里只验容器怎么摆它、怎么汇总它，真实文件语义在
 * `workspace-file-panel` / `workspace-file-watch` 两个用例里。
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SidePanel from '@/ui/pages/chat/components/side-panel'
import {
  fileTab,
  pageTab,
  serviceTab,
  type SidePanelTab,
} from '@/ui/pages/chat/components/side-panel/tabs'
import { scopeTabs } from '@/ui/pages/chat/components/side-panel/sessions'

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
/** 文件面板换成桩：容器只依赖它的 props（path / hideTitle / sessionId / onDirtyChange / onClose） */
vi.mock('@/ui/pages/chat/components/workspace-file', async () => {
  const { useEffect } = await import('react')
  return {
    default: (props: {
      path: string
      hideTitle?: boolean
      sessionId?: string
      /** 此刻是不是「正在被看」：只有它才盯磁盘 */
      active?: boolean
      onDirtyChange?: (dirty: boolean) => void
      onReloadReady?: (reload: (() => void) | null) => void
      onClose: () => void
    }) => {
      // 真面板会把「刷新」登记给容器（标签右键菜单里的那一项），这里同样登记一份可断言的
      useEffect(() => {
        props.onReloadReady?.(() => reloadCalls.push(props.path))
        return () => props.onReloadReady?.(null)
      }, [])
      return (
        <div
          className="workspace-file-panel"
          data-path={props.path}
          data-session={props.sessionId ?? ''}
          data-active={String(props.active)}
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
      )
    },
  }
})

/**
 * 工作区树换成桩：这里只验容器传下去的 `active`（该不该盯目录）与 `sessionId`
 *（树根用哪个会话）；树自己的监听口径在 `sidebar-dir-watch` 用例里。
 */
vi.mock('@/ui/pages/chat/components/sidebar/workspace-tree', () => ({
  default: (props: { variant?: string; sessionId?: string; active?: boolean }) => (
    <div
      className="stub-tree"
      data-variant={props.variant ?? ''}
      data-session={props.sessionId ?? ''}
      data-active={String(props.active)}
    />
  ),
}))

/** 服务终端换成桩：容器只验「标签长什么样 / active 怎么传」，真实终端语义在 `service-terminal.test.tsx` */
vi.mock('@/ui/pages/chat/components/service/ServiceTerminal', () => ({
  default: (props: {
    sessionId: string
    serviceId: string
    name: string
    sessionLabel?: string
    active: boolean
    onClose?: () => void
  }) => (
    <div
      className="service-console-pane"
      data-service={`${props.sessionId}:${props.serviceId}`}
      data-name={props.name}
      data-session-label={props.sessionLabel ?? ''}
      data-active={String(props.active)}>
      <button type="button" className="stub-service-close" onClick={props.onClose}>
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
/** 拖标签换顺序：松手时上报的（id, 最终下标） */
const movedTabs: [string, number][] = []
/** 标签右键「刷新」：转发到了哪个面板（记路径） */
const reloadCalls: string[] = []
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
function onMoveTab(id: string, toIndex: number) {
  movedTabs.push([id, toIndex])
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
const TAB_D = fileTab('E:/repo/src/d.ts')
const TAB_SVC = serviceTab({
  sessionId: 's1',
  serviceId: 'svc_1',
  name: 'dev',
})

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
  opts: {
    batch?: boolean
    parked?: SidePanelTab[]
    sessionId?: string
    collapsed?: boolean
  } = {},
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
          // 别的会话挂着的标签：内容一直挂着，不显示、不进标签栏
          parkedTabs={opts.parked}
          sessionId={opts.sessionId}
          // 收起 = 宽度收 0，内容照旧挂着（这是「不丢状态」的实现）
          collapsed={opts.collapsed}
          onActiveChange={onActiveChange}
          onCloseTab={onCloseTab}
          // 不传时容器退化为逐个 onCloseTab（保留既有用例的断言口径）
          onCloseTabs={opts.batch ? onCloseTabs : undefined}
          onMoveTab={onMoveTab}
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
    // 标签在 jsdom 里没布局：按「第几个」给假矩形（宽 100 + 间距 2），拖拽用例靠它算中线
    if (this.classList.contains('side-panel-tab')) {
      const index = [...document.querySelectorAll('.side-panel-tab')].indexOf(this)
      if (index >= 0) return fakeRect(index * 102, 100)
    }
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
  movedTabs.length = 0
  reloadCalls.length = 0
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

  // 整块面板重新打开（新会话）：按那时的可用宽度重算（1000 的一半 = 500，留给聊天区 500 ≥ 450）
  layout = { available: 1000, inset: 260 }
  await renderPanel([TAB_A], TAB_A.id)
  expect(panel().style.width).toBe('500px')
})

/** 聊天区连 450 都留不住：面板占满，并通知宿主把聊天区先藏起来 */
it('聊天区不足 450px：面板占满，且通知宿主藏起聊天区', async () => {
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

/** 拖到聊天区不足 450 → 面板占满；往回拖过那条线 → 聊天区回来 */
it('拖到聊天区不足 450px 时面板占满，拖回来再恢复', async () => {
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
  // 占满的判据是 state 里的 width：拖动中面板跟手（不铺满），松手才真的吃掉整块宽度
  expect(panel().style.width).toBe('750px')
  expect(expandedReports[expandedReports.length - 1]).toBe(true)

  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: right - 500 }))
  })
  expect(panel().classList.contains('is-full')).toBe(false)
  expect(panel().style.width).toBe('500px')
  expect(expandedReports[expandedReports.length - 1]).toBe(false)

  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
})

/**
 * 占满态（聊天区被藏起来）往回拖：必须真的能拖回来。
 * 两个坑：① 面板左缘这时正好压在左侧栏的拖拽条上（`chart-view.scss` 里 z-index 10、命中区 ±3px），
 * 手柄不抬高层级就收不到 mousedown；② 占满态曾固定上屏 `available`，前 450px
 * （`CHAT_MIN_WIDTH`）拖动毫无反馈。
 */
it('占满态往右拖：按下即跟手变窄，过了 450 那条线聊天区回来', async () => {
  layout = { available: 800, inset: 200 }
  await renderPanel([TAB_A], TAB_A.id)
  // 挂载时 400 宽，聊天区只剩 400（< 450）→ 直接占满
  expect(panel().classList.contains('is-full')).toBe(true)
  expect(panel().style.width).toBe('800px')

  const right = 1000 // inset 200 + 可用 800
  act(() => {
    document
      .querySelector('.side-panel-resizer')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  // 按下那一刻不跳：state 先对齐到眼前这条边
  expect(panel().style.width).toBe('800px')

  // 拖到 700 宽：聊天区只剩 100（仍不足 450），面板必须已经跟着变窄
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: right - 700 }))
  })
  expect(panel().style.width).toBe('700px')
  expect(panel().classList.contains('is-full')).toBe(true)

  // 拖到 350 宽：聊天区刚好 450（= 拖动下限）→ 占满态解除，聊天区回来
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: right - 350 }))
  })
  expect(panel().classList.contains('is-full')).toBe(false)
  expect(panel().style.width).toBe('350px')
  expect(expandedReports[expandedReports.length - 1]).toBe(false)

  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
  // 松手后不反弹
  expect(panel().style.width).toBe('350px')
})

/** 拖宽不设固定上限：能一路拖到「面板占满」（旧实现封顶 MIN(960, 72vw)） */
it('拖宽不设固定上限：能一路拖到面板占满', async () => {
  layout = { available: 2000, inset: 200 }
  await renderPanel([TAB_A], TAB_A.id)
  expect(panel().style.width).toBe('1000px')

  const right = 2200 // inset 200 + 可用 2000
  act(() => {
    document
      .querySelector('.side-panel-resizer')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: right - 1500 }))
  })
  // 1500 既超过旧常量 960，也超过 72vw（jsdom 窗口 1024 → 737）
  expect(panel().style.width).toBe('1500px')
  expect(panel().classList.contains('is-full')).toBe(false)

  // 过「聊天区只剩 200」那条线：拖动中仍跟手，松手后面板才真的吃掉整块宽度
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: right - 1800 }))
  })
  expect(panel().classList.contains('is-full')).toBe(true)
  expect(panel().style.width).toBe('1800px')

  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
  expect(panel().style.width).toBe('2000px')
})

/**
 * 拖标签换顺序：不能靠 HTML5 拖拽（`dragDropEnabled: true` 时页面收不到 drag / drop，§11.8），
 * 所以走鼠标事件；落点只看开始拖那一刻的中线快照，拖动中就地预览，松手才上报宿主。
 */
it('拖标签换顺序：拖动中就地重排，松手时上报最终下标', async () => {
  await renderPanel([TAB_A, TAB_B, TAB_C], TAB_A.id)
  const names = () =>
    tabsEls().map((el) => el.querySelector('.side-panel-tab-name')!.textContent)
  expect(names()).toEqual(['a.ts', 'b.ts', 'c.ts'])

  // 中线：A=50 / B=152 / C=254（见 beforeAll 里的假矩形）
  await act(async () => {
    tabsEls()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50 }))
  })
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }))
  })
  // 指针越过 B、C 的中线：被拖的 A 已经就位到最后
  expect(names()).toEqual(['b.ts', 'c.ts', 'a.ts'])
  const dragged = tabsEls()[2]
  expect(dragged.classList.contains('is-dragging')).toBe(true)
  // 标签跟着指针：位移直接写在元素 style 上，布局格子留在原处当「洞」
  expect(dragged.style.transform).toContain('translateX(')

  await act(async () => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
  expect(movedTabs).toEqual([[TAB_A.id, 2]])
  expect(dragged.classList.contains('is-dragging')).toBe(false)
  // 松手后标签回到自己的格子（位移只是拖动中的视觉效果）
  expect(dragged.style.transform).toBe('')

  // 宿主按上报的下标落库后重渲染：顺序保持（容器不在松手后自己回弹）
  await renderPanel([TAB_B, TAB_C, TAB_A], TAB_A.id)
  expect(names()).toEqual(['b.ts', 'c.ts', 'a.ts'])

  // 拖完那一下 click（指针仍在被拖的标签上）是拖动的尾巴，不算「点标签」
  act(() => tabsEls()[2].querySelector<HTMLButtonElement>('.side-panel-tab-btn')!.click())
  expect(activeChanges).toEqual([])
  // 别的标签不受影响，照常激活
  act(() => tabsEls()[0].querySelector<HTMLButtonElement>('.side-panel-tab-btn')!.click())
  expect(activeChanges).toEqual([TAB_B.id])
})

/**
 * 重排标签**绝不能带着内容块一起重排**：挪 DOM 会让 React 重连/重跑那棵子树的 effect（dev 下还会双调用），
 * `@monaco-editor/react` 的 mount-only 清理会把编辑器 dispose 掉、紧接着的一次性 effect 又 `setModel`，
 * 于是报「InstantiationService has been disposed」。内容块按**打开顺序**排，与标签顺序无关。
 */
it('标签重排不改内容块的 DOM 顺序，也不重建内容块', async () => {
  const paths = () =>
    panes().map((el) => el.querySelector('.workspace-file-panel')?.getAttribute('data-path'))
  const tabNames = () =>
    tabsEls().map((el) => el.querySelector('.side-panel-tab-name')!.textContent)

  await renderPanel([TAB_A, TAB_B, TAB_C], TAB_A.id)
  expect(paths()).toEqual(['E:/repo/src/a.ts', 'E:/repo/src/b.ts', 'E:/repo/src/c.ts'])
  const before = panes()

  // 宿主按拖拽结果落库：标签变成 c / a / b
  await renderPanel([TAB_C, TAB_A, TAB_B], TAB_A.id)
  expect(tabNames()).toEqual(['c.ts', 'a.ts', 'b.ts'])
  // 内容块仍按打开顺序，而且是同一批 DOM 节点（没被重建）
  expect(paths()).toEqual(['E:/repo/src/a.ts', 'E:/repo/src/b.ts', 'E:/repo/src/c.ts'])
  const after = panes()
  expect(after).toHaveLength(before.length)
  before.forEach((el, i) => expect(el).toBe(after[i]))

  // 新开的标签追加在末尾（而不是插到“标签顺序”的位置）
  await renderPanel([TAB_C, TAB_A, TAB_B, TAB_D], TAB_D.id)
  expect(paths()).toEqual([
    'E:/repo/src/a.ts',
    'E:/repo/src/b.ts',
    'E:/repo/src/c.ts',
    'E:/repo/src/d.ts',
  ])
})

/** 没挪出阈值就松开：还是一次点击（标签不抖、不上报重排） */
it('按下后没挪出阈值：不算拖动，松手照常激活', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)
  await act(async () => {
    tabsEls()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50 }))
  })
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 52 }))
  })
  expect(tabsEls()[0].classList.contains('is-dragging')).toBe(false)
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
  expect(movedTabs).toEqual([])

  act(() => tabsEls()[0].querySelector<HTMLButtonElement>('.side-panel-tab-btn')!.click())
  expect(activeChanges).toEqual([TAB_A.id])
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
    '刷新',
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

/** 刷新不在面板头部了：右键标签才出现，且转发给**那个**标签的面板 */
it('标签右键「刷新」：转发给被右键的那个标签的面板', async () => {
  await renderPanel([TAB_A, TAB_B], TAB_A.id)

  await rightClickTab(1)
  expect(menuButton('刷新')!.disabled).toBe(false)
  await clickMenu('刷新')
  expect(reloadCalls).toEqual(['E:/repo/src/b.ts'])
})

/**
 * 服务终端是第二种内容（`kind: 'service'`）：标题就是服务名，内容和文件一样**一直挂着**，
 * 只把 `active` 传下去（终端面板靠它暂停轮询）。
 */
it('服务标签：标题是服务名，内容常挂只切 active / hidden', async () => {
  await renderPanel([TAB_A, TAB_SVC], TAB_A.id)

  expect(
    tabsEls().map((el) => el.querySelector('.side-panel-tab-name')!.textContent),
  ).toEqual(['a.ts', 'dev'])
  // 服务标签有自己的图标（套在 `.side-panel-tab-icon` 框里）
  expect(tabsEls()[1].querySelector('.side-panel-tab-icon.is-service')).not.toBeNull()
  expect(document.querySelector('.side-panel-tab-icon.is-service svg')).not.toBeNull()

  const pane = () => document.querySelector<HTMLElement>('.service-console-pane')!
  expect(pane().dataset.service).toBe('s1:svc_1')
  expect(pane().dataset.active).toBe('false')
  expect(panes()[1].hasAttribute('hidden')).toBe(true)

  // 切到服务标签：同一块 DOM，只翻转 hidden / active（卸载会把屏幕内容与已读偏移丢掉）
  const node = pane()
  await renderPanel([TAB_A, TAB_SVC], TAB_SVC.id)
  expect(pane()).toBe(node)
  expect(pane().dataset.active).toBe('true')
  expect(panes()[1].hasAttribute('hidden')).toBe(false)
  expect(panes()[0].hasAttribute('hidden')).toBe(true)

  // 头部那颗 ✕ 关的就是**这个**标签（服务终端没有草稿，直接走 onCloseTab）
  act(() =>
    pane().querySelector<HTMLButtonElement>('.stub-service-close')!.click(),
  )
  expect(closedIds).toEqual([TAB_SVC.id])
})

/** 服务终端没有路径 / 没有草稿：右键菜单不能出现文件类动作与「刷新」 */
it('服务标签的右键菜单：只有关闭类，没有文件类与刷新', async () => {
  await renderPanel([TAB_A, TAB_SVC], TAB_SVC.id)
  await rightClickTab(1)

  expect(menuLabels()).toEqual([
    '关闭',
    '关闭其他',
    '关闭右侧标签页',
    '关闭已保存',
    '全部关闭',
  ])
  // 服务终端没有草稿 → 算「已保存」，可以被「关闭已保存」一并关掉
  expect(menuButton('关闭已保存')!.disabled).toBe(false)

  // 文件标签那份菜单不受影响（文件类动作还在）
  await rightClickTab(0)
  expect(menuLabels()).toContain('编辑器打开')
  expect(menuButton('刷新')!.disabled).toBe(false)
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

/**
 * 别的会话挂着的标签（`parkedTabs`）：**这就是「切会话不清状态」的实现** ——
 * 它们的内容从来没被摘下来过（草稿 / 撤销栈 / 终端屏幕都活在子组件里），
 * 只是不在标签栏里、也不显示。
 */
it('别的会话的标签：内容一直挂着，但不进标签栏、也不显示', async () => {
  const PARKED = fileTab('E:/repo/src/parked.ts')
  await renderPanel([TAB_A], TAB_A.id, { parked: [PARKED] })

  expect(tabsEls().length).toBe(1)
  const parkedPane = panes().find(
    (pane) => pane.querySelector('[data-path="E:/repo/src/parked.ts"]'),
  )
  expect(parkedPane).toBeTruthy()
  expect(parkedPane!.hasAttribute('hidden')).toBe(true)
})

it('切会话 = 换一桶：同一份内容不卸载（草稿、滚动位置都还在）', async () => {
  await renderPanel([TAB_A], TAB_A.id, { parked: [TAB_B] })
  const before = stub('E:/repo/src/b.ts')
  expect(before).toBeTruthy()

  // 切到另一个会话：A 变 parked、B 变当前 —— DOM 节点必须是原来那一个（不能卸载重建）
  await renderPanel([TAB_B], TAB_B.id, { parked: [TAB_A] })
  expect(stub('E:/repo/src/b.ts')).toBe(before)
  expect(stub('E:/repo/src/a.ts')).toBeTruthy()
})

it('隐藏会话的脏不算「本会话有未保存草稿」；切回去它还是脏的', async () => {
  await renderPanel([TAB_A], TAB_A.id, { parked: [TAB_B] })
  dirtyReports.length = 0

  // 别的会话里那份脏：不能拦住当前会话的切工作目录 / 关标签
  act(() => stub('E:/repo/src/b.ts')!.querySelector<HTMLButtonElement>('.stub-dirty')!.click())
  expect(dirtyReports.every((dirty) => dirty === false)).toBe(true)
  expect(document.querySelector('.side-panel-tab-dirty')).toBeNull()

  // 切到它那一桶：脏状态跟着回来（标签小圆点 + 上报宿主 true）
  await renderPanel([TAB_B], TAB_B.id, { parked: [TAB_A] })
  expect(dirtyReports[dirtyReports.length - 1]).toBe(true)
  expect(document.querySelector('.side-panel-tab-dirty')).toBeTruthy()
})

it('文件面板拿的是**标签自己**的会话 id（挂着的那份不能跟着当前会话跑）', async () => {
  const own = scopeTabs('sess-1', [fileTab('E:/repo/src/a.ts')])[0]
  const other = scopeTabs('sess-2', [fileTab('E:/repo/src/b.ts')])[0]

  await renderPanel([own], own.id, { parked: [other], sessionId: 'sess-1' })
  expect(stub('E:/repo/src/a.ts')!.dataset.session).toBe('sess-1')
  expect(stub('E:/repo/src/b.ts')!.dataset.session).toBe('sess-2')
})

/**
 * 「盯磁盘」只给正在被看的那一个：内容常驻挂载是为了不丢草稿 / 终端屏幕，不是为了常驻订阅。
 * 藏着的那批标签各盯一个父目录，一次落盘就是十几次整文件重读（口径见 `workspace-file-watch`）。
 */
it('只有「当前标签 + 面板未收起」才让文件面板盯盘', async () => {
  const PARKED = fileTab('E:/repo/src/parked.ts')
  const activeOf = (path: string) => stub(path)!.dataset.active

  await renderPanel([TAB_A, TAB_B], TAB_A.id, { parked: [PARKED] })
  expect(activeOf('E:/repo/src/a.ts')).toBe('true')
  expect(activeOf('E:/repo/src/b.ts')).toBe('false')
  expect(activeOf('E:/repo/src/parked.ts')).toBe('false')

  // 切标签：上一个不盯了，这一个开始盯（同一块 DOM，没重建 → 草稿还在）
  const node = stub('E:/repo/src/b.ts')
  await renderPanel([TAB_A, TAB_B], TAB_B.id, { parked: [PARKED] })
  expect(activeOf('E:/repo/src/a.ts')).toBe('false')
  expect(activeOf('E:/repo/src/b.ts')).toBe('true')
  expect(stub('E:/repo/src/b.ts')).toBe(node)

  // 面板收起：连选中的那个也不再盯（内容还挂着，展开时它自己重读一次盘对齐）
  await renderPanel([TAB_A, TAB_B], TAB_B.id, { parked: [PARKED], collapsed: true })
  expect(activeOf('E:/repo/src/b.ts')).toBe('false')
  expect(stub('E:/repo/src/b.ts')).toBe(node)
})

it('工作区文件标签：树根按标签自己的会话，且只有被看着时才盯目录', async () => {
  const own = scopeTabs('sess-1', [pageTab('files')])[0]
  const other = scopeTabs('sess-2', [pageTab('files')])[0]
  const tree = (session: string) =>
    document.querySelector<HTMLElement>(`.stub-tree[data-session="${session}"]`)

  await renderPanel([own], own.id, { parked: [other], sessionId: 'sess-1' })
  expect(tree('sess-1')!.dataset.active).toBe('true')
  expect(tree('sess-1')!.dataset.variant).toBe('panel')
  // 别的会话挂着的那棵：不显示，也不订任何目录
  expect(tree('sess-2')!.dataset.active).toBe('false')

  await renderPanel([own], own.id, { parked: [other], sessionId: 'sess-1', collapsed: true })
  expect(tree('sess-1')!.dataset.active).toBe('false')
})
