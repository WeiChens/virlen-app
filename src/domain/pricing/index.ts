/**
 * 定价与费用估算 — 纯函数领域模块
 *
 * 职责边界（重要）：**Rust 只返回 token 数，费用一律在前端算**。
 * 单价是用户可编辑的设置项，若把乘法写进 SQL，用户改一次单价就要回填整张账本表。
 *
 * 口径说明：
 * - 单价单位统一为「每 1,000,000 tokens 的金额」，币种由设置里的 `currency` 决定；
 * - 账本里的 `promptTokens` 是**非缓存输入**（Anthropic 语义），缓存量单独记在
 *   `cachedTokens` 里，因此可以按不同单价分别计费；
 * - 内置价目表仅作**默认填充**用途，价格随时会变 —— UI 必须提示用户核对（见 §价目表注释）。
 */

/** 单个模型的单价（每 1M tokens） */
export interface ModelPrice {
  /** 输入价 */
  input: number
  /** 输出价 */
  output: number
  /** 缓存命中输入价（未填/为 0 时按输入价计） */
  cachedInput?: number
}

/** 一次（或一批）调用的费用拆解 */
export interface TokenCost {
  /** 非缓存输入部分费用 */
  input: number
  /** 输出部分费用 */
  output: number
  /** 缓存部分费用 */
  cached: number
  /** 合计 */
  total: number
}

/** 参与计费的 token 三元组（与 `usage_ledger` 的列同名） */
export interface BillableTokens {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

/** 每 1M tokens 的换算基数 */
const PER_TOKENS = 1_000_000

/**
 * 计算费用。
 *
 * 任何字段缺失（无限价 / 全 0）都返回 0，不抛错 —— 统计面板里「没填单价」
 * 应当是显示 0 而不是让整个页面挂掉。
 */
export function computeCost(
  tokens: BillableTokens,
  price: ModelPrice | null | undefined,
): TokenCost {
  if (!price) return { input: 0, output: 0, cached: 0, total: 0 }
  const input = ((tokens.promptTokens || 0) * (price.input || 0)) / PER_TOKENS
  const output =
    ((tokens.completionTokens || 0) * (price.output || 0)) / PER_TOKENS
  // 缓存价缺省时按输入价计（大多数服务商都低于输入价，但缺省宁可高估不高漏）
  const cachedRate = price.cachedInput || price.input || 0
  const cached = ((tokens.cachedTokens || 0) * cachedRate) / PER_TOKENS
  return { input, output, cached, total: input + output + cached }
}

/** 账本 → 单价表的键：Provider 配置 id + 模型 id */
export function priceKey(providerConfigId: string, modelId: string): string {
  return `${providerConfigId}::${modelId}`
}

/** 内置价目表条目：按模型 id 关键词匹配 */
export interface DefaultPriceEntry {
  /** 匹配关键词（对模型 id 做忽略大小写的子串匹配，命中即用） */
  match: string[]
  /** 展示名（UI 里显示"这是哪个模型的价"） */
  label: string
  price: ModelPrice
}

/**
 * 内置价目表（**预估值，务必提示用户核对**）。
 *
 * ⚠️ 这些数字来自公开定价的粗略整理，服务商会随时调价、也可能按量阶梯计价，
 * 因此本表只用于「新用户开箱时有个大致量级」，UI 必须醒目提示
 * 「费用为按你填写的单价估算，非账单」。用户可在设置里覆盖任意模型。
 *
 * 币种统一为 USD / 1M tokens（DeepSeek 官方定价为人民币，此处按量级折算）。
 * 匹配顺序自上而下，先命中先用。
 */
export const DEFAULT_MODEL_PRICES: DefaultPriceEntry[] = [
  // ---- OpenAI ----
  {
    match: ['gpt-4o-mini'],
    label: 'GPT-4o mini',
    price: { input: 0.15, output: 0.6, cachedInput: 0.075 },
  },
  {
    match: ['gpt-4o', 'chatgpt-4o'],
    label: 'GPT-4o',
    price: { input: 2.5, output: 10, cachedInput: 1.25 },
  },
  {
    match: ['gpt-4.1-mini'],
    label: 'GPT-4.1 mini',
    price: { input: 0.4, output: 1.6, cachedInput: 0.1 },
  },
  {
    match: ['gpt-4.1'],
    label: 'GPT-4.1',
    price: { input: 2, output: 8, cachedInput: 0.5 },
  },
  {
    match: ['o4-mini', 'o3-mini'],
    label: 'o 系列（推理）',
    price: { input: 1.1, output: 4.4, cachedInput: 0.275 },
  },
  {
    match: ['deepseek-reasoner', 'deepseek-r1'],
    label: 'DeepSeek R1 / reasoner',
    price: { input: 0.55, output: 2.19, cachedInput: 0.14 },
  },
  {
    match: ['deepseek'],
    label: 'DeepSeek V3 / chat',
    price: { input: 0.28, output: 0.42, cachedInput: 0.028 },
  },
  // ---- Anthropic ----
  {
    match: ['claude-opus-4', 'claude-3-opus'],
    label: 'Claude Opus',
    price: { input: 15, output: 75, cachedInput: 1.5 },
  },
  {
    match: ['claude-sonnet-4', 'claude-3-7-sonnet', 'claude-3-5-sonnet'],
    label: 'Claude Sonnet',
    price: { input: 3, output: 15, cachedInput: 0.3 },
  },
  {
    match: ['claude-haiku', 'claude-3-5-haiku'],
    label: 'Claude Haiku',
    price: { input: 0.8, output: 4, cachedInput: 0.08 },
  },
  // ---- Google ----
  {
    match: ['gemini-2.5-pro', 'gemini-1.5-pro'],
    label: 'Gemini Pro',
    price: { input: 1.25, output: 5, cachedInput: 0.3125 },
  },
  {
    match: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'],
    label: 'Gemini Flash',
    price: { input: 0.1, output: 0.4, cachedInput: 0.025 },
  },
]

/**
 * 按模型 id 查内置默认价**条目**（找不到返回 null）。
 *
 * 用子串匹配而不是精确匹配：模型 id 常带日期/版本后缀
 * （`gpt-4o-2024-08-06`、`claude-3-5-sonnet-20241022`），精确匹配会几乎全落空。
 *
 * UI 需要「价 + 展示名」两样东西（单价页要把内置价回显到输入框里），
 * 因此这里返回整条而不是只返回 price；`findDefaultPrice` 是它的薄封装。
 */
export function findDefaultPriceEntry(modelId: string): DefaultPriceEntry | null {
  const id = (modelId || '').toLowerCase()
  if (!id) return null
  for (const entry of DEFAULT_MODEL_PRICES) {
    if (entry.match.some((m) => id.includes(m))) return entry
  }
  return null
}

/**
 * 按模型 id 查内置默认价（找不到返回 null，UI 显示"未配置单价"）。
 */
export function findDefaultPrice(modelId: string): ModelPrice | null {
  return findDefaultPriceEntry(modelId)?.price ?? null
}

/** 金额展示：小额保留更多位，避免 $0.00 一片空白 */
export function formatCost(amount: number, currency = 'USD'): string {
  const symbol =
    currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
  if (!Number.isFinite(amount) || amount <= 0) return `${symbol}0`
  if (amount < 0.01) return `${symbol}${amount.toFixed(4)}`
  if (amount < 1) return `${symbol}${amount.toFixed(3)}`
  return `${symbol}${amount.toFixed(2)}`
}

/** token 数展示：1234 → 1.2k，1234567 → 1.23M */
export function formatTokens(tokens: number): string {
  const n = tokens || 0
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return `${(n / 1_000_000).toFixed(2)}M`
}
