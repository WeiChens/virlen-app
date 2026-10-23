/**
 * 交付文件（`present` 工具）→ 右侧面板的**唯一出口**。
 *
 * 为什么要在 service 里转一手：`present` 在 Rust 原生执行（拿不到 UI），而标签页状态在
 * `chat-view` 的 state + ref 里，唯一能开标签的入口是它的 `handleOpenFile`。于是这里只做一个
 * 订阅点：聊天页挂载时把入口登记进来，两处触发都走它 ——
 * ① 工具结果到达（自动打开，见 `services/chat/event-handler.ts`）；
 * ② 工具卡片里点文件名（再打开一次；标签已存在就只是切过去）。
 *
 * ⚠️ `uiData.type = "present"` / `files[].path` 是与 Rust `native_tools/file/present.rs`
 * 逐字对齐的契约（铁律 1）—— 改一边必须同步另一边，否则「模型说给了、用户什么都没看到」。
 */
import type { Message } from '@/types'

/** 打开右侧面板标签的实现（由 chat-view 注入；它独占标签状态） */
export type PresentRevealHandler = (paths: string[]) => void

let handler: PresentRevealHandler | null = null

/** 登记入口；返回注销函数（聊天页卸载时调，别把上一个实例的 handler 留着） */
export function setPresentRevealHandler(next: PresentRevealHandler | null): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/**
 * 工具结果里的交付文件（绝对路径）。
 *
 * 只认结构化 `uiData`，不解析正文 —— 正文是给模型看的英文，路径的权威来源是 uiData。
 * 失败结果（`isError`）一律当作没有交付物：那些文件根本没被 Rust 收下。
 */
export function presentedPathsOf(message?: Message | null): string[] {
  if (!message || message.isError) return []
  const ui = message.uiData as { type?: string; files?: unknown } | undefined
  if (!ui || ui.type !== 'present' || !Array.isArray(ui.files)) return []
  return (ui.files as { path?: unknown }[])
    .map((file) => (typeof file?.path === 'string' ? file.path : ''))
    .filter((path): path is string => !!path)
}

/**
 * 把文件摊到右侧面板。没有宿主（不在聊天页 / 用例里没注入）时返回 false，
 * 由调用方决定要不要兜底 —— 这里不猜，也不吞掉「没人接」这件事。
 */
export function revealPresentedFiles(paths: readonly string[]): boolean {
  if (!handler || paths.length === 0) return false
  handler([...paths])
  return true
}
