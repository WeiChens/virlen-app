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

/** 时间范围预设 */
export type UsageRange = 'today' | '7d' | '30d' | 'all'

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
  /** 当前分桶维度的桶 */
  buckets: CostedBucket[]
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

/** 明细排序键（`ts` 为时间，其余为 token 数） */
export type RecordSortKey =
  | 'ts'
  | 'promptTokens'
  | 'completionTokens'
  | 'cachedTokens'
  | 'totalTokens'

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

/**
 * 明细的筛选 + 排序（纯函数）。
 *
 * 排序稳定：数值相等时按时间倒序兜底，否则翻页时同值行顺序会抖动。
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

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** 当天的 0 点（本地时区）—— 时间桶在 SQL 里用 'localtime'，边界也必须用本地时间，否则「今日」会按 UTC 切 */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 时间范围 → 起始时间戳（Unix ms）；`all` 返回 undefined 表示不过滤 */
export function rangeToFromTs(range: UsageRange, now = Date.now()): number | undefined {
  switch (range) {
    case 'today':
      return startOfToday(now)
    case '7d':
      return startOfToday(now) - 6 * DAY_MS
    case '30d':
      return startOfToday(now) - 29 * DAY_MS
    default:
      return undefined
  }
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
 * ⚠️ **合计费用只能按「模型」拆开算**（见 `loadStats` 里的第二次聚合）：
 * 时间 / 类型 / provider 这些维度的一个桶里往往混着多个模型，单价各不相同，
 * 用单一单价去乘桶内总量会算错；而桶里根本没有模型信息，连单价都取不到。
 *
 * ⚠️ 单位价只能按「模型」取，而按会话分桶时桶的 key 是 sessionId ——
 * 因此调用方可以通过 `resolveSessionModel` 把 sessionId 映射回它的 provider/model，
 * 否则该会话的单价只能退到内置价目表（或为 0）。
 */
export async function loadStats(
  range: UsageRange,
  groupBy: UsageGroupBy,
  opts: StatsContext = {},
): Promise<UsageStatsView> {
  const query: UsageStatsQuery = {
    groupBy,
    fromTs: rangeToFromTs(range),
    sessionId: opts.sessionId,
  }

  // 当前维度的聚合 + 按模型维度的聚合（后者专供「合计费用」用）。
  // 已经是按模型分桶时无需重复查一次（桶本身就是模型）。
  const [stats, byModel] = await Promise.all([
    statsRepo.stats(query),
    groupBy === 'model'
      ? Promise.resolve<UsageStats | null>(null)
      : statsRepo.stats({ ...query, groupBy: 'model' }),
  ])

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

  const buckets = stats.buckets.map((b) => costBucket(b, priceOfBucket(b)))
  // 模型维度的桶（已经按模型分桶时就是上面那批）：既供合计费用，也供饼图按模型归类
  const modelBuckets = byModel
    ? byModel.buckets.map((b) => costBucket(b, resolvePrice(null, b.key)))
    : buckets
  const base = costBucket(stats.totals, null)
  // 合计费用 = 各模型费用之和（与当前分桶维度无关）
  const totalCost = modelBuckets.reduce((acc, b) => addCost(acc, b.cost), ZERO_COST)

  return {
    buckets,
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
}

/** 统计查询上下文 */
export interface StatsContext {
  sessionId?: string
  /**
   * 按会话分桶时，把 sessionId 映射回它当前的 provider/model（用于取准单价）。
   * 由 UI 从 `sessionStore` 提供 —— 服务层不去 import store 之外的东西。
   */
  resolveSessionModel?: (
    sessionId: string,
  ) => { providerConfigId?: string; modelId?: string } | undefined
}

/** 查询明细（时间倒序，带费用） */
export async function loadRecords(
  range: UsageRange,
  opts: RecordsContext = {},
): Promise<{ records: CostedRecord[]; total: number }> {
  const page = await statsRepo.records({
    fromTs: rangeToFromTs(range),
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
  opts: { sessionId?: string; limit?: number } = {},
): Promise<string | null> {
  const { records } = await loadRecords(range, {
    sessionId: opts.sessionId,
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
