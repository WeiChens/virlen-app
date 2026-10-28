/**
 * 交付物（`present` 工具）→ 右侧面板的**唯一出口**：文件开成文件标签，网址开成网页标签。
 *
 * 为什么要在 service 里转一手：`present` 在 Rust 原生执行（拿不到 UI），而标签页状态在
 * `chat-view` 的 state + ref 里，唯一能开标签的入口是它的 `handleOpenFiles` / `handleOpenBrowser`。
 * 于是这里只做一个订阅点：聊天页挂载时把入口登记进来，两处触发都走它 ——
 * ① 工具结果到达（自动打开，见 `services/chat/event-handler.ts`）；
 * ② 工具卡片里点文件名 / 网址（再打开一次；标签已存在就只是切过去）。
 *
 * ⚠️ 触发①**带着归属会话**（`sessionId`）：右侧栏是按会话分桶的（`side-panel/sessions.ts`），
 * 标签该落进「跑出这次交付的那个会话」那一桶 —— 用户当时可能正看着别的会话或新对话页，
 * 不然交付就白交了。落桶与「换桶」由宿主的 `panelKeyOf(sessionId)` 决定，本文件不判断。
 *
 * ⚠️ `uiData.type = "present"` / `files[].path` / `links[].url` 是与 Rust
 * `native_tools/file/present.rs` 逐字对齐的契约（铁律 1）—— 改一边必须同步另一边
 *（TS 回退执行器 `infrastructure/tools/file/present.ts` 也是同一份形状），
 * 否则「模型说给了、用户什么都没看到」。
 */
import type { Message } from '@/types'

/** 一次交付摊到面板上的东西：文件走标签页，网址走网页标签 */
export interface PresentedPayload {
  paths: string[]
  urls: string[]
  /**
   * 这次交付**归属的会话**（`present` 的工具结果是哪个会话跑出来的）。
   *
   * 交付要落进**它自己那一桶**右侧栏，不能落进「用户此刻眼前那一桶」——
   * 后台会话跑完时用户可能正看着别的会话 / 新对话页，按当前会话一刀切
   * 就等于把交付静悄悄丢了（切回去还得自己在卡片里点一遍）。
   *
   * 缺席 = 「就是眼前这个会话」：消息卡片里再点一次那条路（`PresentMessage`）
   * 不需要带 —— 卡片只会在它自己的会话里渲染。
   */
  sessionId?: string
}

/** 打开右侧面板标签的实现（由 chat-view 注入；它独占标签状态） */
export type PresentRevealHandler = (payload: PresentedPayload) => void

let handler: PresentRevealHandler | null = null

/** 登记入口；返回注销函数（聊天页卸载时调，别把上一个实例的 handler 留着） */
export function setPresentRevealHandler(next: PresentRevealHandler | null): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/** `uiData`（只认 `type = "present"` 的**成功**结果：失败结果里的东西根本没被收下） */
function presentUiData(message?: Message | null): Record<string, unknown> | null {
  if (!message || message.isError) return null
  const ui = message.uiData as Record<string, unknown> | undefined
  if (!ui || ui.type !== 'present') return null
  return ui
}

/**
 * 工具结果里的交付文件（绝对路径）。
 *
 * 只认结构化 `uiData`，不解析正文 —— 正文是给模型看的英文，路径的权威来源是 uiData。
 */
export function presentedPathsOf(message?: Message | null): string[] {
  const ui = presentUiData(message)
  if (!ui || !Array.isArray(ui.files)) return []
  return (ui.files as { path?: unknown }[])
    .map((file) => (typeof file?.path === 'string' ? file.path : ''))
    .filter((path): path is string => !!path)
}

/**
 * 工具结果里的交付网址。
 *
 * 形状由 Rust 侧筛过（只放行 http(s)、不带凭据），这里只再兜一道字符串类型 ——
 * 前端不该在这里重复实现一遍地址校验（两处判必然分叉）。
 */
export function presentedLinksOf(message?: Message | null): string[] {
  const ui = presentUiData(message)
  if (!ui || !Array.isArray(ui.links)) return []
  return (ui.links as { url?: unknown }[])
    .map((link) => (typeof link?.url === 'string' ? link.url : ''))
    .filter((url): url is string => !!url)
}

/** 一条消息要摊到面板上的全部东西（空则两项都是空数组） */
export function presentedOf(message?: Message | null): PresentedPayload {
  return { paths: presentedPathsOf(message), urls: presentedLinksOf(message) }
}

/**
 * 把交付物摊到右侧面板。没有宿主（不在聊天页 / 用例里没注入）或两者都空时返回 false，
 * 由调用方决定要不要兜底 —— 这里不猜，也不吞掉「没人接」这件事。
 */
export function revealPresented(payload: PresentedPayload): boolean {
  if (!handler) return false
  const paths = payload?.paths ?? []
  const urls = payload?.urls ?? []
  if (paths.length === 0 && urls.length === 0) return false
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
  // 归属会话原样透传（空 = 没指定，宿主按当前会话落桶）；这里不猜、也不替宿主挑
  handler({ paths: [...paths], urls: [...urls], ...(sessionId ? { sessionId } : {}) })
  return true
}
