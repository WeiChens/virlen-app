/**
 * 浏览器面板的「地址」工具与历史模型 —— **纯函数**（不碰 React、不碰 DOM、不碰 Tauri）。
 *
 * 分成两件事，但都只跟「一串网址」有关，所以放在同一个文件里：
 *
 * 1. **地址校验**（`normalizeAddress`）：把地址栏里那串人话变成可用的 URL，或者明确说出
 *    为什么不行。三条红线（P3 的安全口径）：
 *    - **只放行 http / https**：`javascript:` / `data:` / `file:` / `blob:` / `about:` 一律拒绝。
 *      这不是「多一层洁癖」—— 地址栏是用户输入，而 iframe 的 `src` 一旦吃下 `javascript:`
 *      就是在**本应用的源**里执行脚本（比 iframe 里的页面危险得多）；
 *    - **带凭据的地址拒绝**：`http://user:pass@host/` 会把密码写进标签标题、右键菜单、
 *      以后可能的历史记录里；要登录就用页面自己的表单；
 *    - **无协议时补协议**：`localhost:5173` 补 `http://`（本机 / 内网 dev server 基本都是 http），
 *      其余补 `https://`。注意 `localhost:5173` 在 URL 语法里「像」一个 scheme，
 *      所以只有「冒号后面紧跟端口号」时才按主机:端口处理，否则 `javascript:80` 也能混过去。
 *
 * 2. **历史**（`newHistory` / `historyGo` / `historyReplace` / `historyBack` / `historyForward`）：
 *    记的是**真实地址**。面板里的网页现在是原生子 WebView（不是 iframe），页面自己跳走、
 *    服务端重定向都能通过 `on_page_load` 回传，所以历史里不会再有「不知道跳到哪了」的空洞；
 *    `historyReplace` 专门对付重定向：用户发起的 A 最终落在 B，历史里留 A 只会让后退绕圈。
 */

/** 地址为什么不能用（`empty` 只是「还没输入」，调用方当无事发生即可） */
export type AddressProblem = 'empty' | 'scheme' | 'credentials' | 'invalid'

/** 校验结果：能用就是**规范化后的**地址（`new URL().href`，带尾斜杠 / 小写主机） */
// ⚠️ 判别字段用**字符串**而不是 `ok: boolean`：本仓 `strictNullChecks: false`，
// 布尔字面量不当判别符（`if (!check.ok)` 不会收窄成 `{ reason }` 那一支）
export type AddressCheck =
  | { kind: 'ok'; url: string }
  | { kind: 'rejected'; reason: AddressProblem }

/** `scheme:` 前缀（`localhost:5173` 也会命中，所以后面还要看冒号后是不是端口） */
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/** `host:端口` 的形态：冒号后紧跟数字，再接路径结束 / 分隔符 */
const HOST_PORT = /^[a-zA-Z][a-zA-Z0-9+.-]*:\d+(?:[/?#]|$)/

/**
 * 这个主机是不是「本机 / 内网」：是就补 `http://` 而不是 `https://`。
 *
 * 理由很实际：`localhost:5173`、`192.168.1.5:8080` 这类地址补成 https 会**直接打不开**
 * （dev server 没有证书），而用户手输它们的时候心里想的就是 http。反过来，公网域名补 http
 * 现在已经基本不可用（HSTS / 强制跳转），所以默认 https。
 */
function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '0.0.0.0') return true
  // WHATWG URL 把 IPv6 主机保留成 `[::1]` 形态
  if (hostname === '[::1]' || hostname === '::1') return true
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true
  // 172.16.0.0 – 172.31.255.255
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return true
  return false
}

/**
 * 地址栏输入 → 可用的 http(s) URL。
 *
 * 成功时返回**规范化后**的 `href`（这是标签标题、视图地址、历史条目共用的同一个字符串，
 * 不规范化就会出现「同一个页面三个 key」）。
 */
export function normalizeAddress(raw: string): AddressCheck {
  const text = raw.trim()
  if (!text) return { kind: 'rejected', reason: 'empty' }

  const schemeMatch = SCHEME_PREFIX.exec(text)
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : ''
  /** 真写了 http(s)：协议是用户的意思，后面不许改写 */
  const realScheme = scheme === 'http' || scheme === 'https'
  if (schemeMatch && !realScheme && !HOST_PORT.test(text)) {
    // 既不是 http(s)、又不像「主机 + 端口」：一律拒绝（javascript: / file: / mailto: …）
    return { kind: 'rejected', reason: 'scheme' }
  }
  // 没写协议（含 `localhost:5173` 这种「像 scheme 的主机 + 端口」）先按 https 补，
  // 再由下面按主机决定要不要降成 http —— 协议只在这一处定，别两边各判一次
  let candidate = realScheme ? text : `https://${text}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { kind: 'rejected', reason: 'invalid' }
  }
  // 兜底再判一次（`new URL` 是宽松的：`javascript:alert(1)` 在没走上面的分支时也能解析成功）
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'rejected', reason: 'scheme' }
  }
  if (!parsed.hostname) return { kind: 'rejected', reason: 'invalid' }
  // 凭据不下发（见文件头）
  if (parsed.username || parsed.password) {
    return { kind: 'rejected', reason: 'credentials' }
  }
  // 本机 / 内网的无协议输入：改用 http（https 在这些地址上通常直接连不上）。
  // ⚠️ 判据是 `realScheme` 而不是 schemeMatch：`example.com:8443` 会被 `SCHEME_PREFIX`
  // 认成 scheme `example.com`，但它是主机 + 端口，公网主机必须按 https 补
  if (!realScheme && isLocalHost(parsed.hostname)) {
    parsed.protocol = 'http:'
  }
  return { kind: 'ok', url: parsed.href }
}

/** 标签标题用的主机名（`localhost:5173` / `docs.rs`）；解析不了就原样回显 */
export function urlLabel(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** 历史：一条线 + 一个游标（浏览器口径：后退后再导航会砍掉前面的分支） */
export interface BrowserHistory {
  entries: string[]
  cursor: number
}

export function newHistory(url: string): BrowserHistory {
  return { entries: [url], cursor: 0 }
}

/** 当前地址（空串 = 空白页） */
export function historyCurrent(history: BrowserHistory): string {
  return history.entries[history.cursor] ?? ''
}

export function canGoBack(history: BrowserHistory): boolean {
  return history.cursor > 0
}

export function canGoForward(history: BrowserHistory): boolean {
  return history.cursor < history.entries.length - 1
}

/**
 * 发起一次导航：追加到游标之后。地址与当前条目相同时返回原引用
 * （点两次同一个链接不该多出一条历史，宿主也不必重渲染）。
 */
export function historyGo(history: BrowserHistory, url: string): BrowserHistory {
  if (historyCurrent(history) === url) return history
  const entries = [...history.entries.slice(0, history.cursor + 1), url]
  return { entries, cursor: entries.length - 1 }
}

/**
 * 把**当前这一条**换成另一个地址（不新增条目）。
 *
 * 服务端重定向专用：用户要的是 A，最终落在 B —— 历史里留 A 会让「后退」退到 A、
 * 再被重定向回 B，转圈。网页里点链接这种「真的去了新地方」的导航仍然走 `historyGo`。
 */
export function historyReplace(history: BrowserHistory, url: string): BrowserHistory {
  if (historyCurrent(history) === url) return history
  const entries = [...history.entries]
  entries[history.cursor] = url
  return { entries, cursor: history.cursor }
}

export function historyBack(history: BrowserHistory): BrowserHistory {
  return canGoBack(history) ? { ...history, cursor: history.cursor - 1 } : history
}

export function historyForward(history: BrowserHistory): BrowserHistory {
  return canGoForward(history) ? { ...history, cursor: history.cursor + 1 } : history
}
