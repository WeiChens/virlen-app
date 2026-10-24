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
 * 4. 地址规范化（`new URL().href`）：标签标题、视图地址、历史条目共用同一个串；
 * 5. 历史按浏览器口径：后退再导航砍掉前进分支；`historyReplace` 专治重定向（A→B 不留 A）。
 *
 * 二、**面板与原生视图的接线**（`browser-view` 在这里是 mock）
 * 6. 地址是唯一的导航来源：地址变 → `navigate`；同一地址再来一次算刷新（`reload`）；
 * 7. 视图的 rect 逐帧同步：不可见（切标签 / 收起面板，rect 为 0）只 `hide` 不销毁；
 * 8. 页面回传的真实地址要写回地址栏（重定向替换当前条目，页面自己跳走则新增一条）；
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
import type { BrowserViewEvent } from '@/infrastructure/browser/browser-view'
import {
  canGoBack,
  canGoForward,
  historyBack,
  historyCurrent,
  historyForward,
  historyGo,
  historyReplace,
  newHistory,
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
  currentBrowserViewUrl: () => Promise.resolve(null),
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
  overlayHit = null
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

it('历史：追加 / 后退 / 前进，后退后再导航会砍掉前面的分支', () => {
  const first = newHistory('a')
  expect(historyCurrent(first)).toBe('a')
  expect(canGoBack(first)).toBe(false)
  expect(canGoForward(first)).toBe(false)

  const second = historyGo(first, 'b')
  expect(second.entries).toEqual(['a', 'b'])
  expect(historyCurrent(second)).toBe('b')
  expect(canGoBack(second)).toBe(true)

  // 同一个地址再提交一次：不新增历史（宿主当刷新处理，见 BrowserPane::applyHistory）
  expect(historyGo(second, 'b')).toBe(second)

  const back = historyBack(second)
  expect(historyCurrent(back)).toBe('a')
  expect(canGoForward(back)).toBe(true)
  // 已经到头 / 到尾：原引用返回，不越界
  expect(historyBack(back)).toBe(back)
  expect(historyForward(historyGo(second, 'c')).entries).toEqual(['a', 'b', 'c'])

  // 从「a」再往「c」走：b 那条前进分支必须消失
  expect(historyGo(back, 'c').entries).toEqual(['a', 'c'])
})

it('历史：重定向替换当前条目（A 最终落在 B，历史里不该留下 A）', () => {
  const trail = historyGo(newHistory('https://a.com/'), 'https://a.com/login')
  const redirected = historyReplace(trail, 'https://b.com/home')
  expect(redirected.entries).toEqual(['https://a.com/', 'https://b.com/home'])
  expect(historyCurrent(redirected)).toBe('https://b.com/home')
  // 原地退回一步仍然是用户真正去过的那个页面，而不是被重定向前的那一跳
  expect(historyCurrent(historyBack(redirected))).toBe('https://a.com/')
  // 地址没变时原引用返回（不制造无意义的重渲染）
  expect(historyReplace(redirected, 'https://b.com/home')).toBe(redirected)
})

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

it('空白页的第一个地址替换掉空白条目：后退不可用，不会退回空串再一直转圈', async () => {
  mount()
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  submit('https://a.com')
  await tick()
  expect(addressInput().value).toBe('https://a.com/')
  // 空白页不在后退栈里（浏览器同口径）：否则后退会退到空串 —— 空地址会把视图销毁，
  // 永远等不到 finished，进度条只能等 15s 兜底才停（用户看到的就是「一直转」）
  expect(backBtn().disabled).toBe(true)

  emit({ phase: 'started', url: 'https://a.com/' })
  expect(document.querySelector('.browser-progress')).not.toBeNull()
  emit({ phase: 'finished', url: 'https://a.com/' })
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

it('后退 / 前进：面板历史决定方向，原生视图负责执行，地址栏跟着换', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  submit('https://b.com/')
  await tick()
  expect(bridge.navigate).toHaveBeenLastCalledWith(expect.any(String), 'https://b.com/')
  expect(backBtn().disabled).toBe(false)
  expect(forwardBtn().disabled).toBe(true)

  act(() => backBtn().click())
  expect(bridge.history).toHaveBeenLastCalledWith(expect.any(String), 'back')
  expect(addressInput().value).toBe('https://a.com/')
  expect(backBtn().disabled).toBe(true)
  expect(forwardBtn().disabled).toBe(false)

  act(() => forwardBtn().click())
  expect(bridge.history).toHaveBeenLastCalledWith(expect.any(String), 'forward')
  expect(addressInput().value).toBe('https://b.com/')
})

it('刷新：地址不变也要真的重载（走 reload 命令，不新增历史）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  act(() => reloadBtn().click())
  await tick()

  expect(bridge.reload).toHaveBeenCalledTimes(1)
  expect(bridge.navigate).not.toHaveBeenCalled()
  expect(onNavigate).not.toHaveBeenCalled()
})

it('页面自己跳走：回传的真实地址写进地址栏（不再有「已跳转」那种将就状态）', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  emit({ phase: 'started', url: 'https://a.com/next' })

  expect(addressInput().value).toBe('https://a.com/next')
  expect(onNavigate).toHaveBeenLastCalledWith('https://a.com/next')
  // 新增一条：后退能回到 a.com
  expect(backBtn().disabled).toBe(false)

  emit({ phase: 'finished', url: 'https://a.com/next' })
  expect(document.querySelector('.browser-progress')).toBeNull()
})

it('服务端重定向：替换当前条目，后退不会绕回被重定向前那一跳', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()

  submit('https://a.com/login')
  await tick()
  // 实际落在 b.com：这是我们发起的那次导航的终点
  emit({ phase: 'started', url: 'https://b.com/home' })
  emit({ phase: 'finished', url: 'https://b.com/home' })

  expect(addressInput().value).toBe('https://b.com/home')
  act(() => backBtn().click())
  expect(addressInput().value).toBe('https://a.com/')
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

  // 切走：display:none 的元素 rect 全是 0 → 隐藏（不 close，页面状态要留着）
  setViewportRect({ left: 0, top: 0, width: 0, height: 0 })
  await tick()
  expect(bridge.apply).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), false)
  expect(bridge.close).not.toHaveBeenCalled()

  // 切回来：恢复显示
  setViewportRect({ left: 0, top: 40, width: 600, height: 560 })
  await tick()
  expect(bridge.apply).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), true)
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

it('SPA 路由（只有 location，没有重新加载）：地址栏跟着变，历史追加一条', async () => {
  mount('https://a.com/')
  setViewportRect({ left: 0, top: 0, width: 800, height: 600 })
  await tick()
  // 初次加载已经结束
  emit({ phase: 'finished', url: 'https://a.com/' })

  emit({ phase: 'location', url: 'https://a.com/detail/1' })

  expect(addressInput().value).toBe('https://a.com/detail/1')
  expect(onNavigate).toHaveBeenLastCalledWith('https://a.com/detail/1')
  expect(backBtn().disabled).toBe(false)
  // 这不是一次加载：不能因此亮进度条
  expect(document.querySelector('.browser-progress')).toBeNull()
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
