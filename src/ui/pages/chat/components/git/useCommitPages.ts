/**
 * useCommitPages — 提交列表的**分页口径唯一实现**（「提交记录」与「提交图」两个弹窗共用）。
 *
 * 收在一处的原因（§11.53 ⑰）：两个弹窗渲染同一份东西，口径分头写就一定会漂——
 * 分页判据（**拿回整页 = 可能还有**）、`skip` = 已加载条数、空态 / 错误 / 加载三态、
 * 以及「出错时收掉『加载更多』」这几条都是「错了很难受、编译期又不报」的那类。
 *
 * 五条与调用方无关的自洽性：
 * - 页大小由 `scope` 决定（列表 50 / 提交图 200，见 `git-service`）—— 判据与页大小必须同源；
 * - **`reloadKey` 变就整份重取**：调用方传「当前 HEAD 的身份」（分支名 + oid）。切分支（哪怕切到
 *   **同一个提交**——`%D` 里的 `HEAD -> x` 只是换了个名字）/ 提交 / 撤销 / 重置都会让它变；
 *   而列表里的两样东西都来自取数那一刻的 git：`head` 范围的**可达提交**、每行的**引用标签**
 *   （谁挂着 HEAD）。只重渲染只能换颜色，标签本身仍是旧的 —— 那正是「切了分支像没切」的来源；
 * - 卸载 / 重取都**作废在途结果**（`genRef` 世代号），不再写 state；
 *   ⚠️ 首屏与「加载更多」共用同一份世代：两处各判一次就会漏一处（少判的那处仍然会写 state）；
 * - **追加去重按 oid**：分页期间仓库可能被提交（本 App 的 AI 就一直在提交），而 `--skip` 是按**条数**
 *   算的 ⇒ 同一个提交会同时出现在两页里。不去重的话提交图会把同一次提交画成**两条断开的列**
 *   （行 key 也撞）；但 `skip` 仍按「git 侧已消费的条数」推进，不是去重后的列表长度；
 * - **不写 store**：列表由弹窗自己持有，关掉即弃（缓存会让「刚提交完再打开」显示旧列表）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitCommitLogEntry, GitLogScope } from '@/domain/git'
import { GRAPH_PAGE_SIZE, LOG_PAGE_SIZE, loadCommits } from '@/services/git-service'

export interface CommitPages {
  commits: GitCommitLogEntry[]
  /** 首屏还在加载（此时列表位置显示「加载中…」） */
  loading: boolean
  loadingMore: boolean
  /** 拿回过整页 —— 只在为真时显示「加载更多」 */
  hasMore: boolean
  error: string | null
  loadMore: () => void
}

export function useCommitPages(
  scope: GitLogScope,
  /** 变化即整份重取（见模块头第二条）：调用方传「当前 HEAD 分支名 + oid」 */
  reloadKey: string | null = null,
): CommitPages {
  const pageSize = scope === 'all' ? GRAPH_PAGE_SIZE : LOG_PAGE_SIZE
  const [commits, setCommits] = useState<GitCommitLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 列表长度（`skip` = 已加载条数）：分页状态就是它本身，没有第二份要同步的计数 */
  const loadedRef = useRef(0)
  /** 「加载更多」正在跑（并发点两次不该发两份请求） */
  const loadingMoreRef = useRef(false)
  /** 装载世代：卸载 / 重取都 +1 —— 在途结果（首屏与「加载更多」共用这一份）只有世代相同才落地 */
  const genRef = useRef(0)

  useEffect(() => {
    const gen = ++genRef.current
    // 换了一份列表：上一份的「加载更多」在途状态一并作废（它的 finally 已不再落地）
    loadingMoreRef.current = false
    setLoadingMore(false)
    setLoading(true)
    setError(null)
    loadCommits(0, scope)
      .then((page) => {
        if (gen !== genRef.current) return
        loadedRef.current = page.length
        setCommits(page)
        setHasMore(page.length >= pageSize)
      })
      .catch((e: unknown) => {
        if (gen !== genRef.current) return
        setError(e instanceof Error ? e.message : String(e))
        setHasMore(false)
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false)
      })
    return () => {
      genRef.current += 1
    }
  }, [scope, pageSize, reloadKey])

  const loadMore = useCallback(() => {
    // ⚠️ 用 ref 做重入门，而不是把副作用写进 `setState` 的更新函数：更新函数必须是**纯**的
    // （StrictMode 下会被调两次 —— 那一页会请求两次、列表里出现重复的两段）
    if (loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const gen = genRef.current
    loadCommits(loadedRef.current, scope)
      .then((page) => {
        if (gen !== genRef.current) return
        // `skip` 按「git 侧已消费的条数」推进（**不是**去重后的列表长度，否则下一页会跳过一段）：
        // 去重只发生在展示层，见模块头第三条
        loadedRef.current += page.length
        setCommits((prev) => {
          // ⚠️ 更新函数必须是**纯**的（StrictMode 会调两次）：`seen` 只由 `prev` 推出，不碰外部计数
          const seen = new Set(prev.map((c) => c.oid))
          return [...prev, ...page.filter((c) => !seen.has(c.oid))]
        })
        setHasMore(page.length >= pageSize)
      })
      .catch((e: unknown) => {
        if (gen !== genRef.current) return
        // 失败时**收掉**「加载更多」：再点也只是再错一次（与首屏失败同一口径）
        setError(e instanceof Error ? e.message : String(e))
        setHasMore(false)
      })
      .finally(() => {
        // 重取 / 卸载已把这一次作废：状态归那一处管，这里不能再碰
        if (gen !== genRef.current) return
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [scope, pageSize])

  return { commits, loading, loadingMore, hasMore, error, loadMore }
}
