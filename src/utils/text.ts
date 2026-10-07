/**
 * 文本截断 / 清洗工具 —— **保证不产生孤立代理（lone surrogate）**。
 *
 * ⚠️ JS 字符串是 UTF-16，slice 按码元切，emoji 等非 BMP 字符占两码元 —— 切在中间就得到孤立代理；它经
 * JSON.stringify 变成 `\ud83d`，Rust 侧 serde_json 要求高低代理成对，直接报 unexpected end of hex escape 让整次
 * invoke 失败（只有一串列号，极难定位）。凡会被序列化到 Rust（IPC / 落库）或被 LLM 读到的截断，
 * 都必须用 sliceHead / sliceTail，不要直接 slice(0, n)。
 */

/** 高代理（U+D800–U+DBFF）：必须紧跟低代理才构成合法字符 */
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff
/** 低代理（U+DC00–U+DFFF）：必须紧跟在高代理之后才合法 */
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

/**
 * 取前 `max` 个字符（代理对安全）。截断点落在低代理上 = 切开了代理对，此时少取一个字符，让 emoji 整体落到省略侧。
 */
export function sliceHead(text: string, max: number): string {
  if (max <= 0) return ''
  if (max >= text.length) return text
  // max 位置的码元是低代理 → 说明 text[max-1] 是高代理（切开了代理对），退一格
  return text.slice(0, isLowSurrogate(text.charCodeAt(max)) ? max - 1 : max)
}

/**
 * 取后 `count` 个字符（代理对安全）。起点落在低代理上 = 切开了代理对，此时从下一字符开始，宁可少一个。
 */
export function sliceTail(text: string, count: number): string {
  if (count <= 0) return ''
  if (count >= text.length) return text
  const start = text.length - count
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start)
}

/**
 * 是否含孤立代理（命中即返回，正常文本只做一次线性扫描）—— 用于「零成本兜底」，无问题时调用方无需复制。
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (isHighSurrogate(c)) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (!isLowSurrogate(next)) return true
      i++ // 合法的代理对一起跳过
    } else if (isLowSurrogate(c)) {
      return true
    }
  }
  return false
}

/**
 * 删除孤立代理（IPC 兜底用）：只丢「残缺的那半个字符」，不影响其余内容；无孤立代理时原样返回（不新建字符串）。
 */
export function stripLoneSurrogates(text: string): string {
  if (!hasLoneSurrogate(text)) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (isHighSurrogate(c)) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (isLowSurrogate(next)) {
        out += text[i] + text[i + 1]
        i++
      }
      continue
    }
    if (isLowSurrogate(c)) continue
    out += text[i]
  }
  return out
}

/**
 * 文本行数（**末尾空行不算**）：工具输出几乎都以换行结尾，不扣掉会每条多报一行，引发对其它数字的怀疑。
 */
export function countLines(text: string): number {
  const body = text.replace(/\n+$/, '')
  return body.trim() ? body.split('\n').length : 0
}

/** 纯对象判定：只递归普通对象，避免破坏 Date / ArrayBuffer 等实例 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 深拷贝式清洗任意 JSON 结构里的孤立代理（IPC 边界兜底）。
 *
 * 只在检测到问题时才重建对象 / 字符串（命中前不产生任何拷贝），1MB payload 也只是几毫秒的线性扫描。
 * 用于「来源不可控」的入口：模型输出、第三方网关返回、用户粘贴等。
 */
export function sanitizeLoneSurrogates<T>(value: T): T {
  if (typeof value === 'string') {
    return (
      hasLoneSurrogate(value) ? stripLoneSurrogates(value) : value
    ) as unknown as T
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const cleaned = sanitizeLoneSurrogates(item)
      if (cleaned !== item) changed = true
      return cleaned
    })
    return (changed ? next : value) as unknown as T
  }
  if (value && typeof value === 'object' && isPlainObject(value)) {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = sanitizeLoneSurrogates(item)
      if (cleaned !== item) changed = true
      next[key] = cleaned
    }
    return (changed ? next : value) as T
  }
  return value
}
