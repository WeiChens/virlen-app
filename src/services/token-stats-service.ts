/**
 * token-stats-service — 用量统计的应用编排层
 *
 * 职责：
 * 1. 把「时间范围 / 分桶维度」翻译成 Rust 查询参数（本地时区算边界）；
 * 2. 把 token 聚合结果 × 单价表 → 带费用的视图模型（**费用在前端算**，见 `domain/pricing`）；
 * 3. 明细的筛选 / 排序（**客户端执行**：会话 / 模型是子串搜索，而账本表的
 *    `session_id` / `model` 过滤是精确匹配，用不上）；
 * 4. 导出 CSV、清空账本。
 *
 * 单价优先级：用户在设置里配的（`settingsState.modelPricing`）> 内置价目表
 * （`DEFAULT_MODEL_PRICES`，仅作默认填充，UI 必须提示用户核对）。
 *
 * 币种：内置价目表固定存 USD，切到人民币时按 `USD_TO_CNY` 折算出费用；
 * 用户自填的单价按其币种原样使用（不二次折算）。**默认币种为人民币（CNY）**。
 */
import {
  computeCost,
  findDefaultPriceInCurrency,
  priceKey,
  type BillableTokens,
  type ModelPrice,
  type TokenCost,
} from '@/domain/pricing'
import {
  statsRepo,
  type UsageBucket,
  type UsageRecord,
  type UsageRecordPage,
  type UsageStats,
  type UsageStatsQuery,
} from '@/infrastructure/statsRepo'
import { settingsState } from '@/ui/store'
import { t } from '@/ui/i18n'

export type {
  UsageBucket,
  UsageRecord,
  UsageRecordPage,
  UsageStats,
  UsageStatsQuery,
} from '@/infrastructure/statsRepo'

/**
 * 时间范围预设。
 *  - `yesterday`：昨天 0 点 ~ 昨天 23:59:59.999；
 *  - `custom`：由用户指定的绝对时间区间（需同时传入 `customRange`）。
 */
export type UsageRange = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom'

/** 自定义时间区间（绝对时间，Unix ms 闭区间；from / to 顺序无所谓，内部会归一化） */
export interface CustomRange {
  from: number
  to: number
}

/** 分桶维度（与 Rust `usage_group_expr` 白名单一致） */
export type UsageGroupBy =
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'model'
  | 'session'
  | 'kind'
  | 'provider'

/** 带费用的聚合桶 */
export interface CostedBucket extends UsageBucket {
  cost: TokenCost
}

/** 带费用的合计 */
export interface CostedTotals extends CostedBucket {
  currency: string
}

/** 统计视图模型 */
export interface UsageStatsView {
  /** 当前分桶维度的桶（时间维度已补零 → 轴连续、无断档） */
  buckets: CostedBucket[]
  /**
   * **实际生效**的分桶维度。时间维度上可能比用户所选更粗（跨度过大自动降级，
   * 见 `MAX_TIME_BUCKETS`）—— UI 必须用它来判断轴标签与图表类型，
   * 否则降级后标签会按旧粒度切（如按天数据切成小时样式）。
   */
  groupBy: UsageGroupBy
  /** 是否因数据跨度过大而自动降级了粒度（UI 需告知用户实际粒度） */
  degraded: boolean
  /**
   * 按「模型」分桶的桶（与 `buckets` 的过滤条件相同）。
   * 两处用途：合计费用（跨模型的钱只能逐模型算）、饼图按模型归类。
   */
  modelBuckets: CostedBucket[]
  totals: CostedTotals
  /** 账本数据覆盖范围（Unix ms） */
  firstTs: number | null
  lastTs: number | null
}

/** 带费用的明细行 */
export interface CostedRecord extends UsageRecord {
  cost: TokenCost
}

/** 明细排序键（`ts` 为时间，其余为 token 数 / 输出速度） */
export type RecordSortKey =
  | 'ts'
  | 'promptTokens'
  | 'completionTokens'
  | 'cachedTokens'
  | 'totalTokens'
  | 'tokPerSec'

/** 排序方向 */
export type SortDir = 'asc' | 'desc'

/** 明细筛选条件（均为客户端过滤，空串 = 不过滤，大小写不敏感） */
export interface RecordFilter {
  /** 会话标题关键字 */
  sessionKeyword?: string
  /** 模型 id 关键字 */
  modelKeyword?: string
  /** 调用类型（空串 = 全部） */
  kind?: string
}

/**
 * 明细一次拉取的条数上限。
 *
 * 明细页不再服务端分页，而是「一次拉一批 + 内存里筛选/排序/分页」—— 因为会话 / 模型的
 * 关键字搜索是子串匹配，而账本表的 `session_id` / `model` 过滤是精确匹配，下沉不到 SQL；
 * 若只拉当前页，搜索与排序就只会作用于单页（错误）。超过上限时 UI 提示缩小时间范围。
 */
export const RECORDS_LOAD_CAP = 5000

/** 算输出速度所需的最小形状（明细行 / 任意桶都满足） */
export interface RateInput {
  completionTokens: number
  /** 未测量（旧流水）时为 0 / undefined */
  durationMs?: number
}

/**
 * 输出速度（Completion token / 秒）。
 *
 * 口径：`completionTokens ÷ (durationMs / 1000)`，**含首字延迟与思考时间**
 * （服务商面板那种「纯生成阶段」速度需要 TTFT，账本没存，不能凭空假设）。
 * 返回 `null` 表示算不出来（旧流水没记耗时 / 耗时非正 / 没有输出 token）→ UI 显示 `-`，
 * **绝不能当成 0 tok/s**（会把「没数据」误读成「很慢」）。
 */
export function outputTokPerSec(r: RateInput): number | null {
  const ms = r.durationMs ?? 0
  if (ms <= 0 || r.completionTokens <= 0) return null
  return r.completionTokens / (ms / 1000)
}

/**
 * 明细的筛选 + 排序（纯函数）。
 *
 * 排序稳定：数值相等时按时间倒序兜底，否则翻页时同值行顺序会抖动。
 * `tokPerSec` 排序把算不出速度的行当最小值（默认降序时沉底）。
 */
export function filterAndSortRecords(
  records: CostedRecord[],
  filter: RecordFilter,
  sortKey: RecordSortKey,
  sortDir: SortDir,
): CostedRecord[] {
  const sk = (filter.sessionKeyword || '').trim().toLowerCase()
  const mk = (filter.modelKeyword || '').trim().toLowerCase()
  const kind = filter.kind || ''
  const out = records.filter((r) => {
    if (sk && !(r.sessionTitle || '').toLowerCase().includes(sk)) return false
    if (mk && !(r.model || '').toLowerCase().includes(mk)) return false
    if (kind && r.kind !== kind) return false
    return true
  })
  const pick = (r: CostedRecord): number => {
    switch (sortKey) {
      case 'promptTokens':
        return r.promptTokens
      case 'completionTokens':
        return r.completionTokens
      case 'cachedTokens':
        return r.cachedTokens
      case 'totalTokens':
        return r.totalTokens
      case 'tokPerSec':
        return outputTokPerSec(r) ?? -1
      default:
        return r.ts
    }
  }
  const dir = sortDir === 'asc' ? 1 : -1
  out.sort((a, b) => {
    const av = pick(a)
    const bv = pick(b)
    if (av !== bv) return av > bv ? dir : -dir
    return b.ts - a.ts
  })
  return out
}

/**
 * 明细汇总结果。
 *
 * 注意：`summarizeRecords` 对**传入的全部记录**汇总，调用方应传「全部筛选结果」而非当前页 ——
 * 这正是「汇总不是只算当前分页」的关键。
 */
export interface RecordsSummary {
  /** 参与汇总的记录条数（= 全部筛选结果条数） */
  count: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  /** 总费用（逐行 `cost.total` 累加，币种与明细列一致） */
  cost: TokenCost
  /** 加权输出速度（tok/s）；无可测行时为 null */
  tokPerSec: number | null
  /** 参与 tok/s 计算的可测行数（其余行旧流水未记耗时） */
  rateSamples: number
}

/**
 * 明细汇总（Prompt / Completion / Cached / 合计 / 费用 / tok·s）。
 *
 * tok/s 采用**加权口径**：可测行的 Completion 之和 ÷ 可测行耗时之和 —— 相当于把所有可测调用
 * 当成一次连续生成来看，避免「逐行速度再求平均」被大量极小请求拉偏。可测行须同时满足
 * `durationMs > 0` 与 `completionTokens > 0`（旧流水未记耗时 → 不参与，与 `outputTokPerSec` 一致）；
 * 无可测行时返回 null，UI 显示 `-`（不能当 0）。
 */
export function summarizeRecords(records: CostedRecord[]): RecordsSummary {
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let totalTokens = 0
  let rateDurMs = 0
  let rateCompletion = 0
  let rateSamples = 0
  const cost: TokenCost = { input: 0, output: 0, cached: 0, total: 0 }
  for (const r of records) {
    promptTokens += r.promptTokens
    completionTokens += r.completionTokens
    cachedTokens += r.cachedTokens
    totalTokens += r.totalTokens
    cost.input += r.cost.input
    cost.output += r.cost.output
    cost.cached += r.cost.cached
    cost.total += r.cost.total
    if (r.durationMs > 0 && r.completionTokens > 0) {
      rateDurMs += r.durationMs
      rateCompletion += r.completionTokens
      rateSamples++
    }
  }
  return {
    count: records.length,
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens,
    cost,
    tokPerSec: rateDurMs > 0 ? rateCompletion / (rateDurMs / 1000) : null,
    rateSamples,
  }
}

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** 当天的 0 点（本地时区）—— 时间桶在 SQL 里用 'localtime'，边界也必须用本地时间，否则「今日」会按 UTC 切 */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 时间范围 → 查询边界（Unix ms）。`fromTs` / `toTs` 为 undefined 表示该端不过滤。
 *
 * 预设范围（今日 / 近 7 天 / 近 30 天 / 全部）只有「起始」边界，结束端隐含为调用时刻；
 * 而「昨天」与「自定义」必须显式给出结束边界 —— 否则「昨天」会把今天一并算进来。
 * Rust 侧过滤为闭区间（`ts >= fromTs AND ts <= toTs`）。
 */
export function rangeToBounds(
  range: UsageRange,
  now = Date.now(),
  custom?: CustomRange | null,
): { fromTs?: number; toTs?: number } {
  switch (range) {
    case 'today':
      return { fromTs: startOfToday(now) }
    case 'yesterday': {
      const start = startOfToday(now) - DAY_MS
      // 结束端取「今天 0 点 - 1ms」= 昨天的最后一毫秒（配合闭区间恰好覆盖整天）
      return { fromTs: start, toTs: startOfToday(now) - 1 }
    }
    case '7d':
      return { fromTs: startOfToday(now) - 6 * DAY_MS }
    case '30d':
      return { fromTs: startOfToday(now) - 29 * DAY_MS }
    case 'custom': {
      // 缺任一端就当作「不过滤」（UI 应在区间不完整时不触发查询）
      if (!custom) return {}
      return {
        fromTs: Math.min(custom.from, custom.to),
        toTs: Math.max(custom.from, custom.to),
      }
    }
    default:
      return {}
  }
}

/**
 * 时间范围 → 起始时间戳（Unix ms）；无下界返回 undefined。
 * 保留此函数以兼容既有调用 / 测试；需要上界时请改用 `rangeToBounds`。
 */
export function rangeToFromTs(range: UsageRange, now = Date.now()): number | undefined {
  return rangeToBounds(range, now).fromTs
}

// ==================== 时间桶补零（修「断轴」） ====================
//
// Rust 侧聚合是 `GROUP BY bucket_key`：**没有流水的时段压根不产生桶**。
// 照原样画图就会出现「今日只在 7、8 点用过 → 图上只剩两根柱子」，看起来像数据错了。
//
// 补零放在**前端**做：SQL 一次不变（只回有数据的桶），这里按范围生成完整连续的
// 桶 key 序列，把有数据的桶铺上去、缺的补 0。计算量 O(列数)（≤ `MAX_TIME_BUCKETS`），
// 毫秒级 —— 因此**不需要**再建一张表缓存聚合结果，账本表也不留任何冗余列。

/** 时间粒度（与 Rust `usage_group_expr` 的白名单一致） */
export type TimeUnit = 'hour' | 'day' | 'week' | 'month'

/** 降级顺序：小时 → 天 → 周 → 月 */
const TIME_UNITS: TimeUnit[] = ['hour', 'day', 'week', 'month']

/**
 * 时间轴列数上限。超过就自动降一级粒度（小时→天→周→月）。
 *
 * 1000 列以内 echarts 配 `hideOverlap` 仍可读（约 = 41 天的小时 / 2.7 年的天），
 * 再多只会糊成一片。降级只发生在「全部 + 按小时」这类超长跨度上，
 * 且 `loadStats` 会回传 `degraded`，UI 会标注实际粒度。
 */
export const MAX_TIME_BUCKETS = 1000

/** 生成序列的硬上限：真超了就放弃补零（宁可断轴，也不截断既有数据 / 卡死 UI） */
const FILL_HARD_LIMIT = MAX_TIME_BUCKETS * 4

function isTimeUnit(groupBy: UsageGroupBy): groupBy is TimeUnit {
  return (TIME_UNITS as string[]).includes(groupBy)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 某年的第一个周一（对齐 SQLite `strftime('%W')`：1/1 之前的那几天算第 00 周） */
function firstMondayOfYear(year: number): Date {
  const jan1 = new Date(year, 0, 1)
  const offset = (1 - jan1.getDay() + 7) % 7 // 0 表示 1/1 本身就是周一
  return new Date(year, 0, 1 + offset)
}

/**
 * 时刻 → 时间桶 key（**与 Rust `usage_group_expr` 的 strftime 表达式逐字对齐**，
 * 口径不一致就会出现「补零列和数据列并存」的双列）。
 */
export function timeKeyOf(unit: TimeUnit, d: Date): string {
  const y = d.getFullYear()
  switch (unit) {
    case 'hour':
      return `${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}`
    case 'day':
      return `${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    case 'week': {
      const fm = firstMondayOfYear(y)
      const dayStart = new Date(y, d.getMonth(), d.getDate())
      // 四舍五入消掉夏令时造成的 ±1 小时误差（否则正好第 7n 天会算成上一周）
      const days = Math.round((dayStart.getTime() - fm.getTime()) / DAY_MS)
      return `${y}-${pad2(days < 0 ? 0 : Math.floor(days / 7) + 1)}`
    }
    default:
      return `${y}-${pad2(d.getMonth() + 1)}`
  }
}

/** 时间桶 key → 该桶起始时刻；认不出来（口径变化 / 脏数据）返回 null */
export function parseTimeKey(unit: TimeUnit, key: string): Date | null {
  if (unit === 'hour') {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})$/.exec(key)
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4]) : null
  }
  if (unit === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null
  }
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return null
  if (unit === 'month') return new Date(+m[1], +m[2] - 1, 1)
  const week = +m[2]
  const first = firstMondayOfYear(+m[1])
  // 第 00 周从 1/1 起（不足一周），其余从第一个周一算
  return week <= 0
    ? new Date(+m[1], 0, 1)
    : new Date(first.getFullYear(), first.getMonth(), first.getDate() + (week - 1) * 7)
}

/** 步进一个粒度（一律走本地构造，跨夏令时 / 月末都不会错） */
function nextKeyDate(unit: TimeUnit, d: Date): Date {
  switch (unit) {
    case 'hour':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1)
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
    case 'week':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)
    default:
      return new Date(d.getFullYear(), d.getMonth() + 1, 1)
  }
}

/** 时刻对齐到该粒度的桶起点（0 点 / 周一 / 1 号） */
function alignToUnit(unit: TimeUnit, d: Date): Date {
  switch (unit) {
    case 'hour':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours())
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate())
    case 'week': {
      const offset = (d.getDay() + 6) % 7 // 周一 → 0
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset)
    }
    default:
      return new Date(d.getFullYear(), d.getMonth(), 1)
  }
}

/** 估算该粒度下的列数（只用于决定要不要降级，不做精确对齐） */
function approxBucketCount(unit: TimeUnit, startMs: number, endMs: number): number {
  const span = Math.max(0, endMs - startMs)
  switch (unit) {
    case 'hour':
      return span / HOUR_MS + 1
    case 'day':
      return span / DAY_MS + 1
    case 'week':
      return span / (7 * DAY_MS) + 1
    default:
      return span / (30 * DAY_MS) + 1
  }
}

/**
 * 生成 [start, end] 内该粒度的完整桶 key 序列（升序、去重）。
 * 返回 null 表示列数离谱（时钟/时区异常）→ 调用方放弃补零。
 */
function fillTimeKeys(unit: TimeUnit, start: Date, end: Date): string[] | null {
  const keys: string[] = []
  const endMs = end.getTime()
  let cur = start
  while (cur.getTime() <= endMs) {
    const key = timeKeyOf(unit, cur)
    if (keys[keys.length - 1] !== key) keys.push(key)
    if (keys.length > FILL_HARD_LIMIT) return null
    cur = nextKeyDate(unit, cur)
  }
  return keys
}

/** 空桶（补零用） */
function emptyBucket(key: string): UsageBucket {
  return {
    key,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    calls: 0,
    estimatedCalls: 0,
  }
}

/**
 * 把有数据的桶铺到完整的 key 序列上，缺的补 0。
 *
 * 兜底：若某个数据 key 不在生成序列里（时区 / 周号口径差异），**追加并重排** ——
 * 宁可多出一列，也不能把真实用量吞掉。
 */
export function densifyTimeBuckets(
  unit: TimeUnit,
  keys: string[],
  buckets: UsageBucket[],
): UsageBucket[] {
  const byKey = new Map(buckets.map((b) => [b.key, b]))
  const known = new Set(keys)
  const out = keys.map((k) => byKey.get(k) ?? emptyBucket(k))
  for (const b of buckets) if (!known.has(b.key)) out.push(b)
  // 同一粒度下 key 都是零填充的字符串，按字典序排 = 按时间排
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 解析某模型的单价：用户配置 > 内置默认 > null */
export function resolvePrice(providerConfigId?: string | null, modelId?: string | null): ModelPrice | null {
  const model = modelId || ''
  const pricing = settingsState.value.modelPricing || {}
  // 命中用户单价：先按 (provider, model) 精确匹配
  if (providerConfigId) {
    const exact = pricing[priceKey(providerConfigId, model)]
    if (exact) return exact
    // 再退一步：同一模型在别的 provider 下配过价（模型 id 相同，单价通常一样）
    const suffix = `::${model}`
    for (const [k, v] of Object.entries(pricing)) {
      if (k.endsWith(suffix)) return v
    }
  } else {
    const suffix = `::${model}`
    for (const [k, v] of Object.entries(pricing)) {
      if (k.endsWith(suffix)) return v
    }
  }
  // 内置价固定按 USD 存储 → 按当前币种折算（用户自填价不走这里，见 convertFromUsd）
  return findDefaultPriceInCurrency(model, currentCurrency())
}

/** 取当前币种（仅影响展示；默认人民币） */
export function currentCurrency(): string {
  return settingsState.value.usageCurrency || 'CNY'
}

/** 为聚合桶算费用 */
function costBucket(bucket: UsageBucket, price: ModelPrice | null): CostedBucket {
  const tokens: BillableTokens = {
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    cachedTokens: bucket.cachedTokens,
  }
  return { ...bucket, cost: computeCost(tokens, price) }
}

/** 零费用（reduce 初值） */
const ZERO_COST: TokenCost = { input: 0, output: 0, cached: 0, total: 0 }

/** 费用逐项相加 */
function addCost(a: TokenCost, b: TokenCost): TokenCost {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cached: a.cached + b.cached,
    total: a.total + b.total,
  }
}

/**
 * 查询聚合统计（含费用）。
 *
 * 合计费用只能按「模型」拆开算（见 `loadStats` 的第二次聚合）：时间 / 类型 / provider 的
 * 一个桶里往往混着多个模型、单价各不相同，用单一单价乘桶内总量会算错，而桶里根本没有
 * 模型信息、连单价都取不到。同理单位价也只能按模型取，而按会话分桶时 key 是 sessionId ——
 * 调用方需用 `resolveSessionModel` 映射回 provider/model，否则单价只能退到内置价目表（或 0）。
 *
 * 时间维度（hour/day/week/month）额外做两件事：
 *  1. 补零：把范围内缺失的时段补成 0 桶，修「只在 7、8 点用过 → 图上只剩两根柱子」的断轴；
 *  2. 降级：列数超 `MAX_TIME_BUCKETS` 时自动放粗粒度（小时→天→周→月），回传实际的 `groupBy`。
 */
export async function loadStats(
  range: UsageRange,
  groupBy: UsageGroupBy,
  opts: StatsContext = {},
): Promise<UsageStatsView> {
  const now = opts.now ?? Date.now()
  const bounds = rangeToBounds(range, now, opts.custom)
  const query: UsageStatsQuery = {
    groupBy,
    fromTs: bounds.fromTs,
    toTs: bounds.toTs,
    sessionId: opts.sessionId,
  }

  // 当前维度的聚合 + 按模型维度的聚合（后者专供「合计费用」用）。
  // 已经是按模型分桶时无需重复查一次（桶本身就是模型）。
  const [initial, byModel] = await Promise.all([
    statsRepo.stats(query),
    groupBy === 'model'
      ? Promise.resolve<UsageStats | null>(null)
      : statsRepo.stats({ ...query, groupBy: 'model' }),
  ])

  // ===== 时间维度：补零（修断轴）+ 跨度过大时自动降级粒度 =====
  // SQL 只回「有流水的时段」，所以补零只能在前端做（见上方 densify 注释）。
  let stats = initial
  let unit: UsageGroupBy = groupBy
  let degraded = false
  let rawBuckets = initial.buckets
  if (isTimeUnit(groupBy)) {
    // 起点：预设范围有明确边界；「全部」取**最早一条流水**（= 最开始使用的那天）。
    // 终点固定为「现在」—— 不补未来时段，免得图上多出一排永远为 0 的空列。
    const firstKey = initial.buckets[0]?.key
    const startDate =
      query.fromTs != null
        ? alignToUnit(groupBy, new Date(query.fromTs))
        : firstKey
          ? parseTimeKey(groupBy, firstKey)
          : null
    // 轴终点：有显式上界（昨天 / 自定义）就用上界，否则补到「现在」（不补未来时段）
    const axisEndMs = query.toTs ?? now
    if (startDate) {
      // 逐级放粗，取「列数 ≤ MAX_TIME_BUCKETS」的第一档（最粗兜底为「按月」）
      let picked: TimeUnit = TIME_UNITS[TIME_UNITS.length - 1]
      for (const cand of TIME_UNITS.slice(TIME_UNITS.indexOf(groupBy))) {
        if (approxBucketCount(cand, startDate.getTime(), axisEndMs) <= MAX_TIME_BUCKETS) {
          picked = cand
          break
        }
      }
      if (picked !== groupBy) {
        unit = picked
        degraded = true
        stats = await statsRepo.stats({ ...query, groupBy: picked })
      }
      // keys 为 null（列数离谱）时放弃补零：宁可断轴，也不截断已有数据
      const keys = fillTimeKeys(picked, startDate, new Date(axisEndMs))
      if (keys) rawBuckets = densifyTimeBuckets(picked, keys, stats.buckets)
    }
  }

  // 每个桶的单价定位：
  //  - 按会话分桶：用 sessionId 反查该会话当前的 provider/model
  //  - 其余维度：桶的 key 不是模型（kind/provider/week…），退到内置价目（通常为 null）
  const priceOfBucket = (bucket: UsageBucket): ModelPrice | null => {
    if (groupBy === 'model') return resolvePrice(null, bucket.key)
    if (groupBy === 'session') {
      const hit = opts.resolveSessionModel?.(bucket.key)
      return resolvePrice(hit?.providerConfigId, hit?.modelId)
    }
    return null
  }

  const buckets = rawBuckets.map((b) => costBucket(b, priceOfBucket(b)))
  // 模型维度的桶（已经按模型分桶时就是上面那批）：既供合计费用，也供饼图按模型归类
  const modelBuckets = byModel
    ? byModel.buckets.map((b) => costBucket(b, resolvePrice(null, b.key)))
    : buckets
  const base = costBucket(stats.totals, null)
  // 合计费用 = 各模型费用之和（与当前分桶维度无关）
  const totalCost = modelBuckets.reduce((acc, b) => addCost(acc, b.cost), ZERO_COST)

  return {
    buckets,
    groupBy: unit,
    degraded,
    modelBuckets,
    totals: { ...base, cost: totalCost, currency: currentCurrency() },
    firstTs: stats.firstTs,
    lastTs: stats.lastTs,
  }
}

/** 明细分页参数 */
export interface RecordsContext {
  sessionId?: string
  limit?: number
  offset?: number
  /** 自定义时间区间：仅当 `range === 'custom'` 时生效（见 `rangeToBounds`） */
  custom?: CustomRange | null
}

/** 统计查询上下文 */
export interface StatsContext {
  sessionId?: string
  /** 自定义时间区间：仅当 `range === 'custom'` 时生效（见 `rangeToBounds`） */
  custom?: CustomRange | null
  /**
   * 按会话分桶时，把 sessionId 映射回它当前的 provider/model（用于取准单价）。
   * 由 UI 从 `sessionStore` 提供 —— 服务层不去 import store 之外的东西。
   */
  resolveSessionModel?: (
    sessionId: string,
  ) => { providerConfigId?: string; modelId?: string } | undefined
  /**
   * 当前时刻（默认 `Date.now()`）。补零的轴终点 / 范围边界都按它算；
   * 测试注入固定时间用，生产不要传。
   */
  now?: number
}

/** 查询明细（时间倒序，带费用） */
export async function loadRecords(
  range: UsageRange,
  opts: RecordsContext = {},
): Promise<{ records: CostedRecord[]; total: number }> {
  const bounds = rangeToBounds(range, Date.now(), opts.custom)
  const page = await statsRepo.records({
    fromTs: bounds.fromTs,
    toTs: bounds.toTs,
    sessionId: opts.sessionId,
    limit: opts.limit ?? 100,
    offset: opts.offset ?? 0,
  })
  return {
    records: page.records.map((r) => ({
      ...r,
      cost: computeCost(
        {
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          cachedTokens: r.cachedTokens,
        },
        resolvePrice(r.providerConfigId, r.model),
      ),
    })),
    total: page.total,
  }
}

/** 清空账本（返回删除条数） */
export async function clearUsage(): Promise<number> {
  return statsRepo.clear()
}

/** 调用类型 → 中文文案（表格 / 图例用） */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'chat_round':
      return t('对话')
    case 'compress':
      return t('上下文压缩')
    case 'title':
      return t('标题生成')
    case 'verify':
      return t('结果校验')
    case 'embedding':
      return t('向量化')
    case 'legacy':
      return t('历史记录')
    default:
      return kind
  }
}

/** 导出明细为 CSV（返回保存路径；取消返回 null） */
export async function exportUsageCsv(
  range: UsageRange,
  opts: { sessionId?: string; limit?: number; custom?: CustomRange | null } = {},
): Promise<string | null> {
  const { records } = await loadRecords(range, {
    sessionId: opts.sessionId,
    custom: opts.custom,
    limit: opts.limit ?? 5000,
    offset: 0,
  })
  const currency = currentCurrency()
  const header = [
    t('时间'),
    t('会话'),
    t('模型'),
    'Provider',
    t('类型'),
    'Prompt Tokens',
    'Completion Tokens',
    'Cached Tokens',
    'Total Tokens',
    'Output Tok/s',
    t('估算'),
    t('费用') + `(${currency})`,
  ]
  const lines = [header.join(',')]
  for (const r of records) {
    lines.push(
      [
        new Date(r.ts).toLocaleString(),
        csvCell(r.sessionTitle || t('已删除会话')),
        csvCell(r.model),
        csvCell(r.providerType || ''),
        csvCell(kindLabel(r.kind)),
        r.promptTokens,
        r.completionTokens,
        r.cachedTokens,
        r.totalTokens,
        outputTokPerSec(r)?.toFixed(1) ?? '',
        r.estimated ? t('估算') : '',
        r.cost.total.toFixed(6),
      ].join(','),
    )
  }
  // BOM：Excel 打开中文表头不乱码
  const csv = '\uFEFF' + lines.join('\r\n')
  const fileName = `virlen-token-usage-${new Date().toISOString().slice(0, 10)}.csv`

  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    const filePath = await save({
      title: t('导出用量明细'),
      defaultPath: fileName,
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: t('所有文件'), extensions: ['*'] },
      ],
    })
    if (!filePath) return null
    await writeTextFile(filePath, csv)
    return filePath
  } catch {
    // 非 Tauri 环境降级为浏览器下载
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
    return null
  }
}

/** CSV 单元格转义（含逗号 / 引号 / 换行时加引号） */
function csvCell(value: string): string {
  const v = value ?? ''
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}
