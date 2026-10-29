/**
 * MCP 配置的**编辑态**纯逻辑：默认值、校验、文本框 ↔ 结构互转。
 *
 * ⚠️ 校验规则在 Rust（`mcp::config::validate`）与这里各有一份，语义必须一致 ——
 * 前端这份只为「边填边提示 + 不必等一次 IPC 往返」，落库前的最终裁决仍在 Rust
 *（`cmd_mcp_upsert` 会再校验一次，两侧不一致时以 Rust 为准）。
 */
import type {
  McpApproval,
  McpServerConfig,
  McpServerState,
  McpTransportKind,
} from './types'

/** 服务器名长度上限（只影响展示与审批档查找；工具公开名里已不含它） */
export const MAX_SERVER_NAME_LEN = 32

/** 工具公开名长度上限（与 Rust `mcp::naming::MAX_PUBLIC_NAME_LEN` 同值：provider 函数名硬上限） */
export const MAX_TOOL_NAME_LEN = 64

/** 旧版公开名的前缀：别名不得占用（否则会被旧数据当成 `mcp__<server>__<raw>`） */
export const LEGACY_TOOL_NAME_PREFIX = 'mcp__'

/** 默认值（与 Rust serde 默认一致；新建服务器从这里出发） */
export const DEFAULT_MCP_TIMEOUTS = {
  toolCallTimeoutMs: 60_000,
  startupTimeoutMs: 30_000,
} as const

export const DEFAULT_MCP_RECONNECT = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
} as const

/** 新建一台服务器的空白草稿（id 每次新建） */
export function createMcpServerDraft(
  transport: McpTransportKind = 'stdio',
): McpServerConfig {
  return {
    id: newId(),
    name: '',
    enabled: true,
    transport,
    command: '',
    args: [],
    env: {},
    url: '',
    headers: {},
    // 默认「直接执行」：与内置工具的缺省放行同口径（新建服务器不弹审批打扰）；
    // 想收紧的用户在弹窗里改成「每次确认」或「禁用」。
    // 注意：从 JSON 导入是例外 —— Rust 侧 `import.rs` 显式写 ask（那是别人写的配置）。
    approval: 'allow',
    ...DEFAULT_MCP_TIMEOUTS,
    reconnect: { ...DEFAULT_MCP_RECONNECT },
    enabledTools: undefined,
    injectInstructions: true,
  }
}

/** uuid（浏览器 / WebView 都有 `crypto.randomUUID`；测试环境没有时退化为随机串） */
export function newId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 服务器名是否合法（返回错误文案；合法 → null）。与 Rust `validate_server_name` 同语义 */
export function validateServerName(name: string): string | null {
  if (!name) return '服务器名不能为空'
  if (name.length > MAX_SERVER_NAME_LEN) {
    return `服务器名不能超过 ${MAX_SERVER_NAME_LEN} 个字符`
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return '服务器名只能包含字母、数字、下划线和连字符'
  }
  if (name.includes('__')) {
    return '服务器名不能包含连续下划线（__ 是工具名分隔符）'
  }
  return null
}

/**
 * 用户自定义工具名（别名）的合法性：错误文案 / `null`。
 *
 * 与 Rust `mcp::naming::validate_tool_alias` 同语义，且同样是**只校验、不纠正**：界面上看到的名字
 * 必须就是下发给模型的名字（静默归一化会变成「我明明填了却不是我填的」）。
 */
export function validateMcpToolAlias(alias: string): string | null {
  if (!alias) return '工具名不能为空'
  if (!/^[A-Za-z0-9_-]+$/.test(alias)) {
    return '工具名只能包含字母、数字、下划线和连字符'
  }
  if (alias.length > MAX_TOOL_NAME_LEN) {
    return `工具名不能超过 ${MAX_TOOL_NAME_LEN} 个字符`
  }
  if (alias.startsWith(LEGACY_TOOL_NAME_PREFIX)) {
    return `工具名不能以 ${LEGACY_TOOL_NAME_PREFIX} 开头`
  }
  return null
}

/** 单条配置校验（返回第一条错误；合法 → null）。与 Rust `McpServerConfig::validate` 同语义 */
export function validateMcpConfig(config: McpServerConfig): string | null {
  const nameError = validateServerName(config.name)
  if (nameError) return nameError
  if (!config.id) return '服务器缺少 id'
  if (!(config.toolCallTimeoutMs > 0)) return `${config.name}：单次调用超时必须大于 0`
  if (!(config.startupTimeoutMs > 0)) return `${config.name}：启动超时必须大于 0`
  if (config.enabledTools?.some((tool) => !tool.trim())) {
    return `${config.name}：工具白名单里有空名字`
  }
  // 别名：自洽校验（非法字符 / 与内置重名不在这里拦 —— 后者是发布期判定）
  const seenAliases = new Set<string>()
  for (const [raw, alias] of Object.entries(config.toolAliases ?? {})) {
    if (!raw.trim()) return `${config.name}：工具别名缺少原始工具名`
    const aliasError = validateMcpToolAlias(alias)
    if (aliasError) return `${config.name}（${raw}）：${aliasError}`
    if (seenAliases.has(alias)) return `${config.name}：工具名重复：${alias}`
    seenAliases.add(alias)
  }
  if (config.transport === 'stdio') {
    if (!config.command?.trim()) return `${config.name}：命令不能为空`
  } else {
    const url = config.url ?? ''
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return `${config.name}：URL 必须以 http:// 或 https:// 开头`
    }
  }
  return null
}

/** 一批配置：逐条校验 + 名字不得重复（返回第一条错误；合法 → null） */
export function validateMcpConfigs(configs: McpServerConfig[]): string | null {
  const seen = new Set<string>()
  for (const config of configs) {
    const error = validateMcpConfig(config)
    if (error) return error
    if (seen.has(config.name)) return `服务器名重复：${config.name}`
    seen.add(config.name)
  }
  return null
}

/**
 * 别名表的**一次编辑**（纯函数）：`value` 空 / 等于服务器原名时删掉该条目（恢复默认）。
 *
 * 返回 `undefined` = 整张表空了 —— 与 Rust 的 `skip_serializing_if = "BTreeMap::is_empty"`
 * 同口径（不往配置里写空对象）。
 */
export function withToolAlias(
  aliases: Record<string, string> | undefined,
  rawName: string,
  value: string,
): Record<string, string> | undefined {
  const next = { ...(aliases ?? {}) }
  const trimmed = value.trim()
  if (!trimmed || trimmed === rawName) delete next[rawName]
  else next[rawName] = trimmed
  return Object.keys(next).length > 0 ? next : undefined
}

/** 审批三态的可选项（设置页按此渲染，文案走 i18n） */
export const MCP_APPROVAL_OPTIONS: Array<{ value: McpApproval }> = [
  { value: 'ask' },
  { value: 'allow' },
  { value: 'deny' },
]

// ==================== 文本框 ↔ 结构 ====================

/** 每行一个参数（空行忽略） */
export function textToArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function argsToText(args?: string[]): string {
  return (args ?? []).join('\n')
}

/**
 * `KEY=value` 每行一个。值里允许出现 `=`（只在第一个 `=` 处切分）；
 * 空行与 `#` 开头的行忽略（贴一段带注释的脚本也能用）。
 */
export function textToPairs(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!key) continue
    out[key] = line.slice(index + 1).trim()
  }
  return out
}

export function pairsToText(pairs?: Record<string, string>): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/**
 * HTTP 头：`Name: value` 每行一个（Colon 后可有空格）。
 * 与 env 分开是因为 header 名里可以有 `-`，而人们习惯写成 `Authorization: Bearer x`。
 */
export function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!key) continue
    out[key] = line.slice(index + 1).trim()
  }
  return out
}

export function headersToText(headers?: Record<string, string>): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

/** 每行一个工具名（白名单）；空文本 = 不限制（`undefined`，不是 `[]`） */
export function textToEnabledTools(text: string): string[] | undefined {
  const tools = textToArgs(text)
  return tools.length > 0 ? tools : undefined
}

export function enabledToolsToText(tools?: string[]): string {
  return argsToText(tools)
}

/**
 * 状态 → 展示用的严重度（决定胶囊配色）：
 * - `ready` 正常；`connecting` / `backoff` 过渡（黄）；`failed` / `error` 异常（红）；
 * - `disabled` 中性（灰）。
 */
export function stateTone(
  state: McpServerState,
): 'ok' | 'warn' | 'error' | 'muted' {
  switch (state) {
    case 'ready':
      return 'ok'
    case 'connecting':
    case 'backoff':
      return 'warn'
    case 'failed':
    case 'error':
      return 'error'
    default:
      return 'muted'
  }
}
