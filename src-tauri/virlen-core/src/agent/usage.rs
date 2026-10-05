//! 用量记账 — Rust 引擎侧统一入口（token 统计）
//!
//! 与 TS 侧 `src/domain/ports/UsageLedgerPort.ts` 语义一致（铁律 1）：
//! **一次 LLM 调用记一条流水**，`kind` 区分调用类型（chat_round / verify / ...）。
//!
//! 为什么不复用 `messages.usage`：账本要覆盖「不产生消息的调用」（如迭代校验），
//! 并且要独立于会话生命周期（删会话不清账）。
//!
//! 记账失败只告警，**绝不**让主流程（聊天 / 验证）因统计失败而失败。

use super::types::{Session, TokenUsage};
use crate::session_db::{SessionRepo, UsageEntry};

/// 缓存 token 推算（**兜底**）：`total - prompt - completion`（下限 0）。
///
/// Anthropic 把 `cache_read_input_tokens + cache_creation_input_tokens` 计入 `total_tokens`，
/// 而 `prompt_tokens` 只算非缓存输入，因此差值即为缓存量；
/// OpenAI 口径下 `total = prompt + completion`，结果恒为 0
/// —— 所以 provider 能明确回报缓存时必须直接用（见 `ledger_tokens`），
/// 只靠这条推算会让「缓存」永远显示 0。
pub fn cached_tokens_of(total: i64, prompt: i64, completion: i64) -> i64 {
    (total - prompt - completion).max(0)
}

/// 该 provider 的 `prompt_tokens` 是否**已经包含**缓存命中量。
///
/// - `openai`（含 DeepSeek 等兼容实现）：`prompt_tokens` 是全部输入，缓存命中算在里面；
/// - `gemini`：`cachedContentTokenCount` 是 `promptTokenCount` 的子集；
/// - `anthropic`：`input_tokens` **不含** cache 读写，缓存单独在 `cache_*` 字段里。
///
/// 与 TS `domain/usage::cacheIncludedInPrompt` 必须一致（铁律 1）。
pub fn cache_in_prompt(provider_type: &str) -> bool {
    provider_type != "anthropic"
}

/// 账本口径的用量：`prompt_tokens` 一律是「非缓存输入」
pub struct LedgerTokens {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    /// 缓存**命中（读取）**量：Anthropic 按 0.1x 输入价；OpenAI 兼容 / Gemini 的缓存也归这一档
    pub cached_tokens: i64,
    /// 缓存**写入**量：目前只有 Anthropic 会有（按 1.25x 输入价），其余 provider 恒 0
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
}

/// 把 provider 回报的 usage 归一化成**账本口径**（与 TS `domain/usage::ledgerTokensOf` 一致）。
///
/// 为什么要归一化：账本里 `prompt_tokens` 是**非缓存输入**，缓存读数与缓存**写入**各占一列，
/// 计费三档单价分开算。两种错法都会算错钱：
/// - OpenAI 兼容 / Gemini 把缓存算在 prompt 里，直接照抄会让那部分按输入价**重复计一次**；
/// - Anthropic 的缓存写入若混进「命中」档，就会被按 0.1x 计（实际 1.25x，低估 12.5 倍）。
///
/// 不变式：`prompt + cached + cache_write + completion === total`。
pub fn ledger_tokens(u: &TokenUsage, provider_type: &str) -> LedgerTokens {
    // 非正 / 缺失一律当 0（目前只有 Anthropic 会报缓存写入量）
    let write = u.cache_write_tokens.filter(|n| *n > 0).unwrap_or(0);
    match u.cached_tokens.filter(|n| *n > 0) {
        Some(reported) => {
            if cache_in_prompt(provider_type) {
                // 缓存（读 + 写）都算在 prompt 里 → 一并从 prompt 扣掉；
                // 截断保证不出现负数 prompt（异常数据宁可少算，不得为负）
                let read = reported.min(u.prompt_tokens);
                let write = write.min(u.prompt_tokens - read);
                LedgerTokens {
                    prompt_tokens: u.prompt_tokens - read - write,
                    completion_tokens: u.completion_tokens,
                    cached_tokens: read,
                    cache_write_tokens: write,
                    total_tokens: u.total_tokens,
                }
            } else {
                // Anthropic：`input_tokens` 本来就不含缓存，原样保留
                LedgerTokens {
                    prompt_tokens: u.prompt_tokens,
                    completion_tokens: u.completion_tokens,
                    cached_tokens: reported,
                    cache_write_tokens: write,
                    total_tokens: u.total_tokens,
                }
            }
        }
        // provider 没回报缓存（或确实无缓存）→ 退回推导
        None => {
            // 推导出来的是「缓存总量」（读 + 写）：已明确回报的写入量要从里面扣出来
            let derived =
                cached_tokens_of(u.total_tokens, u.prompt_tokens, u.completion_tokens);
            LedgerTokens {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                cached_tokens: derived.saturating_sub(write),
                cache_write_tokens: write,
                total_tokens: u.total_tokens,
            }
        }
    }
}

/// 记录一条用量流水。
///
/// - `kind`：`chat_round` | `verify` | `title` | `compress` | `embedding` | `memory`
/// - `message_id`：`chat_round` 传 assistant 消息 id 作幂等键；其余传 `None`（每次调用独立记账）
/// - `duration_ms`：本次 LLM 请求的墙钟耗时（含首字延迟）—— UI 用它算 tok/s；
///   拿不到就传 `None`（落库为 0，UI 显示 `-`）。与 TS 侧 `UsageLedgerRecord.durationMs` 对称（铁律 1）
/// - `usage` 为 `None`（provider 未返回用量，如流式中断）时不记账
/// - `estimated`：`usage` 是否为**本地估算**（provider 没回报用量时的兜底）——
///   UI 需与真实用量区分展示（与 TS `recordUsage` 的 `estimated` 列语义一致）
#[allow(clippy::too_many_arguments)]
pub async fn record_usage(
    repo: &dyn SessionRepo,
    session_id: &str,
    session: &Session,
    provider_type: &str,
    provider_config_id: &str,
    kind: &str,
    round: Option<i64>,
    message_id: Option<&str>,
    usage: Option<TokenUsage>,
    estimated: bool,
    duration_ms: Option<i64>,
) {
    let Some(u) = usage else {
        return;
    };
    // 口径拉平：prompt = 非缓存输入、cached 单独一列（否则缓存价永远用不上 / 会被重复计费）
    let tokens = ledger_tokens(&u, provider_type);
    let entry = UsageEntry {
        ts: None,
        session_id: Some(session_id.to_string()),
        message_id: message_id.map(String::from),
        model: session.model_id.clone(),
        provider_type: Some(provider_type.to_string()),
        provider_config_id: Some(provider_config_id.to_string()),
        kind: kind.to_string(),
        round,
        prompt_tokens: tokens.prompt_tokens,
        completion_tokens: tokens.completion_tokens,
        cached_tokens: tokens.cached_tokens,
        cache_write_tokens: tokens.cache_write_tokens,
        total_tokens: tokens.total_tokens,
        estimated,
        // 非正耗时不记（如注入假时长 / 时钟回拨）→ UI 显示 '-' 而不是除零或无穷大
        duration_ms: duration_ms.filter(|d| *d > 0),
        trace_id: crate::telemetry::get_session_trace(session_id),
    };
    if let Err(e) = repo.append_usage(&[entry]).await {
        eprintln!("[usage] 记账失败(kind={}): {}", kind, e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_tokens_derivation() {
        // OpenAI 口径：total = prompt + completion → 无缓存
        assert_eq!(cached_tokens_of(150, 100, 50), 0);
        // Anthropic 口径：cache 计入 total（prompt 只算非缓存输入）
        assert_eq!(cached_tokens_of(300, 100, 50), 150);
        // 异常数据（total 偏小）不得产生负数
        assert_eq!(cached_tokens_of(10, 100, 50), 0);
    }

    fn usage(prompt: i64, completion: i64, total: i64, cached: Option<i64>) -> TokenUsage {
        TokenUsage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total,
            cached_tokens: cached,
            cache_write_tokens: None,
        }
    }

    /// Anthropic 形状：缓存读 / 写分别回报
    fn usage_with_cache(prompt: i64, completion: i64, total: i64, read: i64, write: i64) -> TokenUsage {
        TokenUsage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total,
            cached_tokens: Some(read),
            cache_write_tokens: Some(write),
        }
    }

    #[test]
    fn ledger_tokens_splits_cache_read_from_write() {
        // 这就是本次修复的核心：不分列就会把「写」当「读」计价（0.1x vs 1.25x，差 12.5 倍）
        let t = ledger_tokens(&usage_with_cache(100, 50, 250, 40, 60), "anthropic");
        assert_eq!(t.prompt_tokens, 100);
        assert_eq!(t.cached_tokens, 40, "命中（读）单独一列");
        assert_eq!(t.cache_write_tokens, 60, "写入单独一列");
        assert_eq!(
            t.prompt_tokens + t.cached_tokens + t.cache_write_tokens + t.completion_tokens,
            t.total_tokens,
            "归一化后 prompt + cached + cache_write + completion 必须等于 total"
        );
    }

    #[test]
    fn ledger_tokens_write_split_survives_the_derived_branch() {
        // provider 只报了 total（没报 cached）但要报写入量时，写入不得被并进「命中」里
        let mut u = usage(100, 50, 310, None);
        u.cache_write_tokens = Some(60);
        let t = ledger_tokens(&u, "anthropic");
        assert_eq!(t.cache_write_tokens, 60);
        assert_eq!(t.cached_tokens, 100, "推导出 160，扣掉 60 写入后剩 100 命中");
        assert_eq!(
            t.prompt_tokens + t.cached_tokens + t.cache_write_tokens + t.completion_tokens,
            t.total_tokens
        );
    }

    #[test]
    fn ledger_tokens_keeps_write_zero_for_openai_like_providers() {
        let t = ledger_tokens(&usage(1000, 100, 1100, Some(800)), "openai");
        assert_eq!(t.cache_write_tokens, 0);
        assert_eq!(
            t.prompt_tokens + t.cached_tokens + t.cache_write_tokens + t.completion_tokens,
            t.total_tokens
        );
    }

    #[test]
    fn ledger_tokens_normalizes_cache_semantics() {
        // OpenAI：缓存算在 prompt 里 → 从 prompt 减掉，避免按输入价重复计费
        let t = ledger_tokens(&usage(1000, 100, 1100, Some(800)), "openai");
        assert_eq!(t.prompt_tokens, 200);
        assert_eq!(t.cached_tokens, 800);
        assert_eq!(t.cache_write_tokens, 0);
        assert_eq!(
            t.prompt_tokens + t.cached_tokens + t.completion_tokens,
            t.total_tokens,
            "归一化后 prompt + cached + completion 必须等于 total"
        );

        // Anthropic：prompt 本来就不含缓存 → 原样保留（total 仍包含缓存）
        let t = ledger_tokens(&usage(100, 50, 300, Some(150)), "anthropic");
        assert_eq!(t.prompt_tokens, 100);
        assert_eq!(t.cached_tokens, 150);

        // provider 未回报缓存 → 退回推导（Anthropic 把 cache 计进 total 时仍能算出来）
        let t = ledger_tokens(&usage(100, 50, 300, None), "openai");
        assert_eq!(t.cached_tokens, 150);
        assert_eq!(t.prompt_tokens, 100);

        // 异常数据：cached > prompt 时按 prompt 截断，prompt 不得为负
        let t = ledger_tokens(&usage(10, 5, 15, Some(999)), "openai");
        assert_eq!(t.prompt_tokens, 0);
        assert_eq!(t.cached_tokens, 10);
    }
}
