/**
 * Markdown 正文里 `<img src>` 的分类与本地路径归一化（纯函数，无 IO）。
 *
 * AI 给的图片地址有三种画风，必须先分清「谁去加载」：
 * 1. `http(s)` / `data:` / `blob:` / 协议相对 `//host/x.png` —— 浏览器自己能加载，原样交给 `<img>`；
 * 2. `file:///C:/a.png` —— 去掉 scheme 再当本地路径（webview 不能直接加载 `file:`）；
 * 3. 其余一律当本地路径：`C:\a.png`、`/home/a.png`、`./shots/a.png`、`shots/a.png`
 *    （相对路径相对**工作目录**，由 `services/local-image-service` 过安全校验后读盘）。
 *
 * ⚠️ 为什么不按「有 scheme 就算远程」偷懒：Windows 盘符 `C:` 在 URL 语法里也长得像 scheme，
 * react-markdown 默认的 `defaultUrlTransform` 正是这样把 `C:/a.png` 整条清空的
 * （见 `message/markdown-renderer.tsx` 里为什么必须自定义 `urlTransform`）。
 */

import { imageDisplaySrc, isAttachmentRef } from './attachment-src'

/** `inline` = 浏览器自己能加载；`local` = 要过安全校验后读盘 */
export type ImageSrcKind = 'inline' | 'local'

export interface ParsedImageSrc {
  kind: ImageSrcKind
  /** inline：原样的 URL；local：归一化后的路径（已去 `file://`、已解码 `%20`），可能仍是相对路径 */
  value: string
  /** 原始写法（失败提示里给用户看，别让人猜到底是哪个地址没加载出来） */
  raw: string
}

/** 浏览器自己能加载的：http(s) / data / blob / 协议相对 */
const INLINE_SRC = /^(?:https?:|data:|blob:|\/\/)/i

/** 把 `%20` 这类百分号编码还原；不是合法编码（路径里真的有 `%`）就原样返回 */
function decodePath(path: string): string {
  if (!path.includes('%')) return path
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * `file:` URL → 本地路径。
 *
 * 三种写法都要认（AI 三种都会写）：
 * - `file:///C:/a.png` → `C:/a.png`（盘符前那个多余的斜杠要去掉，否则 Windows 上打不开）
 * - `file://server/share/a.png` → `//server/share/a.png`（UNC 共享）
 * - `file:/C:/a.png` / `file:C:/a.png` → 按去掉 scheme 处理（非标准但很常见）
 */
export function fileUrlToPath(url: string): string {
  const trimmed = url.trim()
  const withAuthority = /^file:\/\/(.*)$/i.exec(trimmed)
  let rest: string

  if (withAuthority) {
    rest = withAuthority[1]
    // file:// 后面不跟斜杠 = 主机名（UNC 共享），补回 `//` 才是合法路径
    if (rest && !rest.startsWith('/')) rest = `//${rest}`
  } else {
    rest = trimmed.replace(/^file:/i, '')
  }

  // `file:///C:/a.png` 取出来是 `/C:/a.png` —— 盘符前不能有斜杠
  if (/^\/[A-Za-z]:([\\/]|$)/.test(rest)) rest = rest.slice(1)

  return decodePath(rest)
}

/** 判定一个 `src` 该交给浏览器还是交给本地读取层 */
export function parseImageSrc(input: string): ParsedImageSrc {
  const raw = (input ?? '').trim()
  if (!raw) return { kind: 'local', value: '', raw }

  // 图片附件引用：翻译成自定义协议 URL 交给浏览器（字节由 Rust 协议处理器读，不走本地读盘层）
  if (isAttachmentRef(raw)) return { kind: 'inline', value: imageDisplaySrc(raw), raw }

  if (INLINE_SRC.test(raw)) return { kind: 'inline', value: raw, raw }

  if (/^file:/i.test(raw)) return { kind: 'local', value: fileUrlToPath(raw), raw }

  // 剩下的都当本地路径：盘符 / POSIX 绝对 / 相对工作目录
  return { kind: 'local', value: decodePath(raw), raw }
}
