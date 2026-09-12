/**
 * telemetry/redact — 脱敏（§7.1 正文上报安全兜底）
 *
 * 强制项：采集与上传前都必须经过密钥模式打码。
 * - 密钥模式扫描（OpenAI / Anthropic / Gemini / Bearer / 私钥块）
 * - 敏感字段名打码（apiKey / token / secret / password / authorization）
 * - 系统用户名路径前缀替换为 ~
 * - 稳定短哈希（用于 path_hash 等去重，非加密用途）
 */

/** 需要整段替换为 [REDACTED] 的密钥模式 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  // OpenAI 风格
  /sk-[A-Za-z0-9]{20,}/g,
  // Google / Gemini
  /AIza[0-9A-Za-z\-_]{35}/g,
  // Bearer / Authorization 头
  /Bearer\s+[A-Za-z0-9\-_.]{20,}/gi,
  // 私钥块
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/** 通用字段：api_key / token / secret / password / authorization 后的值 */
const GENERIC_FIELD_PATTERN =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|authorization)\s*["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi

/**
 * 命中则整体打码的字段名模式（用于对象键名）
 *
 * 注意：不要匹配裸 `token` 子串。否则 `first_token_ms` / `tokens` / `max_tokens` /
 * `token_count` 等「度量」字段也会被整段打码成 `***`（曾导致 chat.stream.first_token
 * 的 first_token_ms 上报为 "***"）。仅当键「以 token 结尾」（token / access_token /
 * refreshToken …）或命中明确的鉴权限定词时才视为敏感。
 */
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|bearer[_-]?token|session[_-]?token|token$|secret|password|passwd|authorization|credential|private[_-]?key)/i

/** 打码占位符 */
export const REDACTED = '[REDACTED]'

/**
 * 对字符串做密钥模式打码
 */
export function redactString(input: string): string {
  if (!input) return input
  let out = input
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED)
  }
  out = out.replace(GENERIC_FIELD_PATTERN, `$1${REDACTED}`)
  // §7.1：系统用户名路径前缀替换为 ~。
  // 并入采集链统一兜底，保证 error stack / 工具入参 / 命令 / backtrace 等
  // 任意字符串都经过路径脱敏，而非仅导出时处理。
  out = redactPath(out)
  return out
}

/** 判断字段名是否敏感 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/**
 * 递归打码任意值（对象/数组/字符串）
 * - 敏感键名 → 值替换为 '***'
 * - 字符串 → 密钥模式打码
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (value == null || depth > 12) return value
  if (typeof value === 'string') return redactString(value) as unknown as T
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1)) as unknown as T
  }
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(value as Record<string, any>)) {
    if (isSensitiveKey(k)) {
      out[k] = '***'
    } else {
      out[k] = redactDeep(v, depth + 1)
    }
  }
  return out as unknown as T
}

/**
 * 系统用户名路径前缀脱敏：
 *   C:\Users\alice\proj  → ~\proj
 *   /Users/alice/proj    → ~/proj
 *   /home/alice/proj     → ~/proj
 */
export function redactPath(path: string): string {
  if (!path || typeof path !== 'string') return path
  return path
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/]+/gi, '~')
    .replace(/\/(?:Users|home)\/[^/\\]+/g, '~')
}

/** 仅取 URL 的 host（去 query / path） */
export function urlHost(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    // 无协议头时补齐再解析
    try {
      return new URL('https://' + url.replace(/^\/+/, '')).host
    } catch {
      return ''
    }
  }
}

/**
 * 截断过长文本（用于工具输出等，§12.6 截断上限）
 */
export function truncateText(input: string, max = 16384): string {
  if (typeof input !== 'string') return input
  if (input.length <= max) return input
  return input.slice(0, max) + `\n…[truncated ${input.length - max} chars]`
}

/**
 * 稳定短哈希（FNV-1a 双轮 → 16 进制），用于 path_hash 等去重。
 * 非加密用途，仅需同输入稳定同输出。
 */
export function hashText(input: string, len = 16): string {
  const s = String(input ?? '')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 + c, 2246822519)
  }
  const hex =
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  return hex.slice(0, len)
}
