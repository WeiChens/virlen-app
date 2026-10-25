/**
 * 用量账本（token 统计）的领域侧写入端口。
 *
 * 一次 LLM 调用记一条流水（标题生成 / 校验这类不产生消息的调用也要计），账本独立于会话生命周期。
 * domain 不能依赖 infrastructure，故这里只定义入口 + 注入点（未注入则静默丢弃）。
 */

/** 一次 LLM 调用的用量流水（字段名与 Rust UsageEntry 一致） */
export interface UsageLedgerRecord {
  /** 调用完成时间（Unix ms） */
  ts: number
  /** 归属会话（无会话上下文的调用可不传） */
  sessionId?: string
  /** chat_round 的幂等键（assistant 消息 id）；其余类型不传（各记一条） */
  messageId?: string
  model: string
  providerType?: string
  providerConfigId?: string
  /** chat_round | compress | title | verify */
  kind: UsageKind
  round?: number
  promptTokens: number
  completionTokens: number
  /** 缓存命中（读取）量：账本口径见 ledgerTokensOf */
  cachedTokens: number
  /**
   * 缓存写入量（Anthropic cache_creation_input_tokens，1.25x 输入价）；其余 provider 恒 0。
   * ⚠️ 必须与 cachedTokens 分列（计价差 12.5 倍）。不变式：prompt + cached + cacheWrite + completion = total
   */
  cacheWriteTokens: number
  totalTokens: number
  /** 是否为本地估算值（非 API 返回），如上下文压缩用 tokenizer 估算 */
  estimated?: boolean
  /**
   * 本次请求的墙钟耗时（ms，含首字延迟 / 思考时间），UI 据此算输出速度。未测量就不传。
   * 只存耗时而非 tok/s：口径变动时不必回填历史。
   */
  durationMs?: number
  /** 请求体实际字节数（JSON 序列化后）；未采集就不传 */
  requestBytes?: number
  /** 发出请求 → 收到响应头（ms）；未采集就不传 */
  responseStartMs?: number
  /** 发出请求 → 收到首个响应字节（ms）；未采集就不传 */
  firstByteMs?: number
}

export type UsageKind =
  | 'chat_round'
  | 'compress'
  | 'title'
  | 'verify'
  | 'embedding'
  /** 长期记忆的整理调用（一批一条；历史数据里还有旧「按天蒸馏」的 memory:<day>） */
  | 'memory'
  | 'legacy'

/**
 * 一次请求的**生成窗口**（ms）= 请求耗时 − 等响应头耗时。
 *
 * 为什么不能直接拿请求耗时当分母：发送请求、网络往返、服务端排队这段时间里模型还
 * 没开始吐字，算进去会把速度**系统性地压低**（长提示词 / 慢连接下尤其严重）。
 *
 * - 缺「等响应头」（旧流水 / 桥接协议）→ 退回整段耗时（保守值，不猜）；
 * - 等待 ≥ 整段（异常值 / 时钟偏差）→ 同样退回整段，不产生非正分母。
 */
export function generationWindowMs(record: {
  durationMs?: number
  responseStartMs?: number
}): number {
  const total = record.durationMs ?? 0
  if (!(total > 0)) return 0
  const wait = record.responseStartMs ?? 0
  if (!(wait > 0) || wait >= total) return total
  return total - wait
}

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
 * 记录一条用量流水。同步「发射即忘」：记账失败不得影响主流程，故不返回 Promise、异常全吞。
 */
export function recordUsage(record: UsageLedgerRecord): void {
  if (!impl) return
  try {
    impl.append([record])
  } catch {
    // 记账是旁路能力，失败不影响业务
  }
}

/** 参与记账的用量形状（各 provider 的 TokenUsage 都满足） */
export interface UsageLike {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** API 明确回报的缓存命中输入量（可能缺省） */
  cachedTokens?: number
  /** API 明确回报的缓存写入量（只有 Anthropic 有） */
  cacheWriteTokens?: number
}

/** 账本口径的用量：promptTokens 一律是「非缓存输入」 */
export interface LedgerTokens {
  promptTokens: number
  completionTokens: number
  /** 缓存命中（读取）量（Anthropic 0.1x 输入价） */
  cachedTokens: number
  /** 缓存写入量（只有 Anthropic 有，1.25x 输入价）；其余 provider 恒 0 */
  cacheWriteTokens: number
  totalTokens: number
}

/**
 * 该 provider 的 promptTokens 是否已包含缓存命中量。
 * openai / gemini 含（gemini 的 cached 是 prompt 子集）；anthropic 不含。
 */
export function cacheIncludedInPrompt(providerType?: string | null): boolean {
  return providerType !== 'anthropic'
}

/**
 * 由 token 三元组推导缓存量：total - prompt - completion（下限 0）。
 * Anthropic 的差值是缓存总量（读 + 写）；仅作兜底，调用方需自行扣掉已回报的写入量。
 */
export function cachedTokensOf(
  totalTokens: number,
  promptTokens: number,
  completionTokens: number,
): number {
  return Math.max(totalTokens - promptTokens - completionTokens, 0)
}

/**
 * 把 provider 回报的 usage 归一化成账本口径（promptTokens = 非缓存输入）。
 *
 * 不归一化两种错法都会算错钱：OpenAI / Gemini 的缓存本就在 promptTokens 里，照抄会重复计一次；
 * Anthropic 的缓存写入若混进命中档会被按 0.1x 计（实际 1.25x）。
 * ⚠️ 无 provider 归属时按 OpenAI 口径；不变式：prompt + cached + cacheWrite + completion === total。
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

  // provider 没回报缓存（或确实无缓存）→ 退回推导；推导值是缓存总量，扣掉已回报的写入量
  const derived = cachedTokensOf(totalTokens, promptTokens, completionTokens)
  return {
    promptTokens,
    completionTokens,
    cachedTokens: Math.max(derived - reportedWrite, 0),
    cacheWriteTokens: reportedWrite,
    totalTokens,
  }
}
