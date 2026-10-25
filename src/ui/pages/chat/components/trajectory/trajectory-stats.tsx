/**
 * 「请求统计」条：把会话里**每一次 LLM 请求**的账算清楚。
 *
 * 两套口径并排显示，且各自标注范围 —— 这是这个组件最重要的一条纪律：
 * - **账本口径**（`ledger`）：整个会话的 token / 调用次数，含标题、压缩、校验这些
 *   不产生消息的调用。来自 `statsRepo.stats()` 的 totals，不受分页影响。
 * - **窗口口径**（`window`）：只数当前已加载的轨迹记录 —— 轮次、工具调用、失败，
 *   以及**实测请求耗时**（账本聚合桶没有耗时指标，只能从明细里数，所以只会覆盖最近若干次）。
 *
 * 混在一起报一个「总计」的话，用户会发现「总计 42 次，但表里只有 20 行」而无法解释。
 */
import { useState } from 'react'
import type { TrajectoryLedgerStats, TrajectoryWindowStats } from '@/domain/trajectory'
import { formatTokens } from '@/domain/pricing'
import { formatDuration } from '@/utils/time'
import { t, tpl } from '@/ui/i18n'

export interface TrajectoryStatsProps {
  /** 账本口径（会话全量）；账本不可用 / 无流水时为 null */
  ledger: TrajectoryLedgerStats | null
  /** 窗口口径（仅已加载的记录） */
  window: TrajectoryWindowStats
  loading: boolean
}

/** 百分比：分母未知时给破折号（不写 0%，那会被读成「缓存完全没命中」） */
function percent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—'
  return `${Math.round(ratio * 100)}%`
}

/** 一项指标（收起时也参与摘要那条线） */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="trajectory-stats__metric" title={hint}>
      <span className="trajectory-stats__metric-label">{label}</span>
      <span className="trajectory-stats__metric-value">{value}</span>
    </div>
  )
}

export function TrajectoryStats({ ledger, window, loading }: TrajectoryStatsProps) {
  const [expanded, setExpanded] = useState(false)

  // 账本优先：它是全量口径；账本不可用（浏览器 dev / 旧库）时才退回窗口口径，
  // 并且下面会明确写出来「这不是会话全量」。
  const chatCalls = ledger?.chatCalls ?? window.steps
  const input = ledger?.input ?? window.input
  const output = ledger?.output ?? window.output
  const cacheHitRatio = ledger?.cacheHitRatio ?? window.cacheHitRatio
  const otherCalls = ledger === null ? null : Math.max(ledger.calls - ledger.chatCalls, 0)

  const measured =
    window.measuredMs === null
      ? '—'
      : formatDuration(window.measuredMs)
  const average =
    window.measuredMs !== null && window.measuredCalls > 0
      ? formatDuration(window.measuredMs / window.measuredCalls)
      : '—'

  const summary: string[] = loading
    ? [t('加载中…')]
    : [
      tpl('对话 $__n__ 次', { n: chatCalls }),
      `${t('输入')} ${formatTokens(input)}`,
      `${t('输出')} ${formatTokens(output)}`,
      `${t('缓存')} ${percent(cacheHitRatio)}`,
      `${t('实测')} ${measured}`,
    ]

  return (
    <section className={`trajectory-stats${expanded ? ' is-open' : ''}`}>
      <button
        type="button"
        className="trajectory-stats__bar"
        aria-expanded={expanded}
        aria-label={expanded ? t('收起请求统计') : t('展开请求统计')}
        onClick={() => setExpanded((value) => !value)}>
        <span className="trajectory-stats__caret">▸</span>
        <span className="trajectory-stats__title">{t('请求统计')}</span>
        <span className="trajectory-stats__summary">{summary.join(' · ')}</span>
        <span className="trajectory-stats__scope">
          {ledger === null ? t('仅已加载') : t('对话全量')}
        </span>
      </button>

      {expanded && (
        <div className="trajectory-stats__body">
          <div className="trajectory-stats__group">
            <div className="trajectory-stats__group-title">
              {t('对话全量（每次 LLM 调用一条流水）')}
            </div>
            {ledger === null ? (
              <p className="trajectory-note">
                {t('账本不可用，下面的数字只覆盖已加载的记录（不含标题生成、压缩摘要等调用）。')}
              </p>
            ) : (
              <div className="trajectory-stats__grid">
                <Metric label={t('对话请求')} value={formatTokens(ledger.chatCalls)} />
                <Metric
                  label={t('其它调用')}
                  value={otherCalls === null ? '—' : String(otherCalls)}
                  hint={t('标题生成、上下文压缩、迭代校验、记忆蒸馏等不产生消息的调用')}
                />
                <Metric label={t('估算用量')} value={String(ledger.estimatedCalls)} />
                <Metric label={t('输入 token')} value={formatTokens(ledger.input)} />
                <Metric label={t('输出 token')} value={formatTokens(ledger.output)} />
                <Metric label={t('缓存读取')} value={formatTokens(ledger.cached)} />
                <Metric label={t('缓存写入')} value={formatTokens(ledger.cacheWrite)} />
                <Metric
                  label={t('缓存命中率')}
                  value={percent(ledger.cacheHitRatio)}
                  hint={t('缓存读取 ÷（输入 + 缓存读取 + 缓存写入）')}
                />
              </div>
            )}
          </div>

          <div className="trajectory-stats__group">
            <div className="trajectory-stats__group-title">
              {t('已加载的记录')}
            </div>
            <div className="trajectory-stats__grid">
              <Metric label={t('轮次')} value={String(window.turns)} />
              <Metric label={t('回复步骤')} value={String(window.steps)} />
              <Metric label={t('工具调用')} value={String(window.tools)} />
              <Metric label={t('失败')} value={String(window.failures)} />
              <Metric
                label={t('实测耗时')}
                value={measured}
                hint={tpl('已实测 $__n__ 次请求的账本耗时合计（含首字延迟）', {
                  n: window.measuredCalls,
                })}
              />
              <Metric
                label={t('平均耗时')}
                value={average}
                hint={t('只统计账本里有耗时记录的请求')}
              />
              <Metric label={t('输入 token')} value={formatTokens(window.input)} />
              <Metric label={t('输出 token')} value={formatTokens(window.output)} />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
