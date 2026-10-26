/**
 * 浏览器标签（右侧面板 kind = `browser`）与它的地址模型。
 *
 * 网页**不再走 iframe**：`X-Frame-Options: SAMEORIGIN`（virlen.cn 就是）对 iframe 是硬限制，
 * 浏览器只给一片空白；dsh 桌面端用 Electron `<webview>`、我们这里用 Tauri 的原生子 WebView，
 * 都是「独立浏览上下文」，那套响应头不适用（Rust 侧见 `src-tauri/src/browser_view.rs`）。
 *
 * 于是本文件钉住两件事：
 *
 * 一、**地址模型**（纯函数，和载体无关）
 * 1. 只放行 http / https：`javascript:` / `data:` / `file:` 一律拒绝；
 * 2. 带凭据的地址拒绝（`user:pass@` 会被写进标签标题 / 历史）；
 * 3. 无协议时补协议：本机 / 内网补 `http://`，其余补 `https://`；
 * 4. 地址规范化（`new URL().href`）：标签标题、视图地址共用同一个串。
 *
 * ⚠️ 这里**没有**面板侧历史模型，也不许加回来：后退 / 前进归 WebView2 自己的历史栈。
 * 曾经的合成历史靠「两跳间隔短」「又落回出发页」把重定向折成一条 —— 那是猜，猜错会删掉
 * 用户真去过的页面（快站点点两个链接能被并成一条；「登录后跳回原页」会被当成中转页）。
 * 参考实现 dsh 桌面端（`ElectronWebViewImpl`）同样只用原生 `canGoBack` / `goBack`。
 *
 * 二、**面板与原生视图的接线**（`browser-view` 在这里是 mock）
 * 5. 导航是命令：地址栏回车 → `navigate`；后退 / 前进 → **只发原生命令**，不另发导航；
 * 6. 页面回传的地址只用来**显示**（302 / 页内跳转 / 后退都不往历史里塞东西）；
 * 7. 后退 / 前进按钮的可用性只能来自 `location` 事件的 `canBack` / `canForward`；
 * 8. 视图的 rect 逐帧同步：不可见（切标签 / 收起面板，rect 为 0）只 `hide` 不销毁；
 * 9. 视图建不起来（非桌面环境 / 命令失败）必须给一张说明卡，而不是永久白框；
 * 10. 下载一律拦下：**不落盘**（Rust 侧取消），但用户必须看到一条提示与外部出口 ——
 *    静默下载正是这组用例要防的那个问题（原生视图没有浏览器那种下载栏）。
 * 11. 位置算的是**逻辑像素**：rect 是 CSS 像素，传给原生视图前要乘「已生效的界面缩放」
 *    （`setZoom(1.25)` 之后 1 CSS px 占 1.25 DIP），否则缩放后视图比占位小一圈、往左上收。
 * 12. **被 DOM 浮层盖住时要自己躲**：原生子窗口永远画在 HTML 之上，`z-index` 管不了它 ——
 *    设置页 / Modal 一打开，视图必须 `hide`，否则它把整个浮层盖住（还吃掉鼠标）。
 *    判据是占位中心点的 `elementFromPoint`（jsdom 不实现，这里打桩）。
 *
 * 真实网页能不能打开只能在真窗口里验；这里只钉「我们自己的逻辑」。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import BrowserPane from '@/ui/pages/chat/components/side-panel/browser/BrowserPane'
import { setAppliedZoomFactor } from '@/ui/hooks/applied-zoom'
import { settingsState } from '@/ui/store'
import { resetBrowserViewPolicy } from '@/ui/pages/chat/components/side-panel/browser/view-policy'
import type { BrowserViewEvent } from '@/infrastructure/browser/browser-view'
import {
  normalizeAddress,
  urlLabel,
} from '@/ui/pages/chat/components/side-panel/browser/url'

/* ------------------------------------------------------------------ 原生视图替身 */

const bridge = vi.hoisted(() => ({
  /** 桌面应用可用？（`false` = 浏览器调试 / jsdom，走「只在桌面应用里可用」那一支） */
  available: true,
  open: vi.fn<(label: string, url: string, bounds: unknown) => Promise<void>>(),
  apply: vi.fn<(label: string, bounds: unknown, visible: boolean) => Promise<void>>(),
  navigate: vi.fn<(label: string, url: string) => Promise<void>>(),
  reload: vi.fn<(label: string) => Promise<void>>(),
  history: vi.fn<(label: string, direction: 'back' | 'forward') => Promise<void>>(),
  close: vi.fn<(label: string) => Promise<void>>(),
  listeners: [] as ((event: BrowserViewEvent) => void)[],
}))

vi.mock('@/infrastructure/browser/browser-view', () => ({
  BROWSER_VIEW_EVENT: 'browser:navigate',
  hasBrowserView: () => bridge.available,
  openBrowserView: bridge.open,
  applyBrowserView: bridge.apply,
  navigateBrowserView: bridge.navigate,
  reloadBrowserView: bridge.reload,
  historyBrowserView: bridge.history,
  closeBrowserView: bridge.close,
  listenBrowserView: async (handler: (event: BrowserViewEvent) => void) => {
    bridge.listeners.push(handler)
    return () => {
      bridge.listeners = bridge.listeners.filter((item) => item !== handler)
    }
  },
}))

/* ------------------------------------------------------------------ rAF 手动挡 */

let frames: FrameRequestCallback[] = []
let frameId = 0
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  frames.push(callback)
  return ++frameId
})
vi.stubGlobal('cancelAnimationFrame', () => {})

/** 推进一帧（hook 每帧都会再注册下一帧，所以可以一帧一帧来） */
function runFrame() {
  const queue = frames
  frames = []
  for (const callback of queue) callback(0)
}

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/* ------------------------------------------------------------------ ResizeObserver 替身 */

/**
 * 真实环境靠 `ResizeObserver` 把「不可见 → 可见」的标签唤醒（看得见才逐帧跑，见
 * `use-native-view.ts` 的帧节奏）：这里手写一个替身，用例用 `wake()` 手动触发。
 */
let resizeObservers: { cb: ResizeObserverCallback; alive: boolean }[] = []
vi.stubGlobal(
  'ResizeObserver',
  class {
    private entry: { cb: ResizeObserverCallback; alive: boolean }
    constructor(cb: ResizeObserverCallback) {
      this.entry = { cb, alive: true }
      resizeObservers.push(this.entry)
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.entry.alive = false
    }
  },
)

/* ------------------------------------------------------------------ 挂载工具 */

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn(() => Promise.resolve()) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }))

let root: ReturnType<typeof createRoot> | null = null
let onNavigate: ReturnType<typeof vi.fn<(url: string) => void>>
let onTitle: ReturnType<typeof vi.fn<(title: string) => void>>
let onClose: ReturnType<typeof vi.fn<() => void>>

function mount(initialUrl = '') {
  onNavigate = vi.fn<(url: string) => void>()
  onTitle = vi.fn<(title: string) => void>()
  onClose = vi.fn<() => void>()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <BrowserPane
        initialUrl={initialUrl}
        onNavigate={onNavigate}
        onTitle={onTitle}
        onClose={onClose}
      />,
    ),
  )
}

const addressInput = () => document.querySelector<HTMLInputElement>('.browser-address')!
const viewport = () => document.querySelector<HTMLElement>('.browser-viewport')
const navButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.browser-nav-btn')]
const backBtn = () => navButtons()[0]
const forwardBtn = () => navButtons()[1]
const reloadBtn = () => navButtons()[2]

/** jsdom 里所有元素的 rect 都是 0；这里只给挂载点一个真实尺寸 */
function setViewportRect(rect: { left: number; top: number; width: number; height: number }) {  const element = viewport()
  if (!element) throw new Error('viewport 还没挂上')
  const full = {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
  }
  element.getBoundingClientRect = () => ({ ...full, toJSON: () => full }) as DOMRect
}

/** 推进一帧，并把这一帧里发出的 IPC promise 走完 */
async function tick() {
  await act(async () => {
    runFrame()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * 推进一帧并冲出这一帧的副作用（假时钟版：`setTimeout` 被接管）。
 * ⚠️ 每一轮都**重新给它一次尺寸并叫醒逐帧同步**：假时钟下 React 的渲染/effect 比真时钟晚一拍，
 * 首次量到 rect 为 0 时 `use-native-view` 会停掉 rAF（等 ResizeObserver 唤醒），不重推就永远建
 * 不出视图。
 */
async function tickFake() {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
      for (const item of resizeObservers) if (item.alive) item.cb([], {} as any)
      runFrame()
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

/** 尺寸变化后的唤醒（真实环境由 ResizeObserver 叫醒，这里手动触发） */
async function wake() {
  await act(async () => {
    for (const item of resizeObservers) if (item.alive) item.cb([], {} as any)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** React 受控输入：必须走原生 setter + input 事件，直接赋 value 不会触发 onChange */
function typeAddress(text: string) {
  const input = addressInput()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressEnter() {
  act(() => {
    addressInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

/** 地址栏提交一次（输入 + 回车） */
function submit(text: string) {
  typeAddress(text)
  pressEnter()
}

/** 模拟网页侧回传（Rust 的 `browser:navigate`） */
function emit(event: Omit<BrowserViewEvent, 'label'>) {
  const label = bridge.open.mock.calls[0]?.[0] ?? 'browser-view-1'
  act(() => {
    for (const listener of [...bridge.listeners]) listener({ label, ...event })
  })
}

/**
 * 占位中心点的命中测试替身（`use-native-view.ts::coveredByOverlay` 用）：
 * jsdom 没有布局引擎也不实现 `elementFromPoint`，默认答「命中的是占位自己」；
 * 用例里把 `overlayHit` 指向一个浮层就能模拟「设置页 / Modal 盖住面板」。
 */
let overlayHit: Element | null = null
function stubHitTest() {
  document.elementFromPoint = () =>
    overlayHit ?? document.querySelector('.browser-viewport')
}

beforeEach(() => {
  bridge.available = true
  // 界面缩放是模块级状态（`ui/hooks/applied-zoom.ts`），用例之间必须复位
  setAppliedZoomFactor(1)
  // 存活策略也是模块级状态：上一个用例的计时器不能漏到下一个
  resetBrowserViewPolicy()
  settingsState.value.browserSleepAfterSec = 20
  settingsState.value.browserMaxViews = 10
  overlayHit = null
  resizeObservers = []
  stubHitTest()
  bridge.open.mockResolvedValue(undefined)
  bridge.apply.mockResolvedValue(undefined)
  bridge.navigate.mockResolvedValue(undefined)
  bridge.reload.mockResolvedValue(undefined)
  bridge.history.mockResolvedValue(undefined)
  bridge.close.mockResolvedValue(undefined)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  frames = []
  resizeObservers = []
  resetBrowserViewPolicy()
  settingsState.value.browserSleepAfterSec = 20
  settingsState.value.browserMaxViews = 10
  bridge.listeners = []
  setAppliedZoomFactor(1)
  bridge.open.mockReset()
  bridge.apply.mockReset()
  bridge.navigate.mockReset()
  bridge.reload.mockReset()
  bridge.history.mockReset()
  bridge.close.mockReset()
  openUrlMock.mockClear()
})

/* ------------------------------------------------------------------ 地址模型 */

it('地址：无协议时补协议，本机 / 内网补 http、公网补 https', () => {
  expect(normalizeAddress('localhost:5173')).toEqual({
    kind: 'ok',
    url: 'http://localhost:5173/',
  })
  expect(normalizeAddress('127.0.0.1:8080/api')).toEqual({
    kind: 'ok',
    url: 'http://127.0.0.1:8080/api',
  })
  expect(normalizeAddress('192.168.1.5')).toEqual({
    kind: 'ok',
    url: 'http://192.168.1.5/',
  })
  expect(normalizeAddress('example.com')).toEqual({
    kind: 'ok',
    url: 'https://example.com/',
  })
  // 公网主机 + 端口仍按 https：`example.com:8443` 会被 SCHEME_PREFIX 认成 scheme
  // `example.com`，但它是「主机 + 端口」，不能因为“冒号后是数字”就套本机规则补 http
  expect(normalizeAddress('example.com:8443')).toEqual({
    kind: 'ok',
    url: 'https://example.com:8443/',
  })
  // 已经带协议的原样规范化（不重复加前缀、去掉首尾空白）
  expect(normalizeAddress('  https://docs.rs/tokio  ')).toEqual({
    kind: 'ok',
    url: 'https://docs.rs/tokio',
  })
})

it('地址：javascript / data / file 一律拒绝（地址栏是用户输入，视图吃下就是在应用源里跑脚本）', () => {
  for (const raw of [
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///C:/Windows/win.ini',
    'vbscript:msgbox',
    'about:blank',
  ]) {
    expect(normalizeAddress(raw)).toEqual({ kind: 'rejected', reason: 'scheme' })
  }
})

it('地址：带用户名密码的地址拒绝，空输入与解析不了的分别给不同原因', () => {
  expect(normalizeAddress('http://u:p@example.com/')).toEqual({
    kind: 'rejected',
    reason: 'credentials',
  })
  expect(normalizeAddress('   ')).toEqual({ kind: 'rejected', reason: 'empty' })
  expect(normalizeAddress('http://')).toEqual({ kind: 'rejected', reason: 'invalid' })
})

it('地址：标签标题取主机名（解析不了就原样回显）', () => {
  expect(urlLabel('http://localhost:5173/a/b')).toBe('localhost:5173')
  expect(urlLabel('https://docs.rs/tokio')).toBe('docs.rs')
  expect(urlLabel('')).toBe('')
  expect(urlLabel('nonsense')).toBe('nonsense')
})

/*
 * 历史模型不在这里：后退 / 前进归 WebView2 自己的历史栈（`src-tauri/src/browser_view.rs`）。
 * 面板侧没有任何「折叠 / 跳过中转页」的纯函数可测 —— 这正是修掉「没 302 的地址也被清理」
 * 那组 bug 的方式：少一套能删数据的逻辑。
 */

/* --------------------------------------------------------------- 面板与原生视图 */

it('空白页：不创建视图，给一段说明；没有地址时刷新不可用', async () => {
  mount()
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  expect(bridge.open).not.toHaveBeenCalled()
  expect(document.querySelector('.browser-empty')).not.toBeNull()
  expect(document.body.textContent).toContain('在上面输入网址开始浏览')
  expect(reloadBtn().disabled).toBe(true)
})

it('提交地址：按挂载点的 rect 建视图，地址规范化后同时写进地址栏与宿主', async () => {
  mount()
  setViewportRect({ left: 0, top: 40, width: 420, height: 560 })
  await tick()

  submit('localhost:5173')
  await tick()

  expect(bridge.open).toHaveBeenCalledTimes(1)
  expect(bridge.open).toHaveBeenCalledWith(expect.any(String), 'http://localhost:5173/', {
    x: 0,
    y: 40,
    width: 420,
    height: 560,
  })
  expect(addressInput().value).toBe('http://localhost:5173/')
  expect(onNavigate).toHaveBeenCalledWith('http://localhost:5173/')
})

it('空白页的第一个地址：地址栏先乐观显示目标，后退能不能用等原生报（不自己推算）', async () => {
  mount()
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  submit('https://a.com')
  await tick()
  // 页面报回真实地址之前，地址栏不能停在旧值上
  expect(addressInput().value).toBe('https://a.com/')

  emit({ phase: 'started', url: 'https://a.com/' })
  expect(document.querySelector('.browser-progress')).not.toBeNull()
  // 空白页不在历史栈里（Chromium 同口径）：原生报 `canBack: false`，按钮就真的是灰的
  emit({ phase: 'location', url: 'https://a.com/', canBack: false, canForward: false })
  emit({ phase: 'finished', url: 'https://a.com/' })
  expect(backBtn().disabled).toBe(true)
  expect(document.querySelector('.browser-progress')).toBeNull()
})

it('有初始地址：直接建视图，但不把挂载当成一次导航上报', async () => {
  mount('https://docs.rs/tokio')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  expect(bridge.open).toHaveBeenCalledWith(
    expect.any(String),
    'https://docs.rs/tokio',
    expect.anything(),
  )
  expect(addressInput().value).toBe('https://docs.rs/tokio')
  expect(onNavigate).not.toHaveBeenCalled()
})

it('非法地址：报一句原因并保留原来那一页', async () => {
  mount('https://docs.rs/tokio')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()
  bridge.navigate.mockClear()

  submit('javascript:alert(1)')
  await tick()

  expect(document.querySelector('.browser-error')!.textContent).toBe('只支持 http / https 地址')
  expect(bridge.navigate).not.toHaveBeenCalled()
  expect(bridge.open).toHaveBeenCalledTimes(1)
  // 被拒的输入留在地址栏里（那是用户要改的字），页面还是原来那一页
  expect(addressInput().value).toBe('javascript:alert(1)')

  // 带凭据的地址：另一句话
  submit('http://u:p@example.com/')
  expect(document.querySelector('.browser-error')!.textContent).toBe(
    '地址里不能带用户名或密码',
  )

  // 改输入即清错误提示
  typeAddress('example.com')
  expect(document.querySelector('.browser-error')).toBeNull()
})

it('后退 / 前进：只发原生命令，地址与按钮状态都由页面回传（不再自己 navigate）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  submit('https://b.com/')
  await tick()
  expect(bridge.navigate).toHaveBeenLastCalledWith(expect.any(String), 'https://b.com/')

  // 提交之后：Chromium 自己换来一条历史（`location` 事件带 canBack / canForward）
  emit({ phase: 'location', url: 'https://b.com/', canBack: true, canForward: false })
  expect(backBtn().disabled).toBe(false)
  expect(forwardBtn().disabled).toBe(true)

  bridge.navigate.mockClear()
  act(() => backBtn().click())
  // ⚠️ 只发原生命令：再补一次「地址变 → navigate」就会跟原生后退打架
  //（地址那一路刚导到目标页，原生后退又把它退回去，落在中转页上再跳一次 = 回退又跳回去）
  expect(bridge.history).toHaveBeenCalledWith(expect.any(String), 'back')
  expect(bridge.navigate).not.toHaveBeenCalled()

  // 真的回到了 a.com：地址栏跟页面走，按钮状态跟原生栈走
  emit({ phase: 'location', url: 'https://a.com/', canBack: false, canForward: true })
  expect(addressInput().value).toBe('https://a.com/')
  expect(backBtn().disabled).toBe(true)
  expect(forwardBtn().disabled).toBe(false)

  act(() => forwardBtn().click())
  expect(bridge.history).toHaveBeenLastCalledWith(expect.any(String), 'forward')
  expect(bridge.navigate).not.toHaveBeenCalled()
})

it('没有 canBack 上报的平台：按「有地址就能点」兜底，一旦报了就按真实状态来', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  // `started` / `finished` 不带历史状态（非 Windows 就是这种情况）：不推算，两个都放行
  emit({ phase: 'finished', url: 'https://a.com/' })
  expect(backBtn().disabled).toBe(false)
  expect(forwardBtn().disabled).toBe(false)

  // 页面报过真实状态之后就按真实状态来（原生说栈底，就真的是栈底）
  emit({ phase: 'location', url: 'https://a.com/', canBack: false, canForward: false })
  expect(backBtn().disabled).toBe(true)
  expect(forwardBtn().disabled).toBe(true)
})

it('刷新：地址不变也要真的重载（走 reload 命令，不动历史）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  act(() => reloadBtn().click())
  await tick()

  expect(bridge.reload).toHaveBeenCalledTimes(1)
  expect(bridge.navigate).not.toHaveBeenCalled()
  expect(bridge.history).not.toHaveBeenCalled()
  expect(onNavigate).not.toHaveBeenCalled()
})

it('页面自己跳走：回传的真实地址写进地址栏（不再有「已跳转」那种将就状态）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  emit({ phase: 'started', url: 'https://a.com/next' })

  expect(addressInput().value).toBe('https://a.com/next')
  expect(onNavigate).toHaveBeenLastCalledWith('https://a.com/next')
  expect(document.querySelector('.browser-progress')).not.toBeNull()

  emit({ phase: 'finished', url: 'https://a.com/next' })
  expect(document.querySelector('.browser-progress')).toBeNull()
})

it('服务端 302：地址栏跟到落地页，面板一次导航都不发（折叠是 Chromium 自己的事）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  submit('https://a.com/login')
  await tick()
  bridge.navigate.mockClear()

  // 我们发起的那次导航在服务端被 302 到 b.com：回传的只有落地地址
  emit({ phase: 'started', url: 'https://b.com/home' })
  emit({ phase: 'location', url: 'https://b.com/home', canBack: true, canForward: false })
  emit({ phase: 'finished', url: 'https://b.com/home' })

  expect(addressInput().value).toBe('https://b.com/home')
  // ⚠️ 关键：不「清理」任何东西、不补导航、不动历史 —— 302 只在 Chromium 的栈里替换一格
  expect(bridge.navigate).not.toHaveBeenCalled()
  expect(bridge.history).not.toHaveBeenCalled()

  // 后退交给原生：发一次命令，落回哪一页由 Chromium 决定（它已经折好了）
  act(() => backBtn().click())
  expect(bridge.history).toHaveBeenCalledWith(expect.any(String), 'back')
  expect(bridge.navigate).not.toHaveBeenCalled()
  emit({ phase: 'location', url: 'https://a.com/', canBack: false, canForward: true })
  expect(addressInput().value).toBe('https://a.com/')
})

it('页面里点链接走 302：中转地址只更新地址栏，不折叠也不删条目', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()
  emit({ phase: 'finished', url: 'https://a.com/' })
  bridge.navigate.mockClear()

  // 点链接 → 中转地址 → 落地页：每一跳都只改地址，面板不发任何命令
  for (const hop of ['https://a.com/go?to=t', 'https://t.com/home']) {
    emit({ phase: 'started', url: hop })
    emit({ phase: 'location', url: hop, canBack: true, canForward: false })
    emit({ phase: 'finished', url: hop })
  }

  expect(addressInput().value).toBe('https://t.com/home')
  expect(bridge.navigate).not.toHaveBeenCalled()
  expect(bridge.history).not.toHaveBeenCalled()
})

it('连续的多次真导航（不管隔多久）：只更新地址，不按间隔猜重定向', async () => {
  // 手动拨钟（不用假定时器：`tick()` 里还要真的等一拍）
  let clock = Date.now()
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    mount('https://a.com/')
    setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
    await tick()
    emit({ phase: 'finished', url: 'https://a.com/' })
    onNavigate.mockClear()

    // 快站点点两个链接（相隔 50ms）、慢站点点一个（相隔 5s）：待遇完全一样
    emit({ phase: 'finished', url: 'https://a.com/one' })
    clock += 50
    emit({ phase: 'finished', url: 'https://a.com/two' })
    clock += 5_000
    emit({ phase: 'finished', url: 'https://a.com/three' })

    expect(addressInput().value).toBe('https://a.com/three')
    // 地址每次都如实上报宿主（以前 50ms 那一次会被 HOP_GAP_MS 并掉）
    expect(onNavigate.mock.calls.map(([url]) => url)).toEqual([
      'https://a.com/one',
      'https://a.com/two',
      'https://a.com/three',
    ])
    // 面板自己一次导航 / 一次历史删除都不做
    expect(bridge.navigate).not.toHaveBeenCalled()
    expect(bridge.history).not.toHaveBeenCalled()
  } finally {
    nowSpy.mockRestore()
  }
})

it('加载永远等不到 finished（打不开的站点）：15s 后自己收掉进度条', async () => {
  vi.useFakeTimers()
  try {
    mount('https://a.com/')
    setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
    await tickFake()
    expect(bridge.open).toHaveBeenCalled()

    emit({ phase: 'started', url: 'https://a.com/' })
    expect(document.querySelector('.browser-progress')).not.toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(document.querySelector('.browser-progress')).toBeNull()
    // 只是把进度条收掉：地址栏仍然停在页面上那一页
    expect(addressInput().value).toBe('https://a.com/')
  } finally {
    vi.useRealTimers()
  }
})

it('逐帧同步：位置变了就 apply；切到别的标签（rect 为 0）只隐藏不销毁', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 40, width: 420, height: 560 })
  await tick()

  // 面板被拖宽：同一帧里把新 rect 发下去
  setViewportRect({ left: 0, top: 40, width: 600, height: 560 })
  await tick()
  expect(bridge.apply).toHaveBeenLastCalledWith(
    expect.any(String),
    { x: 0, y: 40, width: 600, height: 560 },
    true,
  )

  // 切走：display:none 的元素 rect 全是 0 → 隐藏（不 close，页面状态要留着），并停掉逐帧
  setViewportRect({ left: 0, top: 0, width: 0, height: 0 })
  await tick()
  expect(bridge.apply).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), false)
  expect(bridge.close).not.toHaveBeenCalled()

  // 切回来：恢复显示（真实环境是 ResizeObserver 叫醒的，这里手动触发）
  setViewportRect({ left: 0, top: 40, width: 600, height: 560 })
  await wake()
  expect(bridge.apply).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), true)
})

it('看不见时不再逐帧空转：停掉 rAF，只在唤醒后补一帧', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 40, width: 420, height: 560 })
  await tick()
  expect(frames.length).toBe(1)

  // 切走：这一帧发完 hide 就不再接力了
  setViewportRect({ left: 0, top: 0, width: 0, height: 0 })
  await tick()
  expect(frames.length).toBe(0)

  // 唤醒后（尺寸又有了）才重新开始逐帧
  setViewportRect({ left: 0, top: 40, width: 420, height: 560 })
  await wake()
  expect(frames.length).toBe(1)
})

it('界面缩放：rect 是 CSS 像素，传给原生视图的是逻辑像素（要乘缩放）', async () => {
  // 125%：这一行就是 useZoom 在 setZoom 成功之后的动作
  setAppliedZoomFactor(1.25)
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 32, width: 400, height: 480 })
  await tick()

  expect(bridge.open).toHaveBeenCalledWith(expect.any(String), 'https://a.com/', {
    x: 0,
    y: 40,
    width: 500,
    height: 600,
  })

  // 逐帧同步走同一个倍率（面板宽度 320 CSS × 1.25 = 400 DIP）
  setViewportRect({ left: 0, top: 32, width: 320, height: 400 })
  await tick()
  expect(bridge.apply).toHaveBeenLastCalledWith(
    expect.any(String),
    { x: 0, y: 40, width: 400, height: 500 },
    true,
  )
})

it('设置页 / Modal 盖住占位时：原生视图先躲开（它是子窗口，不吃 z-index）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 40, width: 420, height: 560 })
  await tick()
  expect(bridge.open).toHaveBeenCalledTimes(1)
  // 刚建好、位置也没变：一帧都不该发
  expect(bridge.apply).not.toHaveBeenCalled()
  expect(document.querySelector('.browser-pending')).not.toBeNull()

  // 设置页打开（全屏遮罩）：中心点命中的不再是占位
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  document.body.appendChild(overlay)
  overlayHit = overlay
  await tick()
  expect(bridge.apply).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), false)
  // 只藏不销毁：关掉设置页，网页 / 滚动位置 / 登录都还在
  expect(bridge.close).not.toHaveBeenCalled()
  // 半透明遮罩下不能透出「正在加载…」（视图已藏起来，它早不是加载中了）
  expect(document.querySelector('.browser-pending')).toBeNull()

  // 关掉设置页：下一帧重新露出来
  overlay.remove()
  overlayHit = null
  await tick()
  expect(bridge.apply).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), true)
  expect(bridge.close).not.toHaveBeenCalled()
  expect(document.querySelector('.browser-pending')).not.toBeNull()
})

it('命中测试不是每帧一次：没有 DOM 变化时按 100ms 降频', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 40, width: 420, height: 560 })
  await tick()
  expect(bridge.open).toHaveBeenCalledTimes(1)

  // 从这一帧开始计数：连续 10 帧、没有任何浮层变化
  let hits = 0
  const real = document.elementFromPoint.bind(document)
  document.elementFromPoint = ((x: number, y: number) => {
    hits++
    return real(x, y)
  }) as typeof document.elementFromPoint
  for (let i = 0; i < 10; i++) await tick()
  // 每帧一次就是 10 次；降频后应该一次都不做（10 帧 ≪ 100ms）
  expect(hits).toBeLessThanOrEqual(1)

  // 浮层出现（body 直接子节点变化）→ 不等到 100ms 就重测并藏起来
  const overlay = document.createElement('div')
  overlay.className = 'settings-overlay'
  document.body.appendChild(overlay)
  overlayHit = overlay
  await tick()
  // 关键是「没有回到逐帧」：最多因为 StrictMode 双挂载多跑一次，而不是 60 次/秒
  expect(hits).toBeLessThanOrEqual(2)
  expect(bridge.apply).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.anything(),
    false,
  )
})

it('被盖住时不去新建视图（建了也是一层白占的窗口）', async () => {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  document.body.appendChild(overlay)
  overlayHit = overlay

  mount('https://a.com/')
  setViewportRect({ left: 0, top: 40, width: 420, height: 560 })
  await tick()
  expect(bridge.open).not.toHaveBeenCalled()

  // 遮罩撤掉：下一帧才真的建
  overlay.remove()
  overlayHit = null
  await tick()
  expect(bridge.open).toHaveBeenCalledTimes(1)
})

it('视图建不起来：给一张说明卡（而不是永久白框）', async () => {
  bridge.open.mockRejectedValueOnce(new Error('创建网页视图失败: 主窗口不存在'))
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  expect(document.querySelector('.browser-blocked')).not.toBeNull()
  expect(document.body.textContent).toContain('网页视图启动失败')
  expect(document.body.textContent).toContain('创建网页视图失败: 主窗口不存在')

  // 卡片上的兜底出口
  act(() =>
    document.querySelector<HTMLButtonElement>('.browser-blocked-action')!.click(),
  )
  expect(openUrlMock).toHaveBeenCalledWith('https://a.com/')
})

it('不在桌面应用里（浏览器调试）：说明卡写清楚原因，且不去调 IPC', async () => {
  bridge.available = false
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  expect(document.body.textContent).toContain('网页视图只在桌面应用里可用')
  expect(bridge.open).not.toHaveBeenCalled()
})

it('兜底出口：系统浏览器打开当前地址；头部 ✕ 交给宿主关标签；卸载时销毁视图', async () => {
  mount('https://a.com/x')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  const tools = [...document.querySelectorAll<HTMLButtonElement>('.browser-tool')]
  // 第一颗是「在系统浏览器中打开」，第二颗是关闭
  act(() => tools[0].click())
  expect(openUrlMock).toHaveBeenCalledWith('https://a.com/x')

  act(() => tools[1].click())
  expect(onClose).toHaveBeenCalledTimes(1)

  const label = bridge.open.mock.calls[0][0]
  act(() => root!.unmount())
  root = null
  expect(bridge.close).toHaveBeenCalledWith(label)
})

it('卸载时视图还在创建中：落地后自己再收一次（不留下没人管的页面）', async () => {
  let finishOpen: () => void = () => {}
  bridge.open.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishOpen = resolve
      }),
  )

  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await act(async () => {
    runFrame()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(bridge.open).toHaveBeenCalledTimes(1)

  // 卸载：cleanup 那一次 close 发生时视图还没建出来，所以它自己不能算数
  act(() => root!.unmount())
  root = null
  expect(bridge.close).toHaveBeenCalledTimes(1)

  await act(async () => {
    finishOpen()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  // 迟到的 open 落地后再收一次（否则就留了一个看不见的页面在跑）
  expect(bridge.close).toHaveBeenCalledTimes(2)
})

it('页面标题：回传的 document.title 交给宿主（标签栏用它，而不是主机名）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  emit({ phase: 'title', title: 'A 站首页' })
  expect(onTitle).toHaveBeenLastCalledWith('A 站首页')

  // 标题变化不影响地址
  expect(onNavigate).not.toHaveBeenCalled()
  expect(addressInput().value).toBe('https://a.com/')
})

it('SPA 路由（只有 location，没有重新加载）：地址栏跟着变，面板不发任何命令', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()
  // 初次加载已经结束
  emit({ phase: 'finished', url: 'https://a.com/' })
  bridge.navigate.mockClear()

  emit({ phase: 'location', url: 'https://a.com/detail/1', canBack: true, canForward: false })

  expect(addressInput().value).toBe('https://a.com/detail/1')
  expect(onNavigate).toHaveBeenLastCalledWith('https://a.com/detail/1')
  expect(backBtn().disabled).toBe(false)
  // 这不是一次加载：不能因此亮进度条，也不该补一次导航
  expect(document.querySelector('.browser-progress')).toBeNull()
  expect(bridge.navigate).not.toHaveBeenCalled()
})

it('宿主重渲染换了回调函数：监听不重注册，事件照样到手', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()
  const listeners = bridge.listeners.length

  // 宿主每次渲染都会传新的箭头函数（真实场景：导航 → setState → 重渲染）
  act(() =>
    root!.render(
      <BrowserPane
        initialUrl="https://a.com/"
        onNavigate={vi.fn()}
        onTitle={vi.fn()}
        onClose={onClose}
      />,
    ),
  )
  expect(bridge.listeners.length).toBe(listeners)

  emit({ phase: 'location', url: 'https://a.com/next' })
  expect(addressInput().value).toBe('https://a.com/next')
})

/* --------------------------------------------------------------- 下载（不静默） */

it('网页发起下载：一律拦下（不落盘），面板给一条明确提示与系统浏览器出口', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  emit({ phase: 'download', name: '报告.pdf', url: 'https://a.com/f/report.pdf' })

  const notice = document.querySelector<HTMLElement>('.browser-notice')!
  expect(notice).not.toBeNull()
  expect(notice.textContent).toContain('网页尝试下载文件，已阻止')
  expect(notice.textContent).toContain('报告.pdf')
  // 下载不是一次导航：地址栏、历史、原生视图都不该动
  expect(addressInput().value).toBe('https://a.com/')
  expect(onNavigate).not.toHaveBeenCalled()
  expect(bridge.navigate).not.toHaveBeenCalled()
  expect(bridge.close).not.toHaveBeenCalled()

  // 「在系统浏览器中打开」用下载链接本身：那边会真的开始下载
  act(() => document.querySelector<HTMLButtonElement>('.browser-notice-action')!.click())
  expect(openUrlMock).toHaveBeenLastCalledWith('https://a.com/f/report.pdf')

  // 提示不自动消失，用户自己关
  act(() => notice.querySelector<HTMLButtonElement>('.browser-tool')!.click())
  expect(document.querySelector('.browser-notice')).toBeNull()
})

it('下载拿不到文件名 / 不是 http(s) 链接：照样提示，出口退回当前页', async () => {
  mount('https://a.com/page')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  emit({ phase: 'download', name: null, url: null })

  expect(document.querySelector('.browser-notice')).not.toBeNull()
  expect(document.body.textContent).toContain('网页尝试下载文件，已阻止')
  // 没有文件名就不占位（不渲染一个空的名字元素）
  expect(document.querySelector('.browser-notice-name')).toBeNull()

  act(() => document.querySelector<HTMLButtonElement>('.browser-notice-action')!.click())
  expect(openUrlMock).toHaveBeenLastCalledWith('https://a.com/page')
})
