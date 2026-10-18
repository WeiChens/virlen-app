/**
 * HTML 预览文档的组装（纯函数）：注入 `<base>`，并在开启脚本时注入严格 CSP。
 *
 * 为什么用 DOMParser 而不是字符串插入：
 * - 字符串前置会破坏 `<!DOCTYPE>`（页面进怪异模式），遇到 `</head>` 出现在注释 / 字符串里时还会插错位置；
 * - DOMParser 只解析、**不执行脚本**，畸形 HTML 也不会抛异常（解析失败最多得到一个空文档）。
 *
 * 两种模式：
 * - 脚本关闭（默认）：只注入 base，iframe 的 `sandbox=""` 让脚本根本无法执行；
 * - 脚本开启：iframe 给 `allow-scripts`（但**不给 allow-same-origin**），同时用 CSP 把网络出口收窄。
 *   脚本仍可通过自我导航（`location.href = '…'`）外发数据，这是浏览器层无法拦的，所以开关必须由用户显式打开。
 *
 * 外部资源分两档（用户实测反馈：开了脚本却跑不了 CDN 上的 three.js）：
 * - **静态资源**（样式 / 字体 / 图片 / 媒体）默认放行 `https:`：它们不执行代码，而且脚本关闭时
 *   页面本来就能加载外链图片（那时压根没有 CSP）；
 * - **脚本与 `connect`** 只在用户勾选「允许外部资源」后才放行 —— 那才是「执行第三方代码」与
 *   「任意收发网络数据」的边界。
 */

/** 从 base URL 取 CSP 源（自定义 scheme 的 `new URL().origin` 可能是 "null"，故手工取 scheme+host） */
function originOf(baseUrl: string): string {
  const match = /^([a-z0-9+.-]+):\/\/([^/]+)/i.exec(baseUrl)
  return match ? `${match[1]}://${match[2]}` : ''
}

/**
 * CSP（脚本开启时注入）：
 * - 样式 / 字体 / 图片 / 媒体只认**本地资源源**与 `https:`（静态资源不执行代码，见文件头）；
 * - `script-src` 与 `connect-src` 的 `https:` 由 `allowRemote` 控制；
 * - 禁止子 frame 与表单提交（少两条外传与钓鱼路径）；
 * - `base-uri` 锁死，页面自己不能再改基址。
 *
 * 注意这挡不住「脚本拼一个 URL 再 location.href 跳过去」；带上 `https:` 之后，
 * `<img src=https://…?data>` / `<script src=https://…?data>` 也是同类外传通道 ——
 * 「允许脚本」本身就意味着不能把「数据不出本机」当作承诺。
 */
function cspFor(baseUrl: string | null, allowRemote: boolean): string {
  const origin = baseUrl ? originOf(baseUrl) : ''
  const scheme = origin ? origin.split('://')[0] : ''
  // 自定义 scheme 在部分 WebView 上按 host-source 匹配不稳，额外给一个 scheme-source 兜底；
  // http / https **不加**（那会放宽成「允许任意网站」）。
  const customScheme =
    scheme && scheme !== 'http' && scheme !== 'https' ? ` ${scheme}:` : ''
  const local = origin ? ` ${origin}${customScheme}` : ''
  const remote = allowRemote ? ' https:' : ''
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${local}${remote}`,
    `style-src 'unsafe-inline'${local} https:`,
    `img-src${local} data: blob: https:`,
    `media-src${local} blob: https:`,
    `font-src${local} data: https:`,
    // fetch / XHR / WebSocket：只有显式允许外部资源时才放行（默认仍关）
    `connect-src${allowRemote ? ' https:' : " 'none'"}`,
    // three.js 这类库会在 blob worker 里解码（worker 读不到磁盘，只是执行页面自己的代码）
    `worker-src blob:${remote}`,
    "frame-src 'none'",
    "form-action 'none'",
    `base-uri${origin ? ` ${origin}` : " 'none'"}`,
  ].join('; ')
}

/**
 * 页面「需要什么权限」的探测（纯函数）—— 供预览区的提示条用。
 *
 * 为什么要有它：被 sandbox / CSP 挡住时，用户能看到的只有控制台里那句英文报错，
 * 而界面上什么都没发生 —— 提示条把「为什么没跑」和「点哪里开」放回页面里。
 */
export interface PreviewNeeds {
  /** 页面里有脚本（内联 / importmap / 外链）：不开「允许运行脚本」一个都跑不了 */
  hasScripts: boolean
  /** 有 https 外链脚本（CDN）：还需要「允许外部资源」 */
  hasRemoteScripts: boolean
}

export function previewNeeds(html: string): PreviewNeeds {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const scripts = Array.from(doc.querySelectorAll('script'))
  return {
    hasScripts: scripts.length > 0,
    hasRemoteScripts: scripts.some((script) =>
      /^https:/i.test(script.getAttribute('src') ?? ''),
    ),
  }
}

/**
 * 把用户 HTML 变成可安全塞进 iframe 的完整文档。
 *
 * @param html 文件内容（草稿）
 * @param baseUrl 本地资源协议基址；`null` = 登记失败 / 不需要相对资源
 * @param allowScripts 是否给脚本执行权限（同时决定是否注入 CSP）
 * @param allowRemote 是否允许**外部脚本与网络请求**（CDN 库 / fetch）；静态资源不受它控制
 */
export function buildPreviewDocument(
  html: string,
  baseUrl: string | null,
  allowScripts: boolean,
  allowRemote = false,
): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const head = doc.head

  // 用户自带的 <base> 一律移除：基址只能由我们给（否则页面可把自己指到任意位置）
  for (const base of Array.from(doc.querySelectorAll('base'))) {
    base.remove()
  }

  if (baseUrl) {
    const base = doc.createElement('base')
    base.setAttribute('href', baseUrl)
    head.insertBefore(base, head.firstChild)
  }

  if (allowScripts) {
    const meta = doc.createElement('meta')
    meta.setAttribute('http-equiv', 'Content-Security-Policy')
    meta.setAttribute('content', cspFor(baseUrl, allowRemote))
    head.insertBefore(meta, head.firstChild)
  }

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`
}
