/**
 * TokenStatsPanel — 用量统计面板（token 统计功能的主界面）
 *
 * 入口：侧边栏「新对话」按钮下方（见 `sidebar/index.tsx`）。
 *
 * 三个 Tab：
 *  - 图表：时间范围 + 分桶维度切换，堆叠柱（输入/输出/缓存）+ 调用类型饼图 + 合计卡片
 *  - 明细：每条 LLM 调用一行的表格（分页在 Rust 侧做），可导出 CSV
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
import { formatCost, formatTokens } from '@/domain/pricing'
import { t, tpl } from '@/ui/i18n'
import {
  clearUsage,
  currentCurrency,
  exportUsageCsv,
  kindLabel,
  loadRecords,
  loadStats,
  type CostedBucket,
  type CostedRecord,
  type UsageGroupBy,
  type UsageRange,
  type UsageStatsView,
} from '@/services/token-stats-service'
import { buildPieOption, buildTokenBarOption, UsageChart } from './usage-chart'
import UsageTable from './usage-table'
import PriceEditor from './price-editor'
import './style.scss'

const PAGE_SIZE = 50

type Tab = 'chart' | 'records' | 'pricing'

/** 饼图归类维度 */
type PieDim = 'kind' | 'model'

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
  { key: 'week', label: '按周' },
  { key: 'month', label: '按月' },
  { key: 'model', label: '按模型' },
  { key: 'session', label: '按会话' },
  { key: 'kind', label: '按类型' },
]

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
  /** 饼图看「调用类型」还是「模型」 */
  const [pieDim, setPieDim] = useState<PieDim>('kind')
  const [records, setRecords] = useState<CostedRecord[]>([])
  const [recordTotal, setRecordTotal] = useState(0)
  const [page, setPage] = useState(1)
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
          limit: PAGE_SIZE,
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

  // Esc 关闭（与项目其它弹窗的键盘习惯一致）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  const loadPage = useCallback(
    async (next: number) => {
      setLoading(true)
      try {
        const res = await loadRecords(range, {
          sessionId: scopeSessionId,
          limit: PAGE_SIZE,
          offset: (next - 1) * PAGE_SIZE,
        })
        setRecords(res.records)
        setRecordTotal(res.total)
        setPage(next)
      } finally {
        setLoading(false)
      }
    },
    [range, scopeSessionId],
  )

  /** 分桶 key → 展示文案 */
  const labelOf = useCallback(
    (key: string): string => {
      switch (groupBy) {
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
    [groupBy],
  )

  const barOption = useMemo(
    () => buildTokenBarOption(stats.buckets, labelOf, stats.totals.currency),
    [stats, labelOf],
  )
  const pieBuckets = pieDim === 'kind' ? kindStats : stats.modelBuckets
  // 饼图：按调用类型（kindLabel）或按模型（模型 id 直接展示）
  const pieOption = useMemo(
    () =>
      buildPieOption(
        pieBuckets,
        pieDim === 'kind' ? kindLabel : (k: string) => k || '-',
        stats.totals.currency,
      ),
    [pieBuckets, pieDim, stats.totals.currency],
  )

  const currency = currentCurrency()
  const totals = stats.totals

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
                <h4>{t('用量分布')}</h4>
                <UsageChart option={barOption} height={280} />
              </section>

              <section className="chart-block">
                <div className="chart-block-header">
                  <h4>
                    {pieDim === 'kind' ? t('调用类型占比') : t('模型用量占比')}
                  </h4>
                  <div className="segmented small">
                    <button
                      type="button"
                      className={pieDim === 'kind' ? 'active' : ''}
                      onClick={() => setPieDim('kind')}>
                      {t('按类型')}
                    </button>
                    <button
                      type="button"
                      className={pieDim === 'model' ? 'active' : ''}
                      onClick={() => setPieDim('model')}>
                      {t('按模型')}
                    </button>
                  </div>
                </div>
                {pieBuckets.length > 0 ? (
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
              records={records}
              total={recordTotal}
              page={page}
              pageSize={PAGE_SIZE}
              currency={currency}
              loading={loading}
              onPageChange={(p) => void loadPage(p)}
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
