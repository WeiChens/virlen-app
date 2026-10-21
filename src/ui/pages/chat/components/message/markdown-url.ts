/**
 * Markdown 的 URL 清洗器：**图片 `src` 放行，其余仍走 react-markdown 的默认规则**。
 *
 * 为什么要自定义（不自定义会坏在哪儿）：
 * 默认的 `defaultUrlTransform` 按 URL 语法判协议 —— 冒号出现在第一个 `/` 之前就当 scheme，
 * 且白名单只有 http(s) / irc(s) / mailto / xmpp。于是：
 * - `C:/code/a.png`：`C:` 被当成 scheme → **整条清空**（Windows 截图一张都显示不出来）；
 * - `file:///C:/a.png`：`file` 不在白名单 → 清空；
 * - `data:image/png;base64,…`：`data` 不在白名单 → 清空。
 *
 * 图片放行是安全的，因为真正的边界在**加载那一侧**：本地路径必须过 `resolveSafePath`
 * （黑名单 / 白名单）才读得到，远程地址交给 webview（应用没设 CSP）；而 `javascript:`
 * 在 `<img src>` 上本来就不会执行。
 *
 * ⚠️ 只放行 `src`：`<a href>` 保持默认规则，免得模型顺手把 `file:` / `javascript:` 变成可点链接。
 */
import { defaultUrlTransform } from 'react-markdown'

export function allowImageSrc(url: string, key: string): string {
  return key === 'src' ? url : defaultUrlTransform(url)
}
