/**
 * 右侧栏网页标签的**原生子 WebView** 桥（Rust 侧见 `src-tauri/src/browser_view.rs`）。
 *
 * 为什么不是 iframe：`X-Frame-Options` / `CSP frame-ancestors` 约束的是「被谁嵌入」，
 * iframe 里遇到它们只剩一片空白；`virlen.cn` 这类站点正是 `SAMEORIGIN`。
 * Electron 桌面端（dsh 的 `<webview>`）与这里的 child WebView 都是**独立浏览上下文**，
 * 服务器不知道它被摆在哪，这套响应头不适用。
 *
 * 三条口径：
 * 1. **原生视图只在桌面应用里存在**：浏览器调试 / 单测下 `invoke` 无处可去，
 *    所以每个函数先看 `hasBrowserView()`，没有就安静降级（调用方据此显示一句说明）；
 * 2. **位置 / 尺寸 / 显隐走同一条命令**（`browser_view_apply`）：它们是逐帧同步的三件事，
 *    拆成三条命令会并发、乱序，从隐藏恢复时会先显示再定位（肉眼可见的闪）；
 * 3. **网页侧的变化只能靠事件回传**：跨域读不到 `contentWindow.location`，但 WebView2 自己
 *    知道（`on_page_load` / `on_document_title_changed`），Rust 把结果发到主 webview 的
 *    `browser:navigate` 上，本模块负责拆包。
 * 4. **下载也走这条事件**（`phase = "download"`）：Rust 里 `on_download` 直接取消，
 *    只回传文件名 —— 子视图没有下载栏，放行就是「静默写进系统下载目录」。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** 视图位置 / 尺寸（CSS 像素，与 `getBoundingClientRect()` 同一口径；DPI 换算在 Rust 侧） */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 网页侧回传：`started` / `finished` / `location` 带 `url`，`title` 带 `title`，`download` 带文件名 */
export interface BrowserViewEvent {
  /** 哪个视图（一个网页标签一个） */
  label: string
  /**
   * `location` = WebView2 的 `SourceChanged`（**含 SPA 的 pushState**，比 `started` 全）；
   * `title` = 页面 `document.title`；`started` / `finished` = 页面加载阶段；
   * `download` = 网页发起了下载（已被拦下，**没有落盘**，需要给用户一条提示）。
   */
  phase: 'started' | 'finished' | 'location' | 'title' | 'download'
  /** 地址；`download` 时只在 http(s) 下载链接上给（`blob:` / `data:` 给 `null`） */
  url?: string | null
  title?: string | null
  /** 仅 `download`：被拦下的文件名（拿不到时是 `null`，提示里就不带文件名） */
  name?: string | null
}

/** 事件名（与 Rust 的 `NAVIGATE_EVENT` 必须一致） */
export const BROWSER_VIEW_EVENT = 'browser:navigate'

/** 原生视图只存在于桌面应用里（浏览器里调试 / jsdom 单测下没有） */
export function hasBrowserView(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 创建（或重建）一个网页视图。
 *
 * **失败要抛**：调用方只有知道「建不起来」才能给用户一句话（静默失败 = 永远的白框）。
 * 其余命令都是高频同步路径，失败没有可展示的意义，一律安静吞掉。
 */
export async function openBrowserView(
  label: string,
  url: string,
  bounds: BrowserViewBounds,
): Promise<void> {
  if (!hasBrowserView()) throw new Error('原生网页视图只在桌面应用里可用')
  await invoke('browser_view_open', { label, url, ...bounds })
}

/** 同步位置 / 尺寸 / 显隐（调用方逐帧去抖，只在真的变了时才发） */
export async function applyBrowserView(
  label: string,
  bounds: BrowserViewBounds,
  visible: boolean,
): Promise<void> {
  if (!hasBrowserView()) return
  try {
    await invoke('browser_view_apply', { label, ...bounds, visible })
  } catch {
    // 视图已被关闭（关标签与下一帧同步赛跑）时是正常时序，不该冒到界面上
  }
}

/** 发起一次导航（地址栏回车 / 后退 / 前进） */
export async function navigateBrowserView(label: string, url: string): Promise<void> {
  if (!hasBrowserView()) return
  try {
    await invoke('browser_view_navigate', { label, url })
  } catch {
    // 同上：视图已经不在时什么都不用做
  }
}

/** 重新加载当前页面（地址不变也要真的重载） */
export async function reloadBrowserView(label: string): Promise<void> {
  if (!hasBrowserView()) return
  try {
    await invoke('browser_view_reload', { label })
  } catch {
    // 同上
  }
}

/** 后退 / 前进（走网页自己的历史栈，与面板那条历史同向） */
export async function historyBrowserView(
  label: string,
  direction: 'back' | 'forward',
): Promise<void> {
  if (!hasBrowserView()) return
  try {
    await invoke('browser_view_history', { label, direction })
  } catch {
    // 同上
  }
}

/** 当前真实地址（`null` = 视图不存在；服务端重定向之后它比我们的历史栈准） */
export async function currentBrowserViewUrl(label: string): Promise<string | null> {
  if (!hasBrowserView()) return null
  try {
    return await invoke<string | null>('browser_view_current_url', { label })
  } catch {
    return null
  }
}

/** 销毁视图（关标签 / 组件卸载） */
export async function closeBrowserView(label: string): Promise<void> {
  if (!hasBrowserView()) return
  try {
    await invoke('browser_view_close', { label })
  } catch {
    // 重复关闭是正常路径
  }
}

/**
 * 订阅网页侧变化（地址 / 标题）。
 *
 * 非桌面环境返回一个空的取消函数 —— 调用方不必写两套挂载逻辑。
 */
export async function listenBrowserView(
  handler: (event: BrowserViewEvent) => void,
): Promise<UnlistenFn> {
  if (!hasBrowserView()) return () => {}
  return listen<BrowserViewEvent>(BROWSER_VIEW_EVENT, (event) => {
    const payload = event.payload
    if (payload && typeof payload.label === 'string') handler(payload)
  })
}
