/**
 * 右侧面板的「开始页」（`guide` 标签）与「工作区文件」标签。
 *
 * 五条被钉住的口径：
 * 1. **三扇门按固定顺序**：工作区文件 / 新建终端 / 浏览器 —— 顺序是界面契约的一部分，
 *    改顺序等于改用户肌肉记忆（参考实现用 `order` 10 / 20 / 30 表达同一件事）；
 * 2. **三个入口都必须是真的**：点下去要能打开对应的页面（禁用的只有「没有工作目录」那两个）；
 * 3. **没有工作区时「工作区文件」与「新建终端」禁用并说明原因**，而不是让人点进去读一句
 *    「未设置工作目录」；浏览器不依赖工作区，因此照常可点；
 * 4. **点胶囊 = 上报给宿主**（原地替换开始页的语义在 `tabs.ts::replacePageTab` / `replaceTabWith`，
 *    宿主那边做）；终端**不带 shell** 上报（= 上次用的 = 后端默认），弹类型菜单的是
 *    标题后面那颗单独的 ▾ —— 一个按钮里不能再塞一个按钮；
 * 5. **面板里的文件树是 `panel` 变体**：单击文件就打开（左侧栏仍是双击）。
 *
 * 文件树本身换成桩：这里只验「容器把它摆在哪、传了什么」，真实树语义在
 * `workspace-tree-*` 那组用例里。
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SidePanel from '@/ui/pages/chat/components/side-panel'
import {
  browserTab,
  pageTab,
  terminalTab,
  type SidePanelTab,
} from '@/ui/pages/chat/components/side-panel/tabs'

const { messageBoxMock } = vi.hoisted(() => ({ messageBoxMock: vi.fn() }))

// 显式告诉 React 这是 act 环境（否则每次 `act()` 都会打一条警告）
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/ui/components/shared/MessageBox', () => ({
  MessageBox: { propt: messageBoxMock },
}))
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
    isEnabled: vi.fn(() => false),
    getSelectedConfig: vi.fn(() => undefined),
    getSelectedCommand: vi.fn(() => ''),
    openFile: vi.fn(() => Promise.resolve({ ok: true })),
    openWithConfig: vi.fn(() => Promise.resolve({ ok: true })),
  },
}))

/** 网页面板换成桩：只验容器把它摆在哪、传了什么（真实地址校验 / 历史在 `browser-pane.test.tsx`） */
vi.mock('@/ui/pages/chat/components/side-panel/browser/BrowserPane', () => ({
  default: (props: {
    initialUrl: string
    onNavigate?: (url: string) => void
    onClose: () => void
  }) => (
    <div className="stub-browser-pane" data-url={props.initialUrl}>
      <button
        type="button"
        className="stub-browser-nav"
        onClick={() => props.onNavigate?.('https://b.com/')}>
        nav
      </button>
      <button type="button" className="stub-browser-close" onClick={props.onClose}>
        x
      </button>
    </div>
  ),
}))

/** 用户终端换成桩：真实面板会把 xterm / 轮询命令拉进来，而这些用例不需要 */
vi.mock('@/ui/pages/chat/components/terminal/UserTerminal', () => ({
  default: (props: {
    termId: string
    shell: string
    active: boolean
    onClose: () => void
  }) => (
    <div
      className="user-terminal-pane"
      data-term-id={props.termId}
      data-shell={props.shell}
      data-active={String(props.active)}>
      <button type="button" className="stub-user-terminal-close" onClick={props.onClose}>
        x
      </button>
    </div>
  ),
}))

/** 文件面板换成桩：真实面板会把 monaco（codicon.css）拉进来，而这些用例不需要它 */
vi.mock('@/ui/pages/chat/components/workspace-file', () => ({
  default: () => <div className="workspace-file-panel" />,
}))

/** 文件树换成桩：只验容器给它的 `variant` / 回调（真实树会真的 invoke `list_directory`） */
vi.mock('@/ui/pages/chat/components/sidebar/workspace-tree', () => ({
  default: (props: {
    variant?: string
    onOpenFile: (path: string) => void
    onAttachPaths: (paths: string[]) => void
  }) => (
    <div className="workspace-tree" data-variant={props.variant ?? 'sidebar'}>
      <button
        type="button"
        className="stub-tree-open"
        onClick={() => props.onOpenFile('E:/repo/src/a.ts')}>
        open
      </button>
    </div>
  ),
}))

let root: ReturnType<typeof createRoot> | null = null
const picked: string[] = []
/** 与 `picked` 一一对应：点终端时上报的 shell id（从类型菜单选的那种） */
const pickedShells: Array<string | undefined> = []
const openedPaths: string[] = []
const navigations: Array<[string, string]> = []
const guideOpens: number[] = []
const collapses: number[] = []
const closed: string[] = []
/** 面板占满态的上报历史（宿主据此藏 / 放回聊天区） */
const expandedStates: boolean[] = []

async function renderPanel(
  tabs: SidePanelTab[],
  opts: { workspaceReady?: boolean; loadShells?: () => Promise<any[]> } = {},
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
          activeId={tabs[0]?.id ?? null}
          onActiveChange={() => {}}
          onCloseTab={(id) => closed.push(id)}
          onOpenGuide={() => guideOpens.push(1)}
          onCollapse={() => collapses.push(1)}
          onPickGuide={(kind, shell) => {
            picked.push(kind)
            pickedShells.push(shell)
          }}
          guideWorkspaceReady={opts.workspaceReady ?? true}
          loadTerminalShells={opts.loadShells}
          onOpenPath={(path) => openedPaths.push(path)}
          onAttachPaths={() => {}}
          onExpandedChange={(v) => expandedStates.push(v)}
          onBrowserNavigate={(id, url) => navigations.push([id, url])}
        />
      </>,
    )
  })
}

const entries = () => [...document.querySelectorAll<HTMLElement>('.panel-guide-entry')]
/** 整行（布局容器）：验顺序 / 文案 / 键帽时用它 */
const entryOf = (kind: string) =>
  document.querySelector<HTMLElement>(`.panel-guide-entry[data-guide-entry="${kind}"]`)
/** 主操作那层（铺满整行的真按钮）：点它 = 直接开默认那种 */
const hitOf = (kind: string) =>
  entryOf(kind)?.querySelector<HTMLButtonElement>('.panel-guide-entry-hit') ?? null

beforeAll(() => {
  // jsdom 没布局：容器量可用宽度时会拿 0 → 退回 DEFAULT_WIDTH，不影响这里的断言
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, right: 900, width: 900, top: 0, bottom: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  picked.length = 0
  pickedShells.length = 0
  openedPaths.length = 0
  navigations.length = 0
  guideOpens.length = 0
  collapses.length = 0
  closed.length = 0
  expandedStates.length = 0
  messageBoxMock.mockReset()
  messageBoxMock.mockResolvedValue(true)
})

it('开始页：三扇门按「文件 / 终端 / 浏览器」排，键帽与描述都在', async () => {
  await renderPanel([pageTab('guide')])

  expect(entries().map((el) => el.dataset.guideEntry)).toEqual([
    'files',
    'terminal',
    'browser',
  ])
  const files = entryOf('files')!
  expect(hitOf('files')!.disabled).toBe(false)
  expect(files.textContent).toContain('工作区文件')
  expect(files.textContent).toContain('浏览当前对话工作区的文件')
  // 键帽来自命令表（primary 在 Windows 下是 Ctrl），不是写死的文本
  expect([...files.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
    'Ctrl',
    'Shift',
    'E',
  ])
  // 一扇门里绝不能出现「按钮嵌按钮」：HTML 不允许，解析器会把外层提前闭合
  expect(document.querySelectorAll('.panel-guide-entry button button')).toHaveLength(0)
})

it('开始页：终端与浏览器都接入了（可点 + 键帽从命令表取）', async () => {
  await renderPanel([pageTab('guide')])

  const terminal = entryOf('terminal')!
  expect(hitOf('terminal')!.disabled).toBe(false)
  expect(terminal.textContent).not.toContain('即将支持')
  expect([...terminal.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
    'Ctrl',
    '`',
  ])

  // 浏览器：现在真的会开一个网页标签，键帽同样来自命令表（Ctrl+T）
  const browser = entryOf('browser')!
  expect(hitOf('browser')!.disabled).toBe(false)
  expect(browser.textContent).not.toContain('即将支持')
  expect([...browser.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
    'Ctrl',
    'T',
  ])

  await act(async () => {
    hitOf('terminal')!.click()
    hitOf('browser')!.click()
  })
  expect(picked).toEqual(['terminal', 'browser'])
  // 整行点击 = 不开菜单（类型菜单归标题后面那颗 ▾，见 `terminal-shells.test.tsx`）
  expect(document.querySelectorAll('.context-menu')).toHaveLength(0)
  expect(pickedShells).toEqual([undefined, undefined])
})

it('开始页：宿主接了类型列表时，整行直开默认那种（菜单归标题后那颗 ▾）', async () => {
  await renderPanel([pageTab('guide')], {
    loadShells: async () => [
      { id: 'powershell', available: true, default: true, hint: null },
      { id: 'cmd', available: true, default: false, hint: null },
      { id: 'gitbash', available: false, default: false, hint: '没找到 bash.exe' },
    ],
  })

  // 有类型列表 ≠ 每次都得先挑一次：整行点下去照旧直开（宿主按上次用的 / 后端默认开）
  await act(async () => {
    hitOf('terminal')!.click()
  })
  expect(document.querySelectorAll('.context-menu-item')).toHaveLength(0)
  expect(picked).toEqual(['terminal'])
  expect(pickedShells).toEqual([undefined])
  // ▾ 在（可挑类型），但它是文案后面单独一颗按钮
  expect(entryOf('terminal')!.querySelector('.panel-guide-entry-caret')).not.toBeNull()
})

it('开始页：没有工作区时「新建终端」也禁用（终端的工作目录就是会话工作区）', async () => {  await renderPanel([pageTab('guide')], {
    workspaceReady: false,
    // 接上类型列表：连 ▾ 也得跟着禁用（没工作目录时开终端本身就不成立）
    loadShells: async () => [{ id: 'cmd', available: true, default: true, hint: null }],
  })

  const terminal = entryOf('terminal')!
  expect(hitOf('terminal')!.disabled).toBe(true)
  expect(terminal.textContent).toContain('此对话未设置工作区目录。')
  // 浏览器不依赖工作目录：照常可点
  expect(hitOf('browser')!.disabled).toBe(false)
  await act(async () => hitOf('terminal')!.click())
  expect(picked).toEqual([])
  // 连 ▾ 一起禁用：没工作目录时开终端本身就不成立
  const caret = terminal.querySelector<HTMLButtonElement>('.panel-guide-entry-caret')
  expect(caret).not.toBeNull()
  expect(caret!.disabled).toBe(true)
  await act(async () => caret!.click())
  expect(document.querySelectorAll('.context-menu-item')).toHaveLength(0)
  expect(picked).toEqual([])
})

it('开始页：点「工作区文件」把语义上报宿主（原地替换在宿主 / tabs.ts 那边做）', async () => {
  await renderPanel([pageTab('guide')])

  await act(async () => hitOf('files')!.click())
  expect(picked).toEqual(['files'])
})

it('开始页：没有工作区时「工作区文件」禁用，并把原因写在描述上', async () => {
  await renderPanel([pageTab('guide')], { workspaceReady: false })

  const files = entryOf('files')!
  expect(hitOf('files')!.disabled).toBe(true)
  expect(files.textContent).toContain('此对话未设置工作区目录。')
  await act(async () => hitOf('files')!.click())
  expect(picked).toEqual([])
})

it('开始页标签：标题是「开始页」，图标与关闭按钮都在', async () => {
  await renderPanel([pageTab('guide')])

  const tab = document.querySelector<HTMLElement>('.side-panel-tab')!
  expect(tab.textContent).toContain('开始页')
  expect(tab.querySelector('.side-panel-tab-icon.is-page')).not.toBeNull()
  expect(tab.querySelector('.side-panel-tab-close')).not.toBeNull()
})

it('标签栏：「+」开开始页、全屏居中、✕ 收起面板，各自只上报一次', async () => {
  await renderPanel([pageTab('files')])

  const actions = [...document.querySelectorAll<HTMLButtonElement>('.side-panel-tabbar-action')]
  expect(actions.map((el) => el.getAttribute('aria-label'))).toEqual([
    '新标签页',
    '全屏',
    '收起右侧栏',
  ])
  await act(async () => {
    actions[0].click()
    actions[2].click()
  })
  expect(guideOpens).toHaveLength(1)
  expect(collapses).toHaveLength(1)
})

it('全屏：点一下铺满整块可用宽度（聊天区交给宿主藏），再点一下回到原来的宽度', async () => {
  // 量到的可用宽度是 900（见 beforeAll 的 getBoundingClientRect），定宽落在 450
  await renderPanel([pageTab('files')])
  const panel = document.querySelector<HTMLElement>('.side-panel')!
  expect(panel.style.width).toBe('450px')
  expect(panel.classList.contains('is-full')).toBe(false)

  const fullBtn = () =>
    document.querySelector<HTMLButtonElement>('.side-panel-tabbar-action.is-fullscreen')!
  await act(async () => fullBtn().click())
  expect(panel.style.width).toBe('900px')
  expect(panel.classList.contains('is-full')).toBe(true)
  expect(fullBtn().getAttribute('aria-label')).toBe('退出全屏')
  expect(expandedStates[expandedStates.length - 1]).toBe(true)

  await act(async () => fullBtn().click())
  expect(panel.style.width).toBe('450px')
  expect(panel.classList.contains('is-full')).toBe(false)
  expect(expandedStates[expandedStates.length - 1]).toBe(false)
})

it('工作区文件标签：容器把树按 panel 变体渲染，单击文件即上报打开', async () => {  await renderPanel([pageTab('files')])

  const tree = document.querySelector<HTMLElement>('.side-panel-files .workspace-tree')
  expect(tree).not.toBeNull()
  expect(tree!.dataset.variant).toBe('panel')

  await act(async () => {
    tree!.querySelector<HTMLButtonElement>('.stub-tree-open')!.click()
  })
  expect(openedPaths).toEqual(['E:/repo/src/a.ts'])
})

it('终端标签：标题带序号、图标是终端，容器把 id / shell / active 交给面板（不再传 cwd / pid）', async () => {
  const tab = terminalTab({
    termId: 'term_7',
    sessionId: 's1',
    shell: 'powershell',
    cwd: 'E:/repo',
    pid: 4242,
    index: 2,
  })
  await renderPanel([tab])

  const label = document.querySelector<HTMLElement>('.side-panel-tab')!
  expect(label.textContent).toContain('终端 2')
  expect(label.querySelector('.side-panel-tab-icon.is-page')).not.toBeNull()

  const pane = document.querySelector<HTMLElement>('.user-terminal-pane')!
  expect(pane.dataset.termId).toBe('term_7')
  expect(pane.dataset.shell).toBe('powershell')
  // 面板不再接收工作目录 / pid：cwd 只在标签 tooltip 上（少占一行高度）
  expect(pane.dataset.cwd).toBeUndefined()
  expect(pane.dataset.pid).toBeUndefined()
  // 工作目录没丢：它现在只在标签的 tooltip 上（`shell · cwd`）
  expect(
    label.querySelector('.side-panel-tab-btn')!.getAttribute('title'),
  ).toContain('E:/repo')
  // 唯一标签 = 激活的那个（切走时才传 false）
  expect(pane.dataset.active).toBe('true')

  // 面板头部的 ✕ 与标签栏的 × 走同一条路（关终端由宿主负责杀进程树）
  await act(async () => {
    pane.querySelector<HTMLButtonElement>('.stub-user-terminal-close')!.click()
  })
  expect(closed).toEqual(['terminal:term_7'])
})

it('网页标签：标题取主机名、图标是地球，导航后上报宿主（截图里的地址写回标签）', async () => {
  const tab = browserTab({ seq: 3, url: 'https://docs.rs/tokio' })
  await renderPanel([tab])

  const label = document.querySelector<HTMLElement>('.side-panel-tab')!
  expect(label.textContent).toContain('docs.rs')
  expect(label.querySelector('.side-panel-tab-icon.is-page')).not.toBeNull()

  const pane = document.querySelector<HTMLElement>('.stub-browser-pane')!
  expect(pane.dataset.url).toBe('https://docs.rs/tokio')

  // 面板里导航 → 容器把 (id, url) 上报给宿主（宿主更新标签标题）
  await act(async () => {
    pane.querySelector<HTMLButtonElement>('.stub-browser-nav')!.click()
  })
  expect(navigations).toEqual([['browser:3', 'https://b.com/']])

  await act(async () => {
    pane.querySelector<HTMLButtonElement>('.stub-browser-close')!.click()
  })
  expect(closed).toEqual(['browser:3'])
})

it('网页标签（空白页）：没有地址时标题退回「浏览器」', async () => {
  await renderPanel([browserTab({ seq: 1 })])
  const label = document.querySelector<HTMLElement>('.side-panel-tab')!
  expect(label.textContent).toContain('浏览器')
})
