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
 * 固定汇率：1 USD = 7.2 CNY。
 *
 * 内置价目表（`DEFAULT_MODEL_PRICES`）固定按 USD 存储，切人民币时按此折算，不联网、
 * 不随时间更新（只求量级正确）；用户可在单价页覆写为实际签约价。
 */
export const USD_TO_CNY = 7.2

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
 * 这些数字来自公开定价的粗略整理，服务商随时调价或按量阶梯计价，故本表只用于「开箱时
 * 有个大致量级」；UI 必须醒目提示「费用为按你填写的单价估算，非账单」，用户可覆盖任意模型。
 *
 * 币种统一为 USD / 1M tokens（DeepSeek 官方定价为人民币，此处按量级折算）。
 * 切到人民币时按 `USD_TO_CNY` 折算（见 `convertFromUsd`）；用户自填单价按其币种原样使用。
 * 匹配顺序自上而下，先命中先用；同一厂商内**越具体的 match 越靠前**
 * （如 `gpt-5.6-luna` 必须排在泛化的 `gpt-5.6` 之前）。
 *
 * 最近一次核对：2026-09-21。来源：Anthropic 官方定价页（anthropic.com/pricing）、
 * DeepSeek 官方文档（api-docs.deepseek.com）、OpenRouter 模型 API（结构化）及公开报道；
 * 各条目的口径与存疑点见其上方注释。GLM / 千问为人民币计价，暂未并入本表。
 */
export const DEFAULT_MODEL_PRICES: DefaultPriceEntry[] = [
  // ---- OpenAI（当前代，核对于 2026-09-21）----
  // 来源：OpenRouter 模型 API（结构化）+ 公开报道。
  {
    match: ['gpt-6-astra', 'gpt-astra'],
    label: 'GPT-6 Astra',
    price: { input: 10, output: 50, cachedInput: 1 },
  },
  {
    match: ['gpt-5.6-luna', 'gpt-luna'],
    label: 'GPT-5.6 Luna',
    price: { input: 0.2, output: 1.2, cachedInput: 0.02 },
  },
  {
    match: ['gpt-5.6-terra', 'gpt-terra'],
    label: 'GPT-5.6 Terra',
    price: { input: 2, output: 12, cachedInput: 0.2 },
  },
  {
    // 口径冲突：OpenRouter 标 $2/$10，财联社 / 钛媒体报道 $5/$30；此处取 OpenRouter。
    match: ['gpt-5.6-sol', 'gpt-sol'],
    label: 'GPT-5.6 Sol',
    price: { input: 2, output: 10, cachedInput: 0.2 },
  },
  {
    match: ['gpt-5.6'],
    label: 'GPT-5.6',
    price: { input: 2, output: 10, cachedInput: 0.2 },
  },
  {
    match: ['gpt-5.5'],
    label: 'GPT-5.5',
    price: { input: 5, output: 30, cachedInput: 0.5 },
  },
  {
    match: ['gpt-5.4'],
    label: 'GPT-5.4',
    price: { input: 2.5, output: 15, cachedInput: 0.25 },
  },
  // ---- OpenAI（上一代，保留兼容）----
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
  // ---- DeepSeek（当前代，官方 api-docs.deepseek.com/quick_start/pricing）----
  // 官方分峰值 / 非峰值（非峰值 = 峰值一半，覆盖周末与中国法定节假日）；此处取非峰值。
  {
    match: ['deepseek-v4-pro', 'deepseek-pro'],
    label: 'DeepSeek V4 Pro',
    price: { input: 0.66, output: 1.98, cachedInput: 0.022 },
  },
  {
    match: ['deepseek-flash', 'deepseek-v4-flash'],
    label: 'DeepSeek V4 Flash',
    price: { input: 0.15, output: 0.6, cachedInput: 0.003 },
  },
  // ---- DeepSeek（上一代，保留兼容）----
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
  // ---- Anthropic（当前代，官方 anthropic.com/pricing）----
  {
    match: ['claude-fable'],
    label: 'Claude Fable 5.1',
    price: { input: 10, output: 50, cachedInput: 0.25 },
  },
  {
    match: ['claude-opus-5'],
    label: 'Claude Opus 5',
    price: { input: 5, output: 25, cachedInput: 0.5 },
  },
  {
    match: ['claude-sonnet-5'],
    label: 'Claude Sonnet 5',
    price: { input: 2, output: 10, cachedInput: 0.2 },
  },
  {
    match: ['claude-haiku-4-5', 'claude-haiku-4.5'],
    label: 'Claude Haiku 4.5',
    price: { input: 1, output: 5, cachedInput: 0.1 },
  },
  // ---- Anthropic（上一代，保留兼容）----
  {
    // 该条连带命中 claude-opus-4.5 ~ 4.8（官方 $5/$25、缓存 $0.50），此处沿用旧价
    // $15/$75（Claude 3 Opus 档）；如需精确请在单价页覆盖。
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
  // ---- Google（当前代）----
  {
    match: ['gemini-3.7-flash'],
    label: 'Gemini 3.7 Flash',
    price: { input: 0.75, output: 3.75 },
  },
  {
    match: ['gemini-3.6-flash'],
    label: 'Gemini 3.6 Flash',
    price: { input: 1.5, output: 7.5 },
  },
  {
    match: ['gemini-3.5-flash'],
    label: 'Gemini 3.5 Flash',
    price: { input: 1.5, output: 9 },
  },
  {
    match: ['gemini-3.1-flash-lite'],
    label: 'Gemini 3.1 Flash-Lite',
    price: { input: 0.25, output: 1.5 },
  },
  {
    match: ['gemini-3.1-pro', 'gemini-3-pro'],
    label: 'Gemini 3 Pro',
    price: { input: 2, output: 12 },
  },
  // ---- Google（上一代，保留兼容）----
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
 *
 * 注意：返回的是**原始 USD 价**；需要展示币种时请用 `findDefaultPriceInCurrency`。
 */
export function findDefaultPrice(modelId: string): ModelPrice | null {
  return findDefaultPriceEntry(modelId)?.price ?? null
}

/**
 * 价格取整：× 汇率后浮点会出尾巴（`0.66 × 7.2 = 4.752000000000001`），
 * 直接灌进单价输入框很难看。按 6 位小数四舍五入 —— 最低档价（如 $0.003/1M）也足够精度。
 */
function roundPrice(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/**
 * 把「以 USD 标价」的单价折算到目标币种。
 *
 * 只用于**内置价目表**：它固定存 USD，切币种时按 `USD_TO_CNY` 折算；
 * 用户自填的单价一律按当前币种存/算，不走这里（避免二次折算）。
 *
 * 折算后做一次小数清理，避免 `4.752000000000001` 这类浮点尾巴泄漏到 UI。
 */
export function convertFromUsd(price: ModelPrice, currency: string): ModelPrice {
  if (currency !== 'CNY') return price
  return {
    input: roundPrice(price.input * USD_TO_CNY),
    output: roundPrice(price.output * USD_TO_CNY),
    // 缺省缓存价保持 undefined（不臆造一个值，让 computeCost 回退输入价）
    cachedInput:
      price.cachedInput == null
        ? price.cachedInput
        : roundPrice(price.cachedInput * USD_TO_CNY),
  }
}

/** 取内置默认价并折算到目标币种（USD 之外按 `USD_TO_CNY` 折算） */
export function findDefaultPriceInCurrency(
  modelId: string,
  currency: string,
): ModelPrice | null {
  const price = findDefaultPrice(modelId)
  return price ? convertFromUsd(price, currency) : null
}

/** 同上，但返回整条条目（label 原样、price 折算后），供单价页回显 */
export function findDefaultPriceEntryInCurrency(
  modelId: string,
  currency: string,
): DefaultPriceEntry | null {
  const entry = findDefaultPriceEntry(modelId)
  if (!entry) return null
  return { ...entry, price: convertFromUsd(entry.price, currency) }
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
