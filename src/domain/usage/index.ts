/**
 * 用量账本（token 统计）— 领域侧写入端口
 *
 * 与 Rust 侧 `src-tauri/src/agent/usage.rs::record_usage` 语义一致（铁律 1）：
 * **一次 LLM 调用记一条流水**，`kind` 区分调用类型。
 *
 * 为什么要单独记账而不复用 `messages.usage`：
 *   1. 标题生成 / 迭代校验这类调用**不产生消息**，usage 若只挂在消息上就会丢失；
 *   2. 账本独立于会话生命周期 —— 删除会话不清账，历史总量不会缩水。
 * 设计见 `docs/token-usage-stats.md`。
 *
 * 依赖方向：`domain/` 不能依赖 `infrastructure/`（不能直接 invoke Tauri），
 * 因此这里只定义「写入口 + 注入点」；真正的 SQLite 实现由 `services` 层在启动时
 * 通过 `bindUsageLedger()` 注入（未注入时静默丢弃，不阻塞主流程）。
 */

/** 一次 LLM 调用的用量流水（领域侧形状，字段名与 Rust `UsageEntry` 一致） */
export interface UsageLedgerRecord {
  /** 调用完成时间（Unix ms） */
  ts: number
  /** 归属会话（无会话上下文的调用可不传） */
  sessionId?: string
  /**
   * `chat_round` 的幂等键（assistant 消息 id）。
   * 其余类型不传 —— 它们每次调用都是独立消费，必须各记一条。
   */
  messageId?: string
  model: string
  providerType?: string
  providerConfigId?: string
  /** chat_round | compress | title | verify */
  kind: UsageKind
  round?: number
  promptTokens: number
  completionTokens: number
  /** 缓存读/写：账本口径的「缓存命中输入量」（见 `ledgerTokensOf` 的归一化说明） */
  cachedTokens: number
  totalTokens: number
  /** 是否为本地估算值（非 API 返回），如上下文压缩用 tokenizer 估算 */
  estimated?: boolean
}

export type UsageKind =
  | 'chat_round'
  | 'compress'
  | 'title'
  | 'verify'
  | 'embedding'
  | 'legacy'

/** 用量账本写入端口 */
export interface UsageLedgerPort {
  /** 追加流水（fire-and-forget：实现必须自行吞掉异常，不得影响主流程） */
  append(records: UsageLedgerRecord[]): void
}

/** 已注入的实现（启动时由 services 层绑定） */
let impl: UsageLedgerPort | null = null

/** 注入实现（应用启动时调用一次；测试环境不注入即为空操作） */
export function bindUsageLedger(port: UsageLedgerPort): void {
  impl = port
}

/**
 * 记录一条用量流水。
 *
 * 刻意是同步的「发射即忘」接口：记账失败绝不能影响聊天 / 校验主流程，
 * 因此这里不返回 Promise、不做 await、异常全部吞掉（出错在实现内部打日志）。
 */
export function recordUsage(record: UsageLedgerRecord): void {
  if (!impl) return
  try {
    impl.append([record])
  } catch {
    // 记账是旁路能力，失败不影响业务
  }
}

/** 参与记账的用量形状（各 provider 的 `TokenUsage` 都满足） */
export interface UsageLike {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** API 明确回报的缓存命中输入量（可能缺省） */
  cachedTokens?: number
}

/** 账本口径的用量：`promptTokens` 一律是「非缓存输入」 */
export interface LedgerTokens {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
}

/**
 * 该 provider 的 `promptTokens` 是否**已经包含**缓存命中量。
 *
 * - `openai`（含 DeepSeek 等兼容实现）：`prompt_tokens` 是全部输入，缓存命中算在里面；
 * - `gemini`：`cachedContentTokenCount` 是 `promptTokenCount` 的子集；
 * - `anthropic`：`input_tokens` **不含** cache 读写，缓存单独在 `cache_*` 字段里。
 */
export function cacheIncludedInPrompt(providerType?: string | null): boolean {
  return providerType !== 'anthropic'
}

/**
 * 由 token 三元组推导缓存量：`total - prompt - completion`（下限 0）。
 *
 * Anthropic 把 `cache_read_input_tokens + cache_creation_input_tokens` 计入 `totalTokens`
 * （`promptTokens` 只算非缓存输入），差值即缓存量；OpenAI 口径下恒为 0。
 * 仅在 provider 没有明确回报缓存时作为兜底。
 */
export function cachedTokensOf(
  totalTokens: number,
  promptTokens: number,
  completionTokens: number,
): number {
  return Math.max(totalTokens - promptTokens - completionTokens, 0)
}

/**
 * 把 provider 回报的 usage 归一化成**账本口径**。
 *
 * 为什么要归一化：账本里 `promptTokens` 是**非缓存输入**、`cachedTokens` 单独一列，
 * 计费时按两档单价分别算（`domain/pricing::computeCost`）。而 OpenAI 兼容 / Gemini
 * 把缓存命中算在 `prompt_tokens` 里 —— 直接照抄会让这部分被按输入价**重复计一次钱**。
 *
 * ⚠️ 没有 provider 归属信息时按 OpenAI 口径处理（更常见）；
 * 归一化后不变式：`prompt + cached + completion === total`。
 */
export function ledgerTokensOf(
  u: UsageLike,
  providerType?: string | null,
): LedgerTokens {
  const completionTokens = u.completionTokens || 0
  const promptTokens = u.promptTokens || 0
  const totalTokens = u.totalTokens || promptTokens + completionTokens
  const reported = u.cachedTokens ?? 0

  if (reported > 0) {
    if (!cacheIncludedInPrompt(providerType)) {
      // Anthropic：prompt 本来就不含缓存，直接用
      return {
        promptTokens,
        completionTokens,
        cachedTokens: reported,
        totalTokens,
      }
    }
    // OpenAI 兼容 / Gemini：缓存算在 prompt 里，从 prompt 减掉
    const cached = Math.min(reported, promptTokens)
    return {
      promptTokens: promptTokens - cached,
      completionTokens,
      cachedTokens: cached,
      totalTokens,
    }
  }

  // provider 没回报缓存（或确实无缓存）→ 退回推导
  return {
    promptTokens,
    completionTokens,
    cachedTokens: cachedTokensOf(totalTokens, promptTokens, completionTokens),
    totalTokens,
  }
}
