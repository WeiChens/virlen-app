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
 *    宿主那边做）；
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
          onBrowserNavigate={(id, url) => navigations.push([id, url])}
        />
      </>,
    )
  })
}

const entries = () => [...document.querySelectorAll<HTMLButtonElement>('.panel-guide-entry')]
const entryOf = (kind: string) =>
  document.querySelector<HTMLButtonElement>(`.panel-guide-entry[data-guide-entry="${kind}"]`)

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
  expect(files.disabled).toBe(false)
  expect(files.textContent).toContain('工作区文件')
  expect(files.textContent).toContain('浏览会话工作区的文件')
  // 键帽来自命令表（primary 在 Windows 下是 Ctrl），不是写死的文本
  expect([...files.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
    'Ctrl',
    'Shift',
    'E',
  ])
})

it('开始页：终端与浏览器都接入了（可点 + 键帽从命令表取）', async () => {
  await renderPanel([pageTab('guide')])

  const terminal = entryOf('terminal')!
  expect(terminal.disabled).toBe(false)
  expect(terminal.textContent).not.toContain('即将支持')
  expect([...terminal.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
    'Ctrl',
    '`',
  ])

  // 浏览器：现在真的会开一个网页标签，键帽同样来自命令表（Ctrl+T）
  const browser = entryOf('browser')!
  expect(browser.disabled).toBe(false)
  expect(browser.textContent).not.toContain('即将支持')
  expect([...browser.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
    'Ctrl',
    'T',
  ])

  await act(async () => {
    terminal.click()
    browser.click()
  })
  expect(picked).toEqual(['terminal', 'browser'])
})

it('开始页：宿主接了类型列表时，点终端先弹菜单，选哪种就带哪个 id 上报', async () => {
  await renderPanel([pageTab('guide')], {
    loadShells: async () => [
      { id: 'powershell', available: true, default: true, hint: null },
      { id: 'cmd', available: true, default: false, hint: null },
      { id: 'gitbash', available: false, default: false, hint: '没找到 bash.exe' },
    ],
  })

  await act(async () => {
    entryOf('terminal')!.click()
  })
  const items = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')]
  expect(items.map((b) => b.textContent)).toEqual([
    'Windows PowerShell（默认）',
    '命令提示符',
    'Git Bash（未安装）',
  ])
  // 菜单开着的时候一个终端都不该开
  expect(picked).toEqual([])

  await act(async () => items[1].click())
  expect(picked).toEqual(['terminal'])
  expect(pickedShells).toEqual(['cmd'])
})

it('开始页：没有工作区时「新建终端」也禁用（终端的工作目录就是会话工作区）', async () => {  await renderPanel([pageTab('guide')], { workspaceReady: false })

  const terminal = entryOf('terminal')!
  expect(terminal.disabled).toBe(true)
  expect(terminal.textContent).toContain('这个会话没有工作区目录。')
  // 浏览器不依赖工作目录：照常可点
  expect(entryOf('browser')!.disabled).toBe(false)
  await act(async () => terminal.click())
  expect(picked).toEqual([])
})

it('开始页：点「工作区文件」把语义上报宿主（原地替换在宿主 / tabs.ts 那边做）', async () => {
  await renderPanel([pageTab('guide')])

  await act(async () => entryOf('files')!.click())
  expect(picked).toEqual(['files'])
})

it('开始页：没有工作区时「工作区文件」禁用，并把原因写在描述上', async () => {
  await renderPanel([pageTab('guide')], { workspaceReady: false })

  const files = entryOf('files')!
  expect(files.disabled).toBe(true)
  expect(files.textContent).toContain('这个会话没有工作区目录。')
  await act(async () => files.click())
  expect(picked).toEqual([])
})

it('开始页标签：标题是「开始页」，图标与关闭按钮都在', async () => {
  await renderPanel([pageTab('guide')])

  const tab = document.querySelector<HTMLElement>('.side-panel-tab')!
  expect(tab.textContent).toContain('开始页')
  expect(tab.querySelector('.side-panel-tab-icon.is-page')).not.toBeNull()
  expect(tab.querySelector('.side-panel-tab-close')).not.toBeNull()
})

it('标签栏：「+」开开始页、「»」收起面板，各自只上报一次', async () => {
  await renderPanel([pageTab('files')])

  const actions = [...document.querySelectorAll<HTMLButtonElement>('.side-panel-tabbar-action')]
  expect(actions.map((el) => el.getAttribute('aria-label'))).toEqual([
    '新标签页',
    '收起右侧栏',
  ])
  await act(async () => {
    actions[0].click()
    actions[1].click()
  })
  expect(guideOpens).toHaveLength(1)
  expect(collapses).toHaveLength(1)
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
