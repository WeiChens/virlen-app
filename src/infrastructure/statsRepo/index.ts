/**
 * statsRepo — 用量账本的读取 Repository（Rust SQLite）
 *
 * 数据由 Rust 侧 `session_db/usage.rs` 的 `usage_ledger` 表承载（表结构 DDL 见 `session_db/schema.rs`）：
 * 写入来自两处（Rust 引擎内部直落 + TS 侧 `cmd_append_usage`），读取只有这里。
 *
 * 非 Tauri 环境（vitest / 浏览器 dev）invoke 会抛错，统一兜底为空结果 ——
 * 统计面板在纯前端环境应当显示「无数据」而不是报错。
 */
import { invoke } from '@tauri-apps/api/core'
import { trackError } from '@/utils/telemetry'

/** 用量查询参数（与 Rust `UsageQuery` 逐字对应） */
export interface UsageStatsQuery {
  fromTs?: number
  toTs?: number
  sessionId?: string
  model?: string
  kind?: string
  /** hour | day | week | month | model | session | kind | provider */
  groupBy?: string
  limit?: number
  offset?: number
}

/** 一个聚合桶（`totals` 复用此结构） */
export interface UsageBucket {
  key: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  /** 调用次数 */
  calls: number
  /** 其中估算值条数（非 API 返回） */
  estimatedCalls: number
}

export interface UsageStats {
  buckets: UsageBucket[]
  totals: UsageBucket
  /** 账本内最早 / 最晚流水时间（Unix ms） */
  firstTs: number | null
  lastTs: number | null
}

/** 一条用量明细 */
export interface UsageRecord {
  id: number
  ts: number
  sessionId: string | null
  /** 会话标题（会话已删除时为 null —— 流水仍保留） */
  sessionTitle: string | null
  messageId: string | null
  model: string
  providerType: string | null
  providerConfigId: string | null
  kind: string
  round: number | null
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  estimated: boolean
  traceId: string | null
}

export interface UsageRecordPage {
  records: UsageRecord[]
  total: number
}

export interface StatsRepo {
  stats(query: UsageStatsQuery): Promise<UsageStats>
  records(query: UsageStatsQuery): Promise<UsageRecordPage>
  /** 清空账本，返回删除条数 */
  clear(): Promise<number>
}

/** 空统计（非 Tauri 环境 / 出错兜底） */
const EMPTY_STATS: UsageStats = {
  buckets: [],
  totals: {
    key: '',
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    calls: 0,
    estimatedCalls: 0,
  },
  firstTs: null,
  lastTs: null,
}

/** 是否运行在 Tauri 里（浏览器 dev / vitest 下 invoke 必然失败，不该刷埋点） */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 查询失败时的兜底：面板显示「无数据」而不是报错。
 *
 * 但**必须留下埋点**：之前这里静默吞错，导致「明细在带时间过滤时全空」
 * （Rust 侧 COUNT 少写了表别名）这类 bug 在 UI 上完全看不出来。
 */
function fallback<T>(event: string, empty: T, error: unknown): T {
  if (inTauri()) trackError(event, error)
  return empty
}

class TauriStatsRepo implements StatsRepo {
  async stats(query: UsageStatsQuery): Promise<UsageStats> {
    try {
      return await invoke<UsageStats>('cmd_usage_stats', { query })
    } catch (e) {
      return fallback('usage.stats.fail', EMPTY_STATS, e)
    }
  }

  async records(query: UsageStatsQuery): Promise<UsageRecordPage> {
    try {
      return await invoke<UsageRecordPage>('cmd_usage_query', { query })
    } catch (e) {
      return fallback('usage.records.fail', { records: [], total: 0 }, e)
    }
  }

  async clear(): Promise<number> {
    try {
      return await invoke<number>('cmd_usage_clear')
    } catch (e) {
      return fallback('usage.clear.fail', 0, e)
    }
  }
}

export const statsRepo: StatsRepo = new TauriStatsRepo()
