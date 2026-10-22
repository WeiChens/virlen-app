/**
 * 轨迹的「请求事实」装载器：把**用量账本**接进只读的轨迹视图。
 *
 * 为什么需要它：`messages` 只留下「产生消息的那次请求」的结果，请求本身的生命周期
 * （真实耗时、用的哪个模型、是不是本地估算）全在 `usage_ledger` 里 ——
 * 一次 LLM 调用一条流水，`chat_round` 以 assistant 消息 id 作幂等键。
 *
 * 两个渠道各管一件事，不能互相替代：
 * - `stats()` → 会话**全量**合计（不受分页影响；还包含标题 / 压缩 / 校验这些不产生消息的调用）
 * - `records()` → 逐条事实（模型 / 实测耗时 / 估算标记），用来落到「回复」行
 *
 * 为什么放在视图里而不是 store：账本是只读的外部事实，不属于会话状态。关掉轨迹就该
 * 释放掉，没必要让它常驻内存。
 */
import { useEffect, useState } from 'react'
import {
  requestStatsFromTotals,
  type TrajectoryLedgerStats,
  type TrajectoryRequestFacts,
} from '@/domain/trajectory'
import { statsRepo } from '@/infrastructure/statsRepo'

/**
 * 一次拉多少条流水。
 *
 * 轨迹表本身是分页的（回补历史才前插），没必要为几十万条历史流水付 IPC + 内存；
 * 1000 条对应用户能一眼扫到的范围。⚠️ 因此「实测耗时」的合计是**最近 N 次**口径，
 * 而 token 合计走 `stats()` 是全量口径 —— 两个数在界面上必须分别标注。
 */
const FACTS_LIMIT = 1000

/** 消息变化到拉取之间的防抖：流式期间 messages 会连续变化，别每帧都打 IPC */
const REFRESH_DEBOUNCE_MS = 400

export interface SessionUsage {
  /** 逐条请求事实（账本流水，已按会话过滤） */
  facts: TrajectoryRequestFacts[]
  /** 会话级合计（账本口径）；账本里没有该会话的流水时为 null */
  ledger: TrajectoryLedgerStats | null
  /** 是否还在加载（首次加载时有值，避免统计条闪一下 0） */
  loading: boolean
}

/**
 * 拉取某个会话的请求事实。
 *
 * @param sessionId 会话 id（空串 = 不拉）
 * @param revision 变化即重拉。**不能只传消息条数**：一次请求完成时 assistant 占位消息早就在
 *   数组里了（长度不变、时间戳也不变），只有 `usage` / `streaming` 会变 —— 而账本正是在那一刻
 *   才写入。所以父层传的是「长度 + 末条时间戳 + 末条 token + 是否在流式」拼成的指纹。
 */
export function useSessionUsage(sessionId: string, revision: string): SessionUsage {
  /**
   * 缓存里带上 `sessionId`：切会话时旧会话的账本不能拿来当新会话的统计。
   *
   * 为什么不在 effect 里先清空：effect 在 commit 之后才跑，中间那一帧会把
   * 上一段会话的「输入 1.2M」显示到新会话头上。用携带 id 的方式在**渲染期**就
   * 判定为「不匹配 → 空」——这一帧显示的是加载中，而不是错数据。
   */
  const [cache, setCache] = useState<{ sessionId: string; usage: SessionUsage }>({
    sessionId,
    usage: { facts: [], ledger: null, loading: sessionId !== '' },
  })

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    // 同一会话刷新时保留旧数据（否则流式期间每 400ms 拉一次会让耗时列闪一下）：
    // 只把 loading 抬起来，拉到新数据再整体替换。
    setCache((current) =>
      current.sessionId === sessionId
        ? { sessionId, usage: { ...current.usage, loading: true } }
        : { sessionId, usage: { facts: [], ledger: null, loading: true } },
    )
    const timer = setTimeout(() => {
      void (async () => {
        const [all, chat, legacy, page] = await Promise.all([
          statsRepo.stats({ sessionId }),
          // 单独查两个 kind：totals 里没有「按 kind 拆分」，而「对话请求 / 其它调用」
          // 这组数字正是用户想知道的那件事（标题生成也算钱）
          statsRepo.stats({ sessionId, kind: 'chat_round' }),
          // `legacy` = 从 `messages.usage` 回填的历史流水（老库升级前根本没有 kind），
          // 它同样是「一次对话回复的请求」。不算进对话请求的话，老会话会显示成
          // 「对话 3 次 / 其它 40 次」，像是几十次莫名其妙的调用。
          statsRepo.stats({ sessionId, kind: 'legacy' }),
          statsRepo.records({ sessionId, limit: FACTS_LIMIT }),
        ])
        if (cancelled) return
        const totals = all.totals
        setCache({
          sessionId,
          usage: {
            facts: page.records.map(toFacts),
            ledger:
              totals.calls > 0
                ? requestStatsFromTotals({
                  promptTokens: totals.promptTokens,
                  completionTokens: totals.completionTokens,
                  cachedTokens: totals.cachedTokens,
                  cacheWriteTokens: totals.cacheWriteTokens,
                  calls: totals.calls,
                  estimatedCalls: totals.estimatedCalls,
                  chatCalls: chat.totals.calls + legacy.totals.calls,
                })
                : null,
            loading: false,
          },
        })
      })()
    }, REFRESH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionId, revision])

  if (cache.sessionId !== sessionId) {
    return { facts: [], ledger: null, loading: sessionId !== '' }
  }
  return cache.usage
}

/**
 * 账本明细 → 轨迹事实。
 *
 * `duration_ms` 的 0 要当「未测量」处理（旧流水 / 老库补出来的列默认 0），
 * 不能当成「0 毫秒的请求」—— 那会让均值凭空变小。
 */
function toFacts(record: {
  id: number
  ts: number
  messageId: string | null
  model: string
  providerType: string | null
  kind: string
  round: number | null
  durationMs: number
  estimated: boolean
  traceId: string | null
}): TrajectoryRequestFacts {
  return {
    ...(record.id > 0 ? { id: record.id } : {}),
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.providerType ? { provider: record.providerType } : {}),
    kind: record.kind,
    ...(record.round !== null ? { round: record.round } : {}),
    ...(record.durationMs > 0 ? { durationMs: record.durationMs } : {}),
    ...(record.estimated ? { estimated: true } : {}),
    ...(record.traceId ? { traceId: record.traceId } : {}),
    ...(record.ts > 0 ? { ts: record.ts } : {}),
  }
}
