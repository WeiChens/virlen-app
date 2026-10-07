/**
 * 用量账本（token 统计）— 领域侧写入端口。
 *
 * 与 Rust `agent/usage.rs::record_usage` 语义一致：**一次 LLM 调用记一条流水**，`kind` 区分类型。
 * 为何不复用 `messages.usage`：标题生成/校验这类调用不产生消息，且账本独立于会话生命周期（删会话不清账）。
 *
 * `domain/` 不能依赖 `infrastructure/`，故这里只定义「写入口 + 注入点」，SQLite 实现由 `services`
 * 启动时经 `bindUsageLedger()` 注入（未注入则静默丢弃）。
 */

/** 一次 LLM 调用的用量流水（领域侧形状，字段名与 Rust `UsageEntry` 一致） */
export interface UsageLedgerRecord {
  /** 调用完成时间（Unix ms） */
  ts: number
  /** 归属会话（无会话上下文的调用可不传） */
  sessionId?: string
  /** `chat_round` 的幂等键（assistant 消息 id）；其余类型不传（每次调用独立消费，各记一条） */
  messageId?: string
  model: string
  providerType?: string
  providerConfigId?: string
  /** chat_round | compress | title | verify */
  kind: UsageKind
  round?: number
  promptTokens: number
  completionTokens: number
  /** 缓存**命中（读取）**量：账本口径见 `ledgerTokensOf` */
  cachedTokens: number
  /**
   * 缓存**写入**量（Anthropic `cache_creation_input_tokens`，1.25x 输入价）；其余 provider 恒 0。
   * ⚠️ 必须与 `cachedTokens` 分列（计价差 12.5 倍）。口径：`prompt + cached + cacheWrite + completion = total`
   */
  cacheWriteTokens: number
  totalTokens: number
  /** 是否为本地估算值（非 API 返回），如上下文压缩用 tokenizer 估算 */
  estimated?: boolean
  /**
   * 本次 LLM 请求的墙钟耗时（ms，**含首字延迟 / 思考时间**），UI 据此算输出速度。
   * 与 Rust `UsageEntry.duration_ms` 对称；未测量就不传（落库 0，UI 显示 `-`）。
   * 只存耗时而非 tok/s：口径变动时不必回填历史。
   */
  durationMs?: number
}

export type UsageKind =
  | 'chat_round'
  | 'compress'
  | 'title'
  | 'verify'
  | 'embedding'
  /** 长期记忆的蒸馏整理（记忆功能 P2）：一次整理调用记一条，`messageId` 为 `memory:<day>` */
  | 'memory'
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
 * 记录一条用量流水。刻意是同步「发射即忘」接口：记账失败不得影响主流程，故不返回 Promise、
 * 异常全部吞掉（出错在实现内部打日志）。
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
  /** API 明确回报的缓存**写入**量（只有 Anthropic 有，可能缺省） */
  cacheWriteTokens?: number
}

/** 账本口径的用量：`promptTokens` 一律是「非缓存输入」 */
export interface LedgerTokens {
  promptTokens: number
  completionTokens: number
  /** 缓存**命中（读取）**量（Anthropic 0.1x 输入价） */
  cachedTokens: number
  /** 缓存**写入**量（只有 Anthropic 有，1.25x 输入价）；其余 provider 恒 0 */
  cacheWriteTokens: number
  totalTokens: number
}

/**
 * 该 provider 的 `promptTokens` 是否**已包含**缓存命中量。
 * `openai` / `gemini` 含（gemini 的 cached 是 prompt 子集）；`anthropic` 不含（cache 单独在 `cache_*`）。
 */
export function cacheIncludedInPrompt(providerType?: string | null): boolean {
  return providerType !== 'anthropic'
}

/**
 * 由 token 三元组推导缓存量：`total - prompt - completion`（下限 0）。
 * Anthropic 的差值是**缓存总量（读 + 写）**；OpenAI 口径恒为 0。仅作兜底，调用方需自行扣掉已回报的写入量。
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
 * 账本口径：`promptTokens` 为非缓存输入，缓存读/写各占一列、三档单价分开算。
 * 不归一化的两种错法都会算错钱：
 * - OpenAI 兼容 / Gemini 把缓存算在 `promptTokens` 里，直接照抄会按输入价重复计一次；
 * - Anthropic 的缓存写入若混进命中档会被按 0.1x 计（实际 1.25x）。
 *
 * ⚠️ 无 provider 归属信息时按 OpenAI 口径处理；不变式：
 * `prompt + cached + cacheWrite + completion === total`。
 */
export function ledgerTokensOf(
  u: UsageLike,
  providerType?: string | null,
): LedgerTokens {
  const completionTokens = u.completionTokens || 0
  const promptTokens = u.promptTokens || 0
  const totalTokens = u.totalTokens || promptTokens + completionTokens
  const reported = u.cachedTokens ?? 0
  // 非正 / 缺失一律当 0（目前只有 Anthropic 会报缓存写入量）
  const reportedWrite = Math.max(u.cacheWriteTokens ?? 0, 0)

  if (reported > 0) {
    if (!cacheIncludedInPrompt(providerType)) {
      // Anthropic：prompt 本来就不含缓存，直接用
      return {
        promptTokens,
        completionTokens,
        cachedTokens: reported,
        cacheWriteTokens: reportedWrite,
        totalTokens,
      }
    }
    // OpenAI 兼容 / Gemini：缓存（读 + 写）都算在 prompt 里 → 一并从 prompt 扣掉
    const cached = Math.min(reported, promptTokens)
    const cacheWriteTokens = Math.min(reportedWrite, promptTokens - cached)
    return {
      promptTokens: promptTokens - cached - cacheWriteTokens,
      completionTokens,
      cachedTokens: cached,
      cacheWriteTokens,
      totalTokens,
    }
  }

  // provider 没回报缓存（或确实无缓存）→ 退回推导；推导值是「缓存总量」，扣掉已回报的写入量
  const derived = cachedTokensOf(totalTokens, promptTokens, completionTokens)
  return {
    promptTokens,
    completionTokens,
    cachedTokens: Math.max(derived - reportedWrite, 0),
    cacheWriteTokens: reportedWrite,
    totalTokens,
  }
}
