/**
 * usage-table — 用量明细表（每条 LLM 调用一行）
 *
 * 数据由面板一次拉取（有上限）后在客户端筛选 / 排序 / 分页；这里只负责渲染当前页、
 * 表头排序交互与翻页回调。可排序列：时间 / Prompt / Completion / Cached / 合计。
 */
import type { ReactNode } from 'react'
import { formatCost, formatTokens } from '@/domain/pricing'
import { t, tpl } from '@/ui/i18n'
import {
  kindLabel,
  type CostedRecord,
  type RecordSortKey,
  type SortDir,
} from '@/services/token-stats-service'

interface Props {
  records: CostedRecord[]
  total: number
  page: number
  pageSize: number
  currency: string
  loading?: boolean
  sortKey: RecordSortKey
  sortDir: SortDir
  onSort: (key: RecordSortKey) => void
  onPageChange: (page: number) => void
  /** 服务端匹配行超过拉取上限（当前数据只是最近一批） */
  truncated?: boolean
}

/** 可排序表头：同列切换升/降；未激活时显示淡色 ↕ 提示 */
function SortTh({
  keyName,
  activeKey,
  dir,
  onSort,
  num,
  children,
}: {
  keyName: RecordSortKey
  activeKey: RecordSortKey
  dir: SortDir
  onSort: (key: RecordSortKey) => void
  num?: boolean
  children: ReactNode
}) {
  const active = keyName === activeKey
  return (
    <th className={num ? 'num' : ''}>
      <button
        type="button"
        className={`sort-th${active ? ' active' : ''}`}
        onClick={() => onSort(keyName)}>
        {children}
        <span className="sort-ind" aria-hidden="true">
          {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}

/** 时间戳 → 本地「月-日 时:分:秒」 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 会话标题：会话被删后流水仍在，标题用占位文案 */
function sessionLabel(r: CostedRecord): string {
  if (r.sessionTitle) return r.sessionTitle
  return r.sessionId ? t('已删除会话') : t('无会话上下文')
}

export default function UsageTable({
  records,
  total,
  page,
  pageSize,
  currency,
  loading,
  sortKey,
  sortDir,
  onSort,
  onPageChange,
  truncated,
}: Props) {
  const maxPage = Math.max(Math.ceil(total / pageSize), 1)
  return (
    <div className="token-stats-table-wrap">
      {truncated && (
        <p className="table-hint">
          {t('匹配记录过多，仅对最近加载的一批做筛选与排序，请缩小时间范围。')}
        </p>
      )}
      <table className="token-stats-table">
        <thead>
          <tr>
            <SortTh
              keyName="ts"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}>
              {t('时间')}
            </SortTh>
            <th>{t('会话')}</th>
            <th>{t('模型')}</th>
            <th>{t('类型')}</th>
            <SortTh
              keyName="promptTokens"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              num>
              Prompt
            </SortTh>
            <SortTh
              keyName="completionTokens"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              num>
              Completion
            </SortTh>
            <SortTh
              keyName="cachedTokens"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              num>
              Cached
            </SortTh>
            <SortTh
              keyName="totalTokens"
              activeKey={sortKey}
              dir={sortDir}
              onSort={onSort}
              num>
              {t('合计')}
            </SortTh>
            <th className="num">{t('费用')}</th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 && (
            <tr>
              <td className="empty" colSpan={9}>
                {loading ? t('加载中...') : t('暂无用量记录')}
              </td>
            </tr>
          )}
          {records.map((r) => (
            <tr key={r.id}>
              <td className="mono">{formatTime(r.ts)}</td>
              <td className="ellipsis" title={sessionLabel(r)}>
                {sessionLabel(r)}
              </td>
              <td className="ellipsis" title={r.model}>
                {r.model || '-'}
              </td>
              <td>
                <span className="kind-tag">{kindLabel(r.kind)}</span>
                {/* 估算值必须与真实用量区分开：压缩上下文的 token 是本地 tokenizer 算的 */}
                {r.estimated && (
                  <span className="est-tag" title={t('本地估算值，非 API 返回')}>
                    {t('估算')}
                  </span>
                )}
              </td>
              <td className="num">{formatTokens(r.promptTokens)}</td>
              <td className="num">{formatTokens(r.completionTokens)}</td>
              <td className="num">{formatTokens(r.cachedTokens)}</td>
              <td className="num strong">{formatTokens(r.totalTokens)}</td>
              <td className="num">{formatCost(r.cost.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="token-stats-pager">
        <span>
          {total > 0
            ? tpl('共 $__total__ 条，第 $__page__ / $__max__ 页', {
              total,
              page,
              max: maxPage,
            })
            : t('共 0 条')}
        </span>
        <div className="pager-buttons">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => onPageChange(page - 1)}>
            {t('上一页')}
          </button>
          <button
            type="button"
            disabled={page >= maxPage || loading}
            onClick={() => onPageChange(page + 1)}>
            {t('下一页')}
          </button>
        </div>
      </div>
    </div>
  )
}
