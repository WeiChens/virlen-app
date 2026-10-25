/**
 * 用量统计的应用编排层：时间范围 / 分桶翻译成 Rust 查询，token 聚合 × 单价表算费用，
 * 明细在客户端筛选排序，导出 CSV。
 *
 * 单价优先级：用户配置 > 内置价目（仅默认填充）。默认币种 CNY，内置表按 USD 存储后折算。
 */
import {
  computeCost,
  findDefaultPriceInCurrency,
  priceKey,
  type BillableTokens,
  type ModelPrice,
  type TokenCost,
} from '@/domain/pricing'
import { generationWindowMs } from '@/domain/usage'
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

/** 时间范围预设。custom 需同时传 customRange。 */
export type UsageRange = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom'

/** 自定义时间区间（Unix ms 闭区间，from / to 会归一化） */
export interface CustomRange {
  from: number
  to: number
}

/** 分桶维度（与 Rust usage_group_expr 白名单一致） */
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
  /** 当前分桶维度的桶（时间维度已补零） */
  buckets: CostedBucket[]
  /**
   * 实际生效的分桶维度：跨度过大时会自动降级，UI 必须用它判断轴标签与图表类型。
   */
  groupBy: UsageGroupBy
  /** 是否因跨度过大自动降级了粒度 */
  degraded: boolean
  /**
   * 按模型分桶（过滤条件同上）：合计费用只能逐模型算，饼图也按模型归类。
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

/** 明细排序键 */
export type RecordSortKey =
  | 'ts'
  | 'promptTokens'
  | 'completionTokens'
  | 'cachedTokens'
  | 'cacheWriteTokens'
  | 'totalTokens'
  | 'tokPerSec'

/** 排序方向 */
export type SortDir = 'asc' | 'desc'

/** 明细筛选条件（客户端过滤，空串 = 不过滤，大小写不敏感） */
export interface RecordFilter {
  /** 会话标题关键字 */
  sessionKeyword?: string
  /** 模型 id 关键字 */
  modelKeyword?: string
  /** 调用类型（空串 = 全部） */
  kind?: string
}

/**
 * 明细一次拉取上限。不做服务端分页：关键字是子串匹配，下沉不到 SQL，只拉当前页会让搜索只作用于单页。
 */
export const RECORDS_LOAD_CAP = 5000

/** 算输出速度所需的最小形状 */
export interface RateInput {
  completionTokens: number
  /** 未测量（旧流水）时为 0 / undefined */
  durationMs?: number
  /** 发出请求 → 收到响应头（ms）；缺省 = 没这项事实，分母退回整段耗时 */
  responseStartMs?: number
}

/**
 * 输出速度 = completionTokens ÷ **生成窗口**（`请求耗时 − 等响应头耗时`，
 * 见 `domain/usage::generationWindowMs`）：发送与排队的时间不算模型在吐字。
 * 返回 null 表示算不出（旧流水无耗时 / 无输出）→ UI 显示 -，绝不能当成 0。
 */
export function outputTokPerSec(r: RateInput): number | null {
  const ms = generationWindowMs(r)
  if (ms <= 0 || r.completionTokens <= 0) return null
  return r.completionTokens / (ms / 1000)
}

/**
 * 明细筛选 + 排序（纯函数）。排序稳定：数值相等时按时间倒序兜底；tokPerSec 算不出的行当最小值。
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
      case 'cacheWriteTokens':
        return r.cacheWriteTokens
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
 * 明细汇总。summarizeRecords 对传入的全部记录汇总，调用方应传「全部筛选结果」而非当前页。
 */
export interface RecordsSummary {
  /** 参与汇总的记录条数 */
  count: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** 总费用（逐行 cost.total 累加） */
  cost: TokenCost
  /** 加权输出速度（tok/s）；无可测行时为 null */
  tokPerSec: number | null
  /** 参与 tok/s 计算的可测行数 */
  rateSamples: number
}

/**
 * 明细汇总。tok/s 用加权口径（可测行 completion 之和 ÷ 可测行**生成窗口**之和），
 * 避免小请求拉偏均值。
 */
export function summarizeRecords(records: CostedRecord[]): RecordsSummary {
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let cacheWriteTokens = 0
  let totalTokens = 0
  let rateDurMs = 0
  let rateCompletion = 0
  let rateSamples = 0
  const cost: TokenCost = { input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0 }
  for (const r of records) {
    promptTokens += r.promptTokens
    completionTokens += r.completionTokens
    cachedTokens += r.cachedTokens
    cacheWriteTokens += r.cacheWriteTokens
    totalTokens += r.totalTokens
    cost.input += r.cost.input
    cost.output += r.cost.output
    cost.cached += r.cost.cached
    cost.cacheWrite += r.cost.cacheWrite
    cost.total += r.cost.total
    // 加权口径与单行一致：只累加「生成窗口」，发送 / 排队不进分母
    const windowMs = generationWindowMs(r)
    if (windowMs > 0 && r.completionTokens > 0) {
      rateDurMs += windowMs
      rateCompletion += r.completionTokens
      rateSamples++
    }
  }
  return {
    count: records.length,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheWriteTokens,
    totalTokens,
    cost,
    tokPerSec: rateDurMs > 0 ? rateCompletion / (rateDurMs / 1000) : null,
    rateSamples,
  }
}

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** 当天 0 点（本地时区）：SQL 里时间桶用 'localtime'，边界必须同口径 */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 时间范围 → 查询边界（闭区间）；undefined = 该端不过滤。「昨天」「自定义」必须显式给结束边界。
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
      // 结束端 = 今天 0 点前 1ms，配合闭区间恰好覆盖整天
      return { fromTs: start, toTs: startOfToday(now) - 1 }
    }
    case '7d':
      return { fromTs: startOfToday(now) - 6 * DAY_MS }
    case '30d':
      return { fromTs: startOfToday(now) - 29 * DAY_MS }
    case 'custom': {
      // 缺任一端就当不过滤（UI 应在区间不完整时不触发查询）
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

/** 时间范围 → 起始时间戳；需要上界时用 rangeToBounds。 */
export function rangeToFromTs(range: UsageRange, now = Date.now()): number | undefined {
  return rangeToBounds(range, now).fromTs
}

// 时间桶补零（修断轴）：Rust 只回有流水的时段，按范围生成连续 key 序列后把缺失的补 0。
// O(列数) 毫秒级，不需要缓存聚合结果表。

/** 时间粒度（与 Rust 白名单一致） */
export type TimeUnit = 'hour' | 'day' | 'week' | 'month'

/** 降级顺序：小时 → 天 → 周 → 月 */
const TIME_UNITS: TimeUnit[] = ['hour', 'day', 'week', 'month']

/**
 * 时间轴列数上限，超过就自动降一级粒度。~1000 列以内 echarts 配 hideOverlap 仍可读。
 */
export const MAX_TIME_BUCKETS = 1000

/** 生成序列硬上限：超了就放弃补零（宁可断轴，也不卡死 UI） */
const FILL_HARD_LIMIT = MAX_TIME_BUCKETS * 4

function isTimeUnit(groupBy: UsageGroupBy): groupBy is TimeUnit {
  return (TIME_UNITS as string[]).includes(groupBy)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 某年第一个周一（对齐 SQLite strftime('%W')：1/1 之前算第 00 周） */
function firstMondayOfYear(year: number): Date {
  const jan1 = new Date(year, 0, 1)
  const offset = (1 - jan1.getDay() + 7) % 7 // 0 表示 1/1 本身就是周一
  return new Date(year, 0, 1 + offset)
}

/**
 * 时刻 → 时间桶 key，必须与 Rust 的 strftime 表达式逐字对齐（否则会出现补零列与数据列并存）。
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
      // 四舍五入消掉夏令时的 ±1 小时误差
      const days = Math.round((dayStart.getTime() - fm.getTime()) / DAY_MS)
      return `${y}-${pad2(days < 0 ? 0 : Math.floor(days / 7) + 1)}`
    }
    default:
      return `${y}-${pad2(d.getMonth() + 1)}`
  }
}

/** 时间桶 key → 起始时刻；认不出来返回 null */
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

/** 步进一个粒度（走本地构造，跨夏令时 / 月末都不会错） */
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

/** 估算该粒度的列数（只用于决定是否降级） */
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
 * 生成 [start, end] 的完整桶 key 序列（升序去重）；null = 列数离谱，调用方放弃补零。
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
    cacheWriteTokens: 0,
    totalTokens: 0,
    calls: 0,
    estimatedCalls: 0,
  }
}

/**
 * 把有数据的桶铺到完整 key 序列上，缺的补 0。数据 key 不在序列里就追加并重排（不吞真实用量）。
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
  // 同粒度 key 都是零填充，字典序 = 时间序
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 解析模型单价：用户配置 > 内置默认 > null */
export function resolvePrice(providerConfigId?: string | null, modelId?: string | null): ModelPrice | null {
  const model = modelId || ''
  const pricing = settingsState.value.modelPricing || {}
  // 命中用户单价：先按 (provider, model) 精确匹配
  if (providerConfigId) {
    const exact = pricing[priceKey(providerConfigId, model)]
    if (exact) return exact
    // 再退一步：同模型在别的 provider 下配过价
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
  // 内置价按 USD 存储 → 按当前币种折算（用户自填价不走这里）
  return findDefaultPriceInCurrency(model, currentCurrency())
}

/** 取当前币种（仅影响展示） */
export function currentCurrency(): string {
  return settingsState.value.usageCurrency || 'CNY'
}

/** 为聚合桶算费用 */
function costBucket(bucket: UsageBucket, price: ModelPrice | null): CostedBucket {
  const tokens: BillableTokens = {
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    cachedTokens: bucket.cachedTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
  }
  return { ...bucket, cost: computeCost(tokens, price) }
}

/** 零费用（reduce 初值） */
const ZERO_COST: TokenCost = { input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0 }

/** 费用逐项相加 */
function addCost(a: TokenCost, b: TokenCost): TokenCost {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  }
}

/**
 * 查询聚合统计（含费用）。
 * 合计费用只能按模型拆开算（一个桶里混着多个模型、单价各异）；按会话分桶时需
 * resolveSessionModel 映射回 provider/model。时间维度额外补零，超上限时自动放粗粒度。
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

  // 当前维度聚合 + 按模型维度的聚合（后者专供合计费用）；已按模型分桶则不重复查
  const [initial, byModel] = await Promise.all([
    statsRepo.stats(query),
    groupBy === 'model'
      ? Promise.resolve<UsageStats | null>(null)
      : statsRepo.stats({ ...query, groupBy: 'model' }),
  ])

  // 时间维度：补零（SQL 只回有流水的时段）+ 跨度过大时降级粒度
  let stats = initial
  let unit: UsageGroupBy = groupBy
  let degraded = false
  let rawBuckets = initial.buckets
  if (isTimeUnit(groupBy)) {
    // 起点：预设范围有边界；「全部」取最早一条流水。终点固定为现在（不补未来空列）。
    const firstKey = initial.buckets[0]?.key
    const startDate =
      query.fromTs != null
        ? alignToUnit(groupBy, new Date(query.fromTs))
        : firstKey
          ? parseTimeKey(groupBy, firstKey)
          : null
    // 轴终点：有显式上界（昨天 / 自定义）就用上界，否则到「现在」
    const axisEndMs = query.toTs ?? now
    if (startDate) {
      // 逐级放粗，取第一个「列数 ≤ MAX_TIME_BUCKETS」的粒度（兜底按月）
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
      // keys 为 null（列数离谱）时放弃补零：宁可断轴也不截断数据
      const keys = fillTimeKeys(picked, startDate, new Date(axisEndMs))
      if (keys) rawBuckets = densifyTimeBuckets(picked, keys, stats.buckets)
    }
  }

  // 桶的单价定位：按会话分桶用 sessionId 反查 provider/model；其余维度退到内置价目
  const priceOfBucket = (bucket: UsageBucket): ModelPrice | null => {
    if (groupBy === 'model') return resolvePrice(null, bucket.key)
    if (groupBy === 'session') {
      const hit = opts.resolveSessionModel?.(bucket.key)
      return resolvePrice(hit?.providerConfigId, hit?.modelId)
    }
    return null
  }

  const buckets = rawBuckets.map((b) => costBucket(b, priceOfBucket(b)))
  // 模型维度的桶（已按模型分桶时就是上面那批）：供合计费用与饼图
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
  /** 自定义时间区间：仅 range === 'custom' 时生效 */
  custom?: CustomRange | null
}

/** 统计查询上下文 */
export interface StatsContext {
  sessionId?: string
  /** 自定义时间区间：仅 range === 'custom' 时生效 */
  custom?: CustomRange | null
  /** 按会话分桶时把 sessionId 映射回 provider/model（取准单价），由 UI 从 sessionStore 提供 */
  resolveSessionModel?: (
    sessionId: string,
  ) => { providerConfigId?: string; modelId?: string } | undefined
  /** 当前时刻（测试可注入固定时间，生产不要传） */
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
          cacheWriteTokens: r.cacheWriteTokens,
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

/** 调用类型 → 文案（表格 / 图例用） */
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
    case 'memory':
      return t('记忆整理')
    case 'legacy':
      return t('历史记录')
    default:
      return kind
  }
}

/** 导出明细为 CSV；取消返回 null */
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
    'Cache Write Tokens',
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
        r.cacheWriteTokens,
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
