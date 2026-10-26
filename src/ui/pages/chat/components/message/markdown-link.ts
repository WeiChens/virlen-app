/**
 * Markdown 正文里的链接 → 右侧栏「网页」标签（判定 + 拦截口径都在这里）。
 *
 * 口径：**只有绝对的 http(s) 链接改道**，其余一律保持 `<a target="_blank">` 的原行为。
 * 为什么卡这么死：面板的地址校验（`side-panel/browser/url.ts::normalizeAddress`）只放行 http(s)，
 * 而 Markdown 里的 `#锚点`、`./a.ts`、`mailto:`、`file:` 都不是网页标签能吃的东西 —— 全塞给
 * `normalizeAddress` 会把它「无协议时补协议」那条好用的规则反过来变成坑（`./a.ts` 会被当成
 * 主机名补成 `https://./a.ts`，开出一个空白的外网标签）。所以先按**字面前缀**筛一道。
 */
import { normalizeAddress } from '@/ui/pages/chat/components/side-panel/browser/url'
import { openUrlInSidePanelBrowser } from '@/services/browser-open-service'

/** 绝对的 http(s) 链接（大小写不敏感；`//example.com` 这种协议相对地址不算） */
const HTTP_LINK = /^https?:\/\//i

/**
 * 这个 `href` 该不该由右侧栏浏览器接管：是就返回**规范化后**的地址，否则空串。
 *
 * 规范化后才是标签身份（`browser/url.ts` 的同一口径）：`docs.rs` 与 `https://docs.rs/`
 * 是同一个页面，开两个标签只会让用户以为自己点错了。
 */
export function sidePanelUrlOf(href?: string | null): string {
  const text = (href ?? '').trim()
  if (!HTTP_LINK.test(text)) return ''
  const check = normalizeAddress(text)
  return check.kind === 'ok' ? check.url : ''
}

/** 点击事件里用得上的几个字段（原生事件与 React 合成事件都满足） */
export interface LinkClickEvent {
  button?: number
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/**
 * 链接被点了一下：接不接管。
 *
 * 三条**故意不改道**的情形（交给 `<a>` 自己的语义）：
 * - 不是 http(s)（见文件头）；
 * - 按了修饰键（Ctrl / Cmd / Shift / Alt）—— 那是用户在说「我不在这儿开」，硬接管就是抢键；
 * - 不是左键 —— 中键 / 右键有浏览器自己的语义。
 *
 * 没人接管（宿主没登记，例如不在聊天页）时返回 false：调用方**不要** `preventDefault`，
 * 否则点了等于没反应。
 */
export function handleMarkdownLinkClick(event: LinkClickEvent, href?: string | null): boolean {
  if (event.button !== 0) return false
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false
  const url = sidePanelUrlOf(href)
  if (!url) return false
  return openUrlInSidePanelBrowser(url)
}
