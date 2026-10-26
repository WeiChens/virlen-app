/**
 * 浏览器面板的「地址」工具 —— **纯函数**（不碰 React、不碰 DOM、不碰 Tauri）。
 *
 * **地址校验**（`normalizeAddress`）：把地址栏里那串人话变成可用的 URL，或者明确说出
 * 为什么不行。三条红线（P3 的安全口径）：
 * - **只放行 http / https**：`javascript:` / `data:` / `file:` / `blob:` / `about:` 一律拒绝。
 *   这不是「多一层洁癖」—— 地址栏是用户输入，而视图一旦吃下 `javascript:` 就是在**本应用的源**里
 *   执行脚本（比 iframe 里的页面危险得多）；
 * - **带凭据的地址拒绝**：`http://user:pass@host/` 会把密码写进标签标题、右键菜单、
 *   以后可能的历史记录里；要登录就用页面自己的表单；
 * - **无协议时补协议**：`localhost:5173` 补 `http://`（本机 / 内网 dev server 基本都是 http），
 *   其余补 `https://`。注意 `localhost:5173` 在 URL 语法里「像」一个 scheme，
 *   所以只有「冒号后面紧跟端口号」时才按主机:端口处理，否则 `javascript:80` 也能混过去。
 *
 * ⚠️ **这里没有历史模型，一条都不要加回来**：后退 / 前进归 WebView2 自己的历史栈
 * （见 `browser-view.rs::browser_view_history`）。面板曾经维护过一条合成历史，靠「两跳间隔短」
 * 「又落回出发页」把重定向折成一条 —— 那都是在猜，而猜错就会**删掉用户真去过的页面**
 * （快站点点两个链接就能被并成一条；「登录后跳回原页」也能被判成中转页）。参考实现 dsh
 * 桌面端（`ElectronWebViewImpl`）同样不维护应用侧历史，只用原生 `canGoBack` / `goBack`。
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
