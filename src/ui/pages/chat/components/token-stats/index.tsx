/**
 * TokenStatsPanel — 用量统计面板（token 统计功能的主界面）
 *
 * 入口：侧边栏「新对话」按钮下方（见 `sidebar/index.tsx`）。
 *
 * 三个 Tab：
 *  - 图表：时间范围 + 分桶维度切换，堆叠柱（输入/输出/缓存）+ 调用类型饼图 + 合计卡片
 *  - 明细：每条 LLM 调用一行的表格（客户端筛选 / 排序 / 分页），可导出 CSV
 *  - 单价：按 (Provider, 模型) 配置单价，供费用估算使用
 *
 * 数据来源：Rust SQLite `usage_ledger`（Rust 引擎直落 + TS 侧 `cmd_append_usage`），
 * 与 `messages.usage` 无关 —— 账本独立于会话生命周期，删会话不清账。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import { sessionStore } from '@/ui/store'
import { showToast } from '@/ui/components/shared/Toast'
import { MessageBox } from '@/ui/components/shared/MessageBox'
import Select from '@/ui/components/shared/Select'
import { formatCost, formatTokens } from '@/domain/pricing'
import { t, tpl } from '@/ui/i18n'
import {
  clearUsage,
  currentCurrency,
  exportUsageCsv,
  filterAndSortRecords,
  kindLabel,
  loadRecords,
  loadStats,
  RECORDS_LOAD_CAP,
  type CostedBucket,
  type CostedRecord,
  type RecordSortKey,
  type SortDir,
  type UsageGroupBy,
  type UsageRange,
  type UsageStatsView,
} from '@/services/token-stats-service'
import {
  buildPieOption,
  buildTokenBarOption,
  buildTokenLineOption,
  UsageChart,
  type PieSlice,
} from './usage-chart'
import UsageTable from './usage-table'
import PriceEditor from './price-editor'
import './style.scss'

const PAGE_SIZE = 50

type Tab = 'chart' | 'records' | 'pricing'

/** 饼图归类维度：调用类型 / 模型用量 / token 类型（输入·输出·缓存）/ 模型费用 */
type PieDim = 'kind' | 'model' | 'tokens' | 'cost'

interface Props {
  open: boolean
  onClose: () => void
  /** 有当前会话时，额外给出「本会话」维度的过滤入口 */
  sessionId?: string
}

const RANGES: { key: UsageRange; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' },
]

const GROUPS: { key: UsageGroupBy; label: string }[] = [
  { key: 'day', label: '按天' },
  { key: 'hour', label: '按小时' },
  { key: 'week', label: '按周' },
  { key: 'month', label: '按月' },
  { key: 'model', label: '按模型' },
  { key: 'session', label: '按会话' },
  { key: 'kind', label: '按类型' },
]

/** 时间维度：这些维度看「趋势」，用平滑折线；其余维度看「构成」，用堆叠柱 */
const TIME_GROUPS: UsageGroupBy[] = ['hour', 'day', 'week', 'month']

/** 饼图维度切换按钮 */
const PIE_DIMS: { key: PieDim; label: string }[] = [
  { key: 'kind', label: '按类型' },
  { key: 'model', label: '按模型' },
  { key: 'tokens', label: '按 Token 类型' },
  { key: 'cost', label: '按费用' },
]

/** 饼图标题（随维度变化；中文 key，渲染时走 t()） */
const PIE_DIM_TITLES: Record<PieDim, string> = {
  kind: '调用类型占比',
  model: '模型用量占比',
  tokens: 'Token 类型占比',
  cost: '模型费用占比',
}

const EMPTY_VIEW: UsageStatsView = {
  buckets: [],
  modelBuckets: [],
  totals: {
    key: '',
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    calls: 0,
    estimatedCalls: 0,
    cost: { input: 0, output: 0, cached: 0, total: 0 },
    currency: 'USD',
  },
  firstTs: null,
  lastTs: null,
}

const TokenStatsPanel = observer(function TokenStatsPanel({
  open,
  onClose,
  sessionId,
}: Props) {
  const [tab, setTab] = useState<Tab>('chart')
  const [range, setRange] = useState<UsageRange>('7d')
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('day')
  /** 只看当前会话（默认关，用户可切） */
  const [onlyCurrentSession, setOnlyCurrentSession] = useState(false)
  const [stats, setStats] = useState<UsageStatsView>(EMPTY_VIEW)
  const [kindStats, setKindStats] = useState<CostedBucket[]>([])
  /** 饼图归类维度：调用类型 / 模型 / token 类型 / 费用 */
  const [pieDim, setPieDim] = useState<PieDim>('kind')
  const [records, setRecords] = useState<CostedRecord[]>([])
  const [recordTotal, setRecordTotal] = useState(0)
  const [page, setPage] = useState(1)
  /** 明细筛选（客户端） */
  const [sessionKeyword, setSessionKeyword] = useState('')
  const [modelKeyword, setModelKeyword] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  /** 明细排序（默认时间倒序，与服务端 ORDER BY 一致） */
  const [sortKey, setSortKey] = useState<RecordSortKey>('ts')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  const scopeSessionId =
    onlyCurrentSession && sessionId ? sessionId : undefined

  /** sessionId → 该会话当前的 provider/model（给单价定位用） */
  const resolveSessionModel = useCallback((id: string) => {
    const s = sessionStore.getSession(id)
    if (!s) return undefined
    return { providerConfigId: s.providerConfigId, modelId: s.modelId }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [view, kinds, pageRes] = await Promise.all([
        loadStats(range, groupBy, { sessionId: scopeSessionId, resolveSessionModel }),
        loadStats(range, 'kind', { sessionId: scopeSessionId, resolveSessionModel }),
        loadRecords(range, {
          sessionId: scopeSessionId,
          // 明细改成「一次拉取（有上限）+ 客户端筛选 / 排序 / 分页」（原因见服务层注释）
          limit: RECORDS_LOAD_CAP,
          offset: 0,
        }),
      ])
      setStats(view)
      setKindStats(kinds.buckets)
      setRecords(pageRes.records)
      setRecordTotal(pageRes.total)
      setPage(1)
    } finally {
      setLoading(false)
    }
  }, [range, groupBy, scopeSessionId, resolveSessionModel])

  // 打开面板 / 切范围 / 切维度 / 切会话范围时重新拉数；从「单价」页切回来也重拉：
  // 费用是**取数时**按当时单价算的（Rust 只回 token），改完单价必须重新取数，
  // 否则图表与明细会一直显示改价前的旧费用。
  useEffect(() => {
    if (open && tab !== 'pricing') void refresh()
  }, [open, tab, refresh])

  // 「今日」只有一天，按天分桶只会出一根柱子 → 自动切到小时粒度；
  // 离开「今日」时若还停在小时粒度，退回按天（否则 7/30 天范围柱子会过密）。
  // 依赖只有 `range`：用户手动切过的维度不受影响。
  useEffect(() => {
    if (range === 'today') {
      setGroupBy((g) =>
        g === 'day' || g === 'week' || g === 'month' ? 'hour' : g,
      )
    } else {
      setGroupBy((g) => (g === 'hour' ? 'day' : g))
    }
  }, [range])

  // Esc 关闭（与项目其它弹窗的键盘习惯一致）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  /** 点表头排序：同列切换升/降，换列默认降序（时间 / 数量都是「越大越关心」） */
  const handleSort = useCallback(
    (key: RecordSortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortKey(key)
        setSortDir('desc')
      }
      setPage(1)
    },
    [sortKey],
  )

  /** 分桶 key → 展示文案 */
  const labelOf = useCallback(
    (key: string): string => {
      switch (groupBy) {
        case 'hour':
          // '2026-09-21 14'：看「今日」时只显示 '14:00'；跨天则显示 '09-21 14'
          if (key.length < 13) return key
          return range === 'today' ? `${key.slice(11)}:00` : key.slice(5)
        case 'day':
          // '2026-09-21' → '09-21'（周/月维度保留完整 key 更清晰）
          return key.length >= 10 ? key.slice(5) : key
        case 'session': {
          const s = sessionStore.getSession(key)
          return s?.title || (key ? t('已删除会话') : t('无会话上下文'))
        }
        case 'kind':
          return key
        default:
          return key || '-'
      }
    },
    [groupBy, range],
  )

  const currency = currentCurrency()
  const totals = stats.totals

  /** 时间维度（小时 / 天 / 周 / 月）用平滑折线看趋势，其余维度用堆叠柱看构成 */
  const isTimeDim = TIME_GROUPS.includes(groupBy)
  const distributionOption = useMemo(
    () =>
      isTimeDim
        ? buildTokenLineOption(stats.buckets, labelOf, stats.totals.currency)
        : buildTokenBarOption(stats.buckets, labelOf, stats.totals.currency),
    [isTimeDim, stats, labelOf],
  )

  // 饼图四种维度共用同一套渲染，只是「扇区来源 + 数值口径」不同：
  //  - kind/model：按调用类型 / 按模型，数值 = token 总量
  //  - tokens：输入 / 输出 / 缓存 三类，数值 = 各自 token 量
  //  - cost：按模型，数值 = 该模型费用（钱花在哪）
  const pieSlices = useMemo<PieSlice[]>(() => {
    const cost = totals.cost
    if (pieDim === 'tokens') {
      return [
        {
          name: t('输入'),
          value: totals.promptTokens,
          lines: [
            `${t('合计')}: ${formatTokens(totals.promptTokens)}`,
            `${t('费用')}: ${formatCost(cost.input, currency)}`,
          ],
        },
        {
          name: t('输出'),
          value: totals.completionTokens,
          lines: [
            `${t('合计')}: ${formatTokens(totals.completionTokens)}`,
            `${t('费用')}: ${formatCost(cost.output, currency)}`,
          ],
        },
        {
          name: t('缓存'),
          value: totals.cachedTokens,
          lines: [
            `${t('合计')}: ${formatTokens(totals.cachedTokens)}`,
            `${t('费用')}: ${formatCost(cost.cached, currency)}`,
          ],
        },
      ]
    }
    const buckets = pieDim === 'kind' ? kindStats : stats.modelBuckets
    const labelOfKey = pieDim === 'kind' ? kindLabel : (k: string) => k || '-'
    return buckets.map((b) => ({
      name: labelOfKey(b.key),
      value: pieDim === 'cost' ? b.cost.total : b.totalTokens,
      lines: [
        `${t('调用次数')}: ${b.calls}`,
        `${t('合计')}: ${formatTokens(b.totalTokens)}`,
        `${t('费用')}: ${formatCost(b.cost.total, currency)}`,
      ],
    }))
  }, [pieDim, kindStats, stats.modelBuckets, totals, currency])
  const pieOption = useMemo(() => buildPieOption(pieSlices), [pieSlices])
  /** 有任意扇区 > 0 才画饼（避免全 0 时画出一团空图） */
  const hasPieData = pieSlices.some((s) => s.value > 0)

  // ===== 明细：客户端筛选 / 排序 / 分页 =====
  // 一次拉取上限内（RECORDS_LOAD_CAP）的全部匹配流水，之后全在内存里过滤与排序。
  // 必须客户端做：会话 / 模型关键字是子串搜索，账本表的过滤是精确匹配，下沉不到 SQL。
  const filteredRecords = useMemo(
    () =>
      filterAndSortRecords(
        records,
        { sessionKeyword, modelKeyword, kind: kindFilter },
        sortKey,
        sortDir,
      ),
    [records, sessionKeyword, modelKeyword, kindFilter, sortKey, sortDir],
  )
  const filteredTotal = filteredRecords.length
  const maxPage = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE))
  const safePage = Math.min(page, maxPage)
  const pageRecords = useMemo(
    () =>
      filteredRecords.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredRecords, safePage],
  )
  /** 服务端还有更多匹配行（被拉取上限截断）→ 提示缩小时间范围 */
  const truncated = recordTotal > records.length
  /** 类型筛选项：只列当前数据里出现过的类型 */
  const kindOptions = useMemo(
    () => Array.from(new Set(records.map((r) => r.kind))),
    [records],
  )

  const handleExport = async () => {
    setExporting(true)
    try {
      const path = await exportUsageCsv(range, { sessionId: scopeSessionId })
      showToast(path ? t('已导出用量明细') : t('导出已取消'), 2000)
    } catch (e: any) {
      showToast(t('导出失败：') + (e?.message || String(e)), 3000)
    } finally {
      setExporting(false)
    }
  }

  const handleClear = async () => {
    const ok = await MessageBox.propt(
      t('清空用量统计'),
      t('将删除全部用量流水（不影响会话与消息）。此操作不可撤销，确定继续？'),
      { danger: true, confirmText: t('清空') },
    )
    if (!ok) return
    const n = await clearUsage()
    showToast(
      n > 0
        ? tpl('已清空 $__n__ 条用量记录', { n })
        : t('没有可清空的记录'),
      2000,
    )
    void refresh()
  }

  if (!open) return null

  // 用 portal 挂到 body：侧边栏有 transform/动画，fixed 定位在它内部会被当成
  // 包含块（位置/层叠都不对），挂到 body 最稳。
  return createPortal(
    <div
      className="token-stats-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('用量统计')}>
      <div className="token-stats-mask" onClick={onClose} aria-hidden="true" />
      <div className="token-stats-panel">
        <header className="token-stats-header">
          <h3>{t('用量统计')}</h3>
          <div className="header-actions">
            <button
              type="button"
              className="ghost-btn"
              onClick={handleExport}
              disabled={exporting || recordTotal === 0}>
              {t('导出 CSV')}
            </button>
            <button
              type="button"
              className="ghost-btn danger"
              onClick={handleClear}
              disabled={totals.calls === 0}>
              {t('清空数据')}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label={t('关闭')}>
              <CloseSvg />
            </button>
          </div>
        </header>

        <nav className="token-stats-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'chart'}
            className={tab === 'chart' ? 'active' : ''}
            onClick={() => setTab('chart')}>
            {t('图表')}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'records'}
            className={tab === 'records' ? 'active' : ''}
            onClick={() => setTab('records')}>
            {t('明细')}
            {recordTotal > 0 ? ` (${recordTotal})` : ''}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'pricing'}
            className={tab === 'pricing' ? 'active' : ''}
            onClick={() => setTab('pricing')}>
            {t('单价')}
          </button>
        </nav>

        <div className="token-stats-toolbar">
          <div className="segmented">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={range === r.key ? 'active' : ''}
                onClick={() => setRange(r.key)}>
                {t(r.label)}
              </button>
            ))}
          </div>
          {tab === 'chart' && (
            <div className="segmented">
              {GROUPS.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className={groupBy === g.key ? 'active' : ''}
                  onClick={() => setGroupBy(g.key)}>
                  {t(g.label)}
                </button>
              ))}
            </div>
          )}
          {tab === 'records' && (
            <>
              <input
                className="filter-input"
                type="search"
                value={sessionKeyword}
                placeholder={t('搜索会话')}
                aria-label={t('搜索会话')}
                onChange={(e) => {
                  setSessionKeyword(e.target.value)
                  setPage(1)
                }}
              />
              <input
                className="filter-input"
                type="search"
                value={modelKeyword}
                placeholder={t('搜索模型')}
                aria-label={t('搜索模型')}
                onChange={(e) => {
                  setModelKeyword(e.target.value)
                  setPage(1)
                }}
              />
              {kindOptions.length > 1 && (
                <Select
                  value={kindFilter}
                  width={130}
                  options={[
                    { value: '', label: t('全部类型') },
                    ...kindOptions.map((k) => ({
                      value: k,
                      label: kindLabel(k),
                    })),
                  ]}
                  onChange={(v) => {
                    setKindFilter(v)
                    setPage(1)
                  }}
                />
              )}
            </>
          )}
          {sessionId && (
            <label className="scope-toggle">
              <input
                type="checkbox"
                checked={onlyCurrentSession}
                onChange={(e) => setOnlyCurrentSession(e.target.checked)}
              />
              {t('仅当前会话')}
            </label>
          )}
        </div>

        <div className="token-stats-body">
          {tab === 'chart' && (
            <div className="token-stats-chart-view">
              <div className="stat-cards">
                <StatCard
                  label={t('合计 Tokens')}
                  value={formatTokens(totals.totalTokens)}
                  sub={`${t('调用次数')} ${totals.calls}`}
                  accent
                />
                <StatCard
                  label={t('输入')}
                  value={formatTokens(totals.promptTokens)}
                />
                <StatCard
                  label={t('输出')}
                  value={formatTokens(totals.completionTokens)}
                />
                <StatCard
                  label={t('缓存')}
                  value={formatTokens(totals.cachedTokens)}
                />
                <StatCard
                  label={t('估算费用')}
                  value={formatCost(totals.cost.total, currency)}
                  sub={t('按你填写的单价估算，非账单')}
                />
              </div>

              <section className="chart-block">
                <h4>{isTimeDim ? t('用量趋势') : t('用量分布')}</h4>
                <UsageChart option={distributionOption} height={280} />
              </section>

              <section className="chart-block">
                <div className="chart-block-header">
                  <h4>{t(PIE_DIM_TITLES[pieDim])}</h4>
                  <div className="segmented small">
                    {PIE_DIMS.map((d) => (
                      <button
                        key={d.key}
                        type="button"
                        className={pieDim === d.key ? 'active' : ''}
                        onClick={() => setPieDim(d.key)}>
                        {t(d.label)}
                      </button>
                    ))}
                  </div>
                </div>
                {hasPieData ? (
                  <UsageChart option={pieOption} height={220} />
                ) : (
                  <p className="empty-hint">{t('暂无用量记录')}</p>
                )}
              </section>

              {totals.estimatedCalls > 0 && (
                <p className="foot-note">
                  {tpl(
                    '其中 $__n__ 条为本地估算值（如上下文压缩），非 API 返回的真实用量。',
                    { n: totals.estimatedCalls },
                  )}
                </p>
              )}
              {stats.firstTs && (
                <p className="foot-note">
                  {t('账本数据范围：')}
                  {new Date(stats.firstTs).toLocaleString()} ~{' '}
                  {new Date(stats.lastTs || stats.firstTs).toLocaleString()}
                </p>
              )}
            </div>
          )}

          {tab === 'records' && (
            <UsageTable
              records={pageRecords}
              total={filteredTotal}
              page={safePage}
              pageSize={PAGE_SIZE}
              currency={currency}
              loading={loading}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              onPageChange={setPage}
              truncated={truncated}
            />
          )}

          {tab === 'pricing' && <PriceEditor />}
        </div>
      </div>
    </div>,
    document.body,
  )
})

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div className={`stat-card${accent ? ' accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export default TokenStatsPanel
