/**
 * useMessageSearch — 消息检索数据源 Hook
 *
 * 职责：把「查询条件」翻译成对 `sessionRepo.searchMessages` 的分页调用，
 * 并管理结果列表 / 加载中 / 是否还有下一页 / 错误 状态，供检索弹窗消费。
 *
 * 两种范围（由 `scope` 决定）：
 *   - session：限定当前会话（`sessionId`）；
 *   - global ：跨会话（不传 sessionId）。
 *
 * 分页：`limit` + keyset 游标（`(timestamp, rowid)`），`loadMore()` 取下一页（弹窗滚到底部时触发）。
 * 竞态：内部用自增 `seq` 丢弃过期响应，保证「改关键词后旧结果不会回填」。
 *
 * 空查询（弹窗默认态）：不做关键词过滤，直接返回最新消息（见 Rust `search_messages`），
 * 因此弹窗一打开就会预取一页最新对话。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionRepo } from '@/infrastructure/sessionRepo'
import type {
  MessageSearchItem,
  SearchCursor,
} from '@/infrastructure/sessionRepo'

/** 检索范围：会话内 / 跨会话 */
export type SearchScope = 'session' | 'global'

/** 角色筛选：全部 / 我的消息 / AI 回复 / 工具调用 */
export type SearchRoleFilter = 'all' | 'user' | 'assistant' | 'tool'

/** 每页条数 */
const PAGE_SIZE = 60
/** 输入防抖（ms），避免逐字触发 SQL 检索 */
const DEBOUNCE_MS = 200

interface UseMessageSearchOptions {
  visible: boolean
  scope: SearchScope
  sessionId?: string | null
  /** 原始查询串（内部 trim + 防抖） */
  query: string
  role: SearchRoleFilter
}

export interface MessageSearchState {
  items: MessageSearchItem[]
  loading: boolean
  hasMore: boolean
  error: string | null
  /** 取下一页（滚到底部时调用；已无更多 / 正在加载时为空操作） */
  loadMore: () => void
  /** 已生效的查询串（trim 后，用于高亮） */
  query: string
}

export function useMessageSearch({
  visible,
  scope,
  sessionId,
  query,
  role,
}: UseMessageSearchOptions): MessageSearchState {
  const [items, setItems] = useState<MessageSearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seqRef = useRef(0)
  /** keyset 分页游标（上一页最后一条的 timestamp+rowid；首页为 null） */
  const cursorRef = useRef<SearchCursor | null>(null)
  const loadingRef = useRef(false)
  /** 已无更多数据（拦截无效的 loadMore） */
  const doneRef = useRef(false)

  const q = query.trim()

  const load = useCallback(
    async (reset: boolean) => {
      if (!visible) return

      // 翻页时若已有请求在飞 / 已到底，跳过
      if (!reset && (loadingRef.current || doneRef.current)) return

      // reset：递增 seq 让在飞的旧请求作废；翻页：沿用当前 seq
      const seq = reset ? seqRef.current + 1 : seqRef.current
      if (reset) {
        seqRef.current = seq
        cursorRef.current = null
        doneRef.current = false
      }
      const cursor = reset ? null : cursorRef.current

      loadingRef.current = true
      setLoading(true)
      if (reset) setError(null)

      try {
        const page = await sessionRepo.searchMessages({
          query: q,
          sessionId: scope === 'session' ? sessionId ?? null : null,
          role: role === 'all' ? null : role,
          limit: PAGE_SIZE,
          cursor,
        })
        if (seq !== seqRef.current) return // 过期响应
        cursorRef.current = page.nextCursor ?? null
        doneRef.current = !page.hasMore
        setHasMore(page.hasMore)
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]))
      } catch (e) {
        if (seq !== seqRef.current) return
        setError(String(e))
        setHasMore(false)
        doneRef.current = true
      } finally {
        if (seq === seqRef.current) {
          loadingRef.current = false
          setLoading(false)
        }
      }
    },
    [visible, q, scope, sessionId, role],
  )

  // 条件变化（防抖）→ 重置并重新检索
  useEffect(() => {
    if (!visible) return
    // 立即进入加载态，避免防抖窗口内闪现「未找到结果」/「暂无消息」
    setLoading(true)
    setError(null)
    // 空查询（默认态）无需防抖，立即取最新消息
    const timer = setTimeout(() => {
      void load(true)
    }, q ? DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
  }, [visible, q, scope, sessionId, role, load])

  // 关闭弹窗 → 清空结果与游标，避免下次打开闪现上一次的结果
  useEffect(() => {
    if (visible) return
    seqRef.current++
    cursorRef.current = null
    loadingRef.current = false
    doneRef.current = false
    setItems([])
    setHasMore(false)
    setLoading(true)
    setError(null)
  }, [visible])

  const loadMore = useCallback(() => {
    if (loadingRef.current || doneRef.current) return
    void load(false)
  }, [load])

  return { items, loading, hasMore, error, loadMore, query: q }
}
