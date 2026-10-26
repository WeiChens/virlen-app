/**
 * Markdown 正文里的链接 → 右侧栏「网页」标签的**唯一出口**。
 *
 * 为什么要转一手：链接渲染在 `message/markdown-renderer.tsx`（离聊天页很深，中间还隔着虚拟列表
 * 与「前缀冻结」的 memo 子树，往下传 props 会一路击穿 memo），而网页标签的状态在 `chat-view`
 * 的 state + ref 里（`handleOpenBrowser`）。与 `present-service` 同一个套路：宿主挂载时把入口
 * 登记进来，渲染层只管调，不自己伸手进组件树。
 *
 * ⚠️ 没人接（不在聊天页 / 用例里没注入）时返回 false —— 调用方据此**保持原行为**
 *（不 `preventDefault`），这里不猜也不吞掉「没人接」这件事。
 */

/** 用右侧栏打开一个网址的实现（由 chat-view 注入；它独占标签状态） */
export type SidePanelBrowserHandler = (url: string) => void

let handler: SidePanelBrowserHandler | null = null

/** 登记入口；返回注销函数（聊天页卸载时调，别把上一个实例的 handler 留着） */
export function setSidePanelBrowserHandler(next: SidePanelBrowserHandler | null): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/**
 * 把网址摊到右侧栏的网页标签。没有宿主时返回 false，由调用方决定怎么兜底。
 *
 * 面板收起 / 当前会话没有标签都不影响：宿主落桶时会自动展开（`sessions.ts::withBucketTabs`）。
 */
export function openUrlInSidePanelBrowser(url: string): boolean {
  if (!handler || !url) return false
  handler(url)
  return true
}
