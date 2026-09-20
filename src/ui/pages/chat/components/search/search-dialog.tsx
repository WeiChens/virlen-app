/**
 * search-dialog — 消息检索弹窗（会话内 / 跨会话）
 *
 * 由 Ctrl / Cmd + F 唤起（见 chat-view.tsx 的全局快捷键）。两种检索范围：
 *   - scope='session'：已选中会话 → 只搜当前会话，条目为单行「角色图标 + 命中片段 + 时间」；
 *   - scope='global' ：未选中会话 → 搜所有会话，条目 meta 额外展示「工作目录 + Agent 名称 + 会话标题」。
 *
 * 数据来自 SQLite（`sessionRepo.searchMessages` → Rust `cmd_search_messages`），
 * 分页加载：列表滚到接近底部时自动取下一页（见 useMessageSearch）。
 *
 * 默认（空关键词）不做关键词过滤，直接展示最新对话（见 useMessageSearch）；
 * 输入关键词后进入检索模式。
 *
 * 属于工具型浮层（命令面板风格）：键盘优先、高信息密度、低装饰；
 * ↑↓ 选择、Enter 跳转、Esc 关闭。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import SearchSvg from '@/ui/components/icons/SearchSvg'
import CloseSvg from '@/ui/components/icons/CloseSvg'
import UserSvg from '@/ui/components/icons/UserSvg'
import AgentSvg from '@/ui/components/icons/AgentSvg'
import FolderSvg from '@/ui/components/icons/FolderSvg'
import { t, tpl } from '@/ui/i18n'
import { timeFormat } from '@/utils/time'
import { agentStore } from '@/ui/store'
import type { MessageSearchItem } from '@/infrastructure/sessionRepo'
import {
  useMessageSearch,
  type SearchRoleFilter,
  type SearchScope,
} from './use-message-search'
import './search-dialog.scss'

interface Props {
  visible: boolean
  onClose: () => void
  /** 检索范围（默认 session） */
  scope?: SearchScope
  /** 当前会话 id（scope='session' 时使用） */
  sessionId?: string | null
  /** 选中某条结果（用于跳转到对应会话 / 消息） */
  onSelect?: (item: MessageSearchItem) => void
}

/** 命中的关键词片段 → 高亮节点（大小写不敏感） */
function renderHighlight(text: string, query: string) {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const lq = q.toLowerCase()
  const nodes: React.ReactNode[] = []
  let from = 0
  let key = 0
  while (true) {
    const at = lower.indexOf(lq, from)
    if (at === -1) {
      nodes.push(text.slice(from))
      break
    }
    if (at > from) nodes.push(text.slice(from, at))
    nodes.push(<mark key={key++}>{text.slice(at, at + q.length)}</mark>)
    from = at + q.length
  }
  return nodes
}

/** 路径末级目录名（工作目录只显示这一段，完整路径走 tooltip） */
function folderName(path: string): string {
  return path.split('/').pop()?.split('\\').pop() || path
}

const FILTERS: { key: SearchRoleFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '我的消息' },
  { key: 'assistant', label: 'AI 回复' },
]

/** 滚动到距底部多少像素时触发下一页 */
const LOAD_MORE_THRESHOLD = 140

function SearchDialog({
  visible,
  onClose,
  scope = 'session',
  sessionId,
  onSelect,
}: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SearchRoleFilter>('all')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const isGlobal = scope === 'global'
  const { items, loading, hasMore, error, loadMore, query: q } =
    useMessageSearch({ visible, scope, sessionId, query, role: filter })

  // 打开时清空状态并聚焦输入框
  useEffect(() => {
    if (!visible) return
    setQuery('')
    setFilter('all')
    setActiveIndex(0)
    // 等动画帧后再聚焦，避免与遮罩的入场动画抢焦点
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [visible])

  // 新检索（关键词 / 筛选 / 范围变化）→ 选中项回到第一条
  useEffect(() => {
    setActiveIndex(0)
  }, [q, filter, scope, visible])

  // 结果变少时收敛选中项
  useEffect(() => {
    setActiveIndex((i) =>
      i < items.length ? i : Math.max(0, items.length - 1),
    )
  }, [items.length])

  // 选中项滚动进可视区
  useEffect(() => {
    if (!visible) return
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, visible, items.length])

  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD) {
      loadMore()
    }
  }, [loadMore])

  if (!visible) return null

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (items.length === 0) return
      setActiveIndex((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length === 0) return
      setActiveIndex((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[activeIndex]
      if (item) onSelect?.(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const hasQuery = q.length > 0

  return (
    <div
      className="search-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}>
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('搜索消息')}
        onKeyDown={handleKeyDown}>
        {/* 检索输入 */}
        <div className="search-input-row">
          <SearchSvg className="search-input-icon" />
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              isGlobal
                ? t('搜索所有会话的消息...')
                : t('搜索会话中的消息...')
            }
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              className="search-input-clear"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              title={t('清空输入')}
              tabIndex={-1}>
              <CloseSvg />
            </button>
          )}
          {/* <button
            className="search-input-close"
            onClick={onClose}
            title={t('关闭')}
            tabIndex={-1}>
            <CloseSvg />
          </button> */}
        </div>

        {/* 筛选（下划线标签）+ 计数 */}
        <div className="search-filter-row">
          <div className="search-filters">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`search-filter-tab${filter === f.key ? ' active' : ''}`}
                onClick={() => setFilter(f.key)}
                tabIndex={-1}>
                {t(f.label)}
              </button>
            ))}
          </div>
          <span className="search-count">
            {items.length > 0
              ? tpl('已加载 $__count__ 条结果', { count: items.length })
              : ''}
          </span>
        </div>

        {/* 结果列表（滚到底部自动加载下一页） */}
        <div className="search-results" ref={listRef} onScroll={handleScroll}>
          {error ? (
            <div className="search-empty">
              <SearchSvg className="search-empty-icon" />
              <p className="search-empty-title">
                {tpl('搜索失败: $__error__', { error })}
              </p>
            </div>
          ) : items.length === 0 && loading ? (
            <div className="search-empty">
              <p className="search-empty-title">{t('加载中...')}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="search-empty">
              <SearchSvg className="search-empty-icon" />
              <p className="search-empty-title">
                {hasQuery ? t('未找到匹配的消息') : t('暂无消息')}
              </p>
              <p className="search-empty-hint">
                {hasQuery
                  ? t('试试其他关键词，或切换上方的筛选范围')
                  : isGlobal
                    ? t('还没有任何会话消息')
                    : t('当前会话还没有消息')}
              </p>
            </div>
          ) : (
            items.map((item, index) => {
              const agentName = item.agentId
                ? (agentStore.getAgent(item.agentId)?.name ?? t('默认 Agent'))
                : ''
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    itemRefs.current[index] = el
                  }}
                  className={`search-result-item${index === activeIndex ? ' active' : ''}`}
                  data-role={item.role}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => onSelect?.(item)}
                  title={item.text}>
                  <span className="result-role">
                    {item.role === 'user' ? <UserSvg /> : <AgentSvg />}
                  </span>
                  <span className="result-text">
                    {renderHighlight(item.text, q)}
                  </span>
                  <span className="result-meta">
                    {isGlobal && agentName && (
                      <span className="result-meta-item">
                        <AgentSvg />
                        {agentName}
                      </span>
                    )}
                    {isGlobal && item.workspace && (
                      <span
                        className="result-meta-item result-meta-path"
                        title={item.workspace}>
                        <FolderSvg />
                        {folderName(item.workspace)}
                      </span>
                    )}
                    <span className="result-meta-item result-time">
                      {timeFormat(item.timestamp)}
                    </span>
                  </span>
                </button>
              )
            })
          )}

          {loading && items.length > 0 && (
            <div className="search-loading">{t('加载中...')}</div>
          )}
          {hasMore && !loading && items.length > 0 && (
            <div className="search-more-hint">
              {t('滚动到底部加载更多')}
            </div>
          )}
        </div>

        {/* 键盘提示 */}
        <div className="search-footer">
          <span className="search-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            {t('选择')}
          </span>
          <span className="search-hint">
            <kbd>Enter</kbd>
            {t('跳转')}
          </span>
          <span className="search-hint">
            <kbd>Esc</kbd>
            {t('关闭')}
          </span>
        </div>
      </div>
    </div>
  )
}

export default observer(SearchDialog)
