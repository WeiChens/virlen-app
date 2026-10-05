//! 「第二天整理」（P2）—— 把前一天各会话的素材蒸馏成记忆的**编排层**
//!
//! ```text
//! ① 定范围   从 memory_runs 里最后一个「已处理」的日的次日起，到「昨天」为止（最多 MEMORY_MAX_DAYS_PER_RUN 天）
//! ② 逐日：
//!    claim 抢锁（memory_runs 主键 = 幂等键；多窗口 / GUI + CLI 同时开着也只跑一次）
//!    collect 取素材（摘要优先，无摘要用正文摘录；空素材 → skipped，不调模型不花钱）
//!    distill 按降级链逐个候选模型尝试（memoryModel 置顶 → 压缩频次倒序 → 默认模型），3 次全失败 → failed
//!    store   落库（去重 / 详情进知识库）+ 记账（usage_ledger kind='memory'）
//!    finish  落终态（done / partial / failed / skipped）
//! ```
//!
//! 三条**不做**（与方案 §1 非目标一致）：不做常驻定时器、不改压缩语义、不写「半截」记忆
//! （任何一步失败都整体丢弃这一天，下一天 / 手动重试再来）。
//!
//! 时区一律**本地日**（`chrono::Local`）：用户看到的「昨天」是本地昨天；DB 里存毫秒。

use crate::agent::cancellation::CancellationToken;
use crate::agent::memory::distill::{build_prompt, distill_once, DistillOutput};
use crate::agent::memory::models::{
    model_candidates, DistillProviderBuilder, ModelCandidate, MEMORY_COMPRESS_COUNT_LIMIT,
};
use crate::agent::memory::prompt::enabled_from_settings;
use crate::agent::memory::store::{discard_day, store_distilled, StoreDeps};
use crate::agent::memory::{MEMORY_MAX_ATTEMPTS_PER_DAY, MEMORY_MAX_DAYS_PER_RUN, MEMORY_RUN_STALE_MS};
use crate::agent::usage::ledger_tokens;
use crate::rag::rag_service::RagService;
use crate::session_db::{
    ClaimOptions, MemoryRepo, SessionRepo, SettingsRepo, UsageEntry, MEMORY_RUN_DONE,
    MEMORY_RUN_FAILED, MEMORY_RUN_PARTIAL, MEMORY_RUN_SKIPPED,
};
use chrono::{DateTime, Local, LocalResult, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};

/// 蒸馏调用的记账类型 —— `usage_ledger.kind`
pub const MEMORY_USAGE_KIND: &str = "memory";

/// 模型候选的来源（「压缩会话时用得最多的模型」）
pub const MEMORY_COMPRESS_KIND: &str = "compress";

/// 记账幂等键前缀：`memory:<day>`（同一天重试不会重复记账）
pub const MEMORY_LEDGER_MESSAGE_PREFIX: &str = "memory:";

/// 报告状态
pub const REPORT_OK: &str = "ok";
/// 记忆功能被关掉（不查素材、不调模型）
pub const REPORT_DISABLED: &str = "disabled";
/// 没有本地库（浏览器 dev / 库打不开）
pub const REPORT_UNAVAILABLE: &str = "unavailable";
/// 没有可用的模型配置（不调模型，也不会消耗尝试次数）
pub const REPORT_NO_MODEL: &str = "no-model";
/// 没有需要整理的日期（今天就是「已处理到昨天」的状态）
pub const REPORT_NOTHING: &str = "nothing";

/// 本次整理的范围选项
#[derive(Debug, Clone, Default)]
pub struct ConsolidateOptions {
    /// 只整理这一天（`None` = 按「上次处理的次日 → 昨天」逐日补跑）
    pub only_day: Option<String>,
    /// 重跑已处理的日期（先删掉该天旧的蒸馏产出，含详情文档）
    pub force: bool,
}

/// 一天的整理结果（面板 / CLI 直接展示这个）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayReport {
    pub day: String,
    /// `done` | `partial` | `failed` | `skipped`
    pub status: String,
    pub items: i64,
    pub details: i64,
    /// 被近重复合并掉、**没有新增**的条数（P3）
    pub merged: i64,
    pub source_sessions: i64,
    /// 实际使用的模型（`providerConfigId/modelId`）
    pub model: Option<String>,
    /// 失败 / 跳过原因（给用户看的，不含记忆正文）
    pub error: Option<String>,
}

/// 一次触发的总体结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidateReport {
    /// `ok` | `disabled` | `unavailable` | `no-model` | `nothing`
    pub status: String,
    pub days: Vec<DayReport>,
    /// 本次共产出多少条记忆
    pub items: usize,
    /// 其中带详情的条数
    pub details: usize,
    /// 其中被近重复合并掉（没有新增）的条数
    pub merged: usize,
    /// 实际发生的模型调用次数
    pub calls: usize,
}

impl ConsolidateReport {
    fn empty(status: &str) -> Self {
        Self {
            status: status.to_string(),
            days: Vec::new(),
            items: 0,
            details: 0,
            merged: 0,
            calls: 0,
        }
    }
}

/// 整理所需的依赖（显式注入：GUI 命令与 CLI 各装配一次）
pub struct ConsolidateDeps<'a> {
    pub memory: &'a dyn MemoryRepo,
    /// 素材（`messages`）与用量账本都在会话仓储里
    pub sessions: &'a dyn SessionRepo,
    pub settings: &'a dyn SettingsRepo,
    pub rag: Option<&'static RagService>,
    /// 按候选建 Provider（GUI 走桥接工厂，CLI 走原生工厂）
    pub builder: &'a dyn DistillProviderBuilder,
    pub cancel: &'a CancellationToken,
}

/// 用**当前本地时间**整理（宿主入口：GUI 启动 / 面板按钮 / CLI）。
///
/// 与 [`consolidate_pending`] 的差别只有「现在几点」 —— 那一层把时间做成参数，是为了让测试能注入
/// 固定日期（否则跨日、跨月、跨年、DST 都是无法复现的 bug）。
pub async fn consolidate_now(
    deps: ConsolidateDeps<'_>,
    opts: ConsolidateOptions,
) -> Result<ConsolidateReport, String> {
    consolidate_pending(deps, Local::now(), opts).await
}

#[allow(clippy::too_many_lines)] // 逐日流水线的七个步骤写在一起才看得清「顺序即契约」
pub async fn consolidate_pending(    deps: ConsolidateDeps<'_>,
    now_local: DateTime<Local>,
    opts: ConsolidateOptions,
) -> Result<ConsolidateReport, String> {
    if !deps.memory.is_available() || !deps.sessions.is_available() {
        return Ok(ConsolidateReport::empty(REPORT_UNAVAILABLE));
    }
    let settings = match deps.settings.get_all().await {
        Ok(m) => m,
        Err(e) => return Err(format!("读取配置失败: {}", e)),
    };
    if !enabled_from_settings(&settings) {
        return Ok(ConsolidateReport::empty(REPORT_DISABLED));
    }

    let yesterday = match prev_day(&local_day_string(now_local)) {
        Some(d) => d,
        None => return Ok(ConsolidateReport::empty(REPORT_NOTHING)),
    };

    let days = match opts.only_day.as_deref().map(str::trim) {
        Some(day) if !day.is_empty() => {
            if NaiveDate::parse_from_str(day, "%Y-%m-%d").is_err() {
                return Err(format!("日期格式必须是 YYYY-MM-DD，收到: {}", day));
            }
            vec![day.to_string()]
        }
        _ => target_days(&deps, &yesterday).await?,
    };
    if days.is_empty() {
        return Ok(ConsolidateReport::empty(REPORT_NOTHING));
    }

    let mut report = ConsolidateReport::empty(REPORT_OK);
    let store_deps = StoreDeps {
        memory: deps.memory,
        settings: deps.settings,
        rag: deps.rag,
    };
    // 去重参照 + 提示词里的「现有记忆」：一次触发内共用一份快照
    //（同一次触发里刚写的记忆也要成为后面几天的参照 —— 所以每天重新读一次，代价只是一条 SELECT）
    let mut candidates: Option<Vec<ModelCandidate>> = None;

    for day in days {
        let now_ms = crate::telemetry::now_ms();
        let Some((start_ms, end_ms)) = day_bounds_ms(&day) else {
            report.days.push(day_report(
                &day,
                MEMORY_RUN_FAILED,
                0,
                0,
                0,
                0,
                Some("日期无法换算成本地日界".to_string()),
            ));
            continue;
        };

        // ① 先看有没有素材：没有素材就不该消耗尝试次数、更不该调模型
        let materials = deps.sessions.day_materials(start_ms, end_ms).await?;
        if materials.is_empty() {
            let mut run = match deps
                .memory
                .claim_run(&day, claim_opts(&opts, now_ms))
                .await?
            {
                Some(run) => run,
                None => {
                    // 已经处理过（或无锁）→ 不重复记流水，也不报错
                    if opts.only_day.is_some() {
                        report.days.push(already_done_day(deps.memory, &day).await);
                    }
                    continue;
                }
            };
            run.status = MEMORY_RUN_SKIPPED.to_string();
            run.items = 0;
            run.details = 0;
            run.merged = 0;
            run.source_sessions = 0;
            run.error = None;
            run.prompt_tokens = None;
            run.completion_tokens = None;
            run.finished_at = Some(now_ms);
            deps.memory.finish_run(&run).await?;
            report.days.push(day_report(&day, MEMORY_RUN_SKIPPED, 0, 0, 0, 0, None));
            continue;
        }

        // ② 选模型（惰性：只有真的有素材要蒸馏时才去解析配置）
        if candidates.is_none() {
            let counts = deps
                .sessions
                .usage_model_counts(MEMORY_COMPRESS_KIND, MEMORY_COMPRESS_COUNT_LIMIT)
                .await
                .unwrap_or_default();
            candidates = Some(model_candidates(&settings, &counts));
        }
        let candidates_ref: &[ModelCandidate] = candidates.as_deref().unwrap_or(&[]);
        if candidates_ref.is_empty() {
            // 不做尝试（不消耗 attempts）：这是配置问题，不是这一天的失败
            report.status = REPORT_NO_MODEL.to_string();
            report.days.push(day_report(
                &day,
                MEMORY_RUN_FAILED,
                0,
                0,
                0,
                materials.len() as i64,
                Some(
                    "没有可用的模型配置（请在设置里配置 Provider，或先用压缩功能产生一次调用记录）"
                        .to_string(),
                ),
            ));
            break;
        }

        // ③ 抢锁（幂等 / 并发保护）
        let Some(mut run) = deps.memory.claim_run(&day, claim_opts(&opts, now_ms)).await? else {
            if opts.only_day.is_some() {
                report.days.push(already_done_day(deps.memory, &day).await);
            }
            continue;
        };

        // ④ 蒸馏：逐个候选尝试（3 次全失败 → 这一天 failed，且**不写任何记忆**）
        let existing = deps.memory.list(None, true).await?;
        let prompt = build_prompt(&materials, &existing);
        let mut last_error: Option<String> = None;
        let mut success: Option<(DistillOutput, ModelCandidate)> = None;
        for cand in candidates_ref {
            if deps.cancel.is_cancelled() {
                last_error = Some("已取消".to_string());
                break;
            }
            let provider = match deps.builder.build(&cand.connection) {
                Ok(p) => p,
                Err(e) => {
                    // 建不起来（协议不支持 / 桥不可用）→ 换下一个候选
                    last_error = Some(format!("{}: {}", cand.label(), e));
                    continue;
                }
            };
            match distill_once(provider.as_ref(), &cand.model_id, prompt.clone(), deps.cancel).await {
                Ok(out) => {
                    success = Some((out, cand.clone()));
                    break;
                }
                Err(e) => {
                    last_error = Some(format!("{}: {}", cand.label(), e));
                }
            }
        }
        let Some((out, cand)) = success else {
            let error = last_error.unwrap_or_else(|| "所有候选模型都失败".to_string());
            run.status = MEMORY_RUN_FAILED.to_string();
            run.error = Some(error.clone());
            run.finished_at = Some(now_ms);
            deps.memory.finish_run(&run).await?;
            report.days.push(day_report(
                &day,
                MEMORY_RUN_FAILED,
                0,
                0,
                0,
                materials.len() as i64,
                Some(error),
            ));
            continue;
        };
        report.calls += 1;

        // ⑤ 落库：先清掉这一天旧的蒸馏产出（重跑 / 上次写到一半），再写新的
        discard_day(&store_deps, &day).await?;
        let outcome = store_distilled(&store_deps, &day, &out.items, &materials, now_ms).await?;

        // ⑥ 记账（失败只打日志：统计不该让整理失败）
        record_usage(deps.sessions, &day, &cand, &out).await;

        // ⑦ 落终态
        let has_detail_error = outcome.detail_errors > 0;
        run.status = if has_detail_error {
            MEMORY_RUN_PARTIAL.to_string()
        } else {
            MEMORY_RUN_DONE.to_string()
        };
        run.items = outcome.records.len() as i64;
        run.details = outcome.details as i64;
        run.merged = outcome.merged as i64;
        run.source_sessions = materials.len() as i64;
        run.model = Some(cand.label());
        run.error = if has_detail_error {
            Some(format!(
                "{} 条详情写入知识库失败（只保存了摘要）",
                outcome.detail_errors
            ))
        } else {
            None
        };
        run.prompt_tokens = out.usage.as_ref().map(|u| u.prompt_tokens);
        run.completion_tokens = out.usage.as_ref().map(|u| u.completion_tokens);
        run.finished_at = Some(now_ms);
        deps.memory.finish_run(&run).await?;

        report.items += outcome.records.len();
        report.details += outcome.details;
        report.merged += outcome.merged;
        report.days.push(day_report(
            &day,
            &run.status,
            run.items,
            run.details,
            run.merged,
            run.source_sessions,
            None,
        ));
    }

    Ok(report)
}

/// 抢锁参数（自动触发永远 `force = false`；只有面板 / CLI 显式「重新整理」才强制）
fn claim_opts(opts: &ConsolidateOptions, now_ms: i64) -> ClaimOptions {
    ClaimOptions {
        now_ms,
        stale_ms: MEMORY_RUN_STALE_MS,
        max_attempts: MEMORY_MAX_ATTEMPTS_PER_DAY,
        force: opts.force,
    }
}

/// 需要整理的日期：从「最后一个已处理的日的次日」到「昨天」，最多 [`MEMORY_MAX_DAYS_PER_RUN`] 天。
///
/// 首次整理（`memory_runs` 空）从**库里最早一条消息那天**开始 —— 但同样受天数上限约束，
/// 于是「用了半年的库第一次开记忆」不会一次烧掉几十次调用，而是每次启动补一段。
async fn target_days(deps: &ConsolidateDeps<'_>, yesterday: &str) -> Result<Vec<String>, String> {
    let start = match deps.memory.last_done_day().await? {
        Some(day) => next_day(&day),
        None => match deps.sessions.earliest_message_ts().await? {
            // `.single()` 失败（时钟异常 / 越界）→ 交给下游按「没有起点」处理
            Some(ms) => Local.timestamp_millis_opt(ms).single().map(local_day_string),
            None => None,
        },
    };
    let Some(start) = start.filter(|d| !d.is_empty()) else {
        return Ok(Vec::new());
    };
    // ISO 日期串可以直接字典序比较（`YYYY-MM-DD` 定长且高位在前）
    if start.as_str() > yesterday {
        return Ok(Vec::new());
    }

    let mut days: Vec<String> = Vec::new();
    let mut cur = start;
    while cur.as_str() <= yesterday && days.len() < MEMORY_MAX_DAYS_PER_RUN {
        days.push(cur.clone());
        match next_day(&cur) {
            Some(next) => cur = next,
            None => break,
        }
    }
    // 从「最早」那头开始推进：补跑有界（剩下的下次启动继续），且进度单调不回退
    Ok(days)
}

/// 「这一天已经处理过 / 别人在跑」时的报告项（只对显式指定日期的情况有价值）
async fn already_done_day(memory: &dyn MemoryRepo, day: &str) -> DayReport {
    let (status, error) = match memory.get_run(day).await {
        Ok(Some(run)) => {
            let error = match run.status.as_str() {
                MEMORY_RUN_DONE | MEMORY_RUN_PARTIAL => {
                    "这一天已经整理过（要覆盖请用「重新整理」）".to_string()
                }
                MEMORY_RUN_SKIPPED => "这一天没有素材，已跳过".to_string(),
                MEMORY_RUN_FAILED => "这一天已尝试过多次，请稍后手动重试".to_string(),
                _ => "正在整理中（不会重复跑）".to_string(),
            };
            (run.status, error)
        }
        _ => (
            MEMORY_RUN_FAILED.to_string(),
            "无法获取这一天的整理状态".to_string(),
        ),
    };
    DayReport {
        day: day.to_string(),
        status,
        items: 0,
        details: 0,
        merged: 0,
        source_sessions: 0,
        model: None,
        error: Some(error),
    }
}

fn day_report(
    day: &str,
    status: &str,
    items: i64,
    details: i64,
    merged: i64,
    source_sessions: i64,
    error: Option<String>,
) -> DayReport {
    DayReport {
        day: day.to_string(),
        status: status.to_string(),
        items,
        details,
        merged,
        source_sessions,
        model: None,
        error,
    }
}

/// 记账：`kind = 'memory'`，`message_id = memory:<day>` 作幂等键（同一天重试不重复记账）。
///
/// ⚠️ **不复用 [`crate::agent::usage::record_usage`]**：它要求一个 `Session`，而蒸馏一天可能跨多个会话
/// ——这里 `session_id` 显式留空。token 口径仍走 [`ledger_tokens`]（与聊天 / 压缩同一套）。
async fn record_usage(
    sessions: &dyn SessionRepo,
    day: &str,
    cand: &ModelCandidate,
    out: &DistillOutput,
) {
    let Some(usage) = out.usage.as_ref() else {
        return; // provider 没回报用量 → 不记账（与 title 同一取舍）
    };
    let tokens = ledger_tokens(usage, &cand.provider_type);
    let entry = UsageEntry {
        ts: None,
        session_id: None,
        message_id: Some(format!("{}{}", MEMORY_LEDGER_MESSAGE_PREFIX, day)),
        model: cand.model_id.clone(),
        provider_type: Some(cand.provider_type.clone()),
        provider_config_id: Some(cand.provider_config_id.clone()),
        kind: MEMORY_USAGE_KIND.to_string(),
        round: None,
        prompt_tokens: tokens.prompt_tokens,
        completion_tokens: tokens.completion_tokens,
        cached_tokens: tokens.cached_tokens,
        cache_write_tokens: tokens.cache_write_tokens,
        total_tokens: tokens.total_tokens,
        estimated: false,
        // 非正耗时不记（时钟回拨 / 假时长）→ UI 显示 '-' 而不是除零
        duration_ms: Some(out.duration_ms).filter(|d| *d > 0),
        trace_id: None,
    };
    if let Err(e) = sessions.append_usage(&[entry]).await {
        eprintln!("[memory] 整理记账失败（不影响记忆本身）: {}", e);
    }
}

// ==================== 本地日（时区）辅助 ====================

/// 本地日期字符串（`YYYY-MM-DD`）
pub fn local_day_string(dt: DateTime<Local>) -> String {
    dt.format("%Y-%m-%d").to_string()
}

/// 某一天的**本地日界** `[start, end)`（毫秒）。
///
/// 两端都显式构造「本地 00:00」而不是 `start + 86400000`：DST 切换日不是 24 小时，
/// 加常数会把当天最后一小时（或前一小时）的素材算到隔壁去。
pub fn day_bounds_ms(day: &str) -> Option<(i64, i64)> {
    let date = NaiveDate::parse_from_str(day.trim(), "%Y-%m-%d").ok()?;
    let start = local_midnight_ms(date)?;
    let end = date
        .succ_opt()
        .and_then(local_midnight_ms)
        .unwrap_or(start + 86_400_000);
    Some((start, end))
}

/// 本地午夜的毫秒时间戳（DST 跳变把午夜吃掉时取该时刻的任一可用解释）
fn local_midnight_ms(date: NaiveDate) -> Option<i64> {
    let naive = date.and_hms_opt(0, 0, 0)?;
    let dt = match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(earliest, _) => earliest,
        // 个别时区在午夜做 DST 跳变（如巴西的某些年份）：退一小时，保证边界仍然单调
        LocalResult::None => Local
            .from_local_datetime(&date.and_hms_opt(1, 0, 0)?)
            .single()
            .map(|dt| dt - chrono::Duration::hours(1))?,
    };
    Some(dt.timestamp_millis())
}

/// 前一天（`YYYY-MM-DD`）；格式不对 / 溢出 → `None`
pub fn prev_day(day: &str) -> Option<String> {
    NaiveDate::parse_from_str(day.trim(), "%Y-%m-%d")
        .ok()?
        .pred_opt()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

/// 后一天（`YYYY-MM-DD`）；格式不对 / 溢出 → `None`
pub fn next_day(day: &str) -> Option<String> {
    NaiveDate::parse_from_str(day.trim(), "%Y-%m-%d")
        .ok()?
        .succ_opt()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::memory::models::providers_from_settings;
    use crate::agent::provider::Provider;
    use crate::agent::types::{ChatRequest, Message, ProviderConnection, StreamEvent, TokenUsage};
    use crate::session_db::{
        ClaimDecision, MemoryRecord, MemoryRun, ModelUsageCount, SessionMaterial,
        MEMORY_ORIGIN_DISTILL,
    };
    use async_trait::async_trait;
    use serde_json::{json, Map, Value};
    use std::collections::HashMap;
    use std::sync::Mutex;

    // ==================== 桩 ====================

    /// 内存版记忆仓储：把「抢锁 / 落终态 / 按天清理」按真实现的语义实现一遍，
    /// 这样幂等、重跑、尝试耗尽这些**行为**能在单测里被真正验证。
    #[derive(Default)]
    struct FakeRepo {
        runs: Mutex<HashMap<String, MemoryRun>>,
        items: Mutex<Vec<MemoryRecord>>,
    }

    #[async_trait]
    impl MemoryRepo for FakeRepo {
        async fn list(
            &self,
            _level: Option<&str>,
            _include_disabled: bool,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(self.items.lock().unwrap().clone())
        }
        async fn get(&self, id: &str) -> Result<Option<MemoryRecord>, String> {
            Ok(self
                .items
                .lock()
                .unwrap()
                .iter()
                .find(|m| m.id == id)
                .cloned())
        }
        async fn search(
            &self,
            _q: &str,
            _l: Option<&str>,
            _k: Option<&str>,
            _n: usize,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(self.items.lock().unwrap().clone())
        }
        async fn upsert(&self, record: &MemoryRecord) -> Result<(), String> {
            self.items.lock().unwrap().push(record.clone());
            Ok(())
        }
        async fn delete(&self, _id: &str) -> Result<bool, String> {
            Ok(false)
        }
        async fn set_level(&self, _id: &str, _l: &str) -> Result<bool, String> {
            Ok(false)
        }
        async fn set_disabled(&self, _id: &str, _d: bool) -> Result<bool, String> {
            Ok(false)
        }
        async fn touch(&self, _ids: &[String], _now: i64) -> Result<(), String> {
            Ok(())
        }
        async fn get_run(&self, day: &str) -> Result<Option<MemoryRun>, String> {
            Ok(self.runs.lock().unwrap().get(day).cloned())
        }
        async fn list_runs(&self, limit: usize) -> Result<Vec<MemoryRun>, String> {
            let mut runs: Vec<MemoryRun> = self.runs.lock().unwrap().values().cloned().collect();
            runs.sort_by(|a, b| b.day.cmp(&a.day));
            runs.truncate(limit);
            Ok(runs)
        }
        async fn last_done_day(&self) -> Result<Option<String>, String> {
            let runs = self.runs.lock().unwrap();
            Ok(runs
                .values()
                .filter(|r| {
                    matches!(
                        r.status.as_str(),
                        MEMORY_RUN_DONE | MEMORY_RUN_SKIPPED | MEMORY_RUN_PARTIAL
                    )
                })
                .map(|r| r.day.clone())
                .max())
        }
        async fn claim_run(
            &self,
            day: &str,
            opts: ClaimOptions,
        ) -> Result<Option<MemoryRun>, String> {
            let mut runs = self.runs.lock().unwrap();
            let existing = runs.get(day).cloned();
            if crate::session_db::decide_claim(
                existing.as_ref(),
                opts.now_ms,
                opts.stale_ms,
                opts.max_attempts,
                opts.force,
            ) != ClaimDecision::Claimed
            {
                return Ok(None);
            }
            let mut run = existing.unwrap_or_default();
            run.day = day.to_string();
            run.status = crate::session_db::MEMORY_RUN_RUNNING.to_string();
            run.attempts = if opts.force { 1 } else { run.attempts + 1 };
            run.started_at = opts.now_ms;
            run.finished_at = None;
            runs.insert(day.to_string(), run.clone());
            Ok(Some(run))
        }
        async fn finish_run(&self, run: &MemoryRun) -> Result<(), String> {
            self.runs.lock().unwrap().insert(run.day.clone(), run.clone());
            Ok(())
        }
        async fn delete_distilled_day(&self, day: &str) -> Result<Vec<MemoryRecord>, String> {
            let mut items = self.items.lock().unwrap();
            let (out, rest): (Vec<_>, Vec<_>) = items
                .drain(..)
                .partition(|m| m.source_day == day && m.origin == MEMORY_ORIGIN_DISTILL);
            *items = rest;
            Ok(out)
        }
    }

    /// 内存版会话仓储：素材 / 频次 / 记账都记下来供断言
    #[derive(Default)]
    struct FakeSessions {
        materials: Mutex<HashMap<String, Vec<SessionMaterial>>>,
        counts: Mutex<Vec<ModelUsageCount>>,
        earliest: Mutex<Option<i64>>,
        usages: Mutex<Vec<UsageEntry>>,
    }

    impl FakeSessions {
        fn with_day(self, day: &str, materials: Vec<SessionMaterial>) -> Self {
            self.materials.lock().unwrap().insert(day.to_string(), materials);
            self
        }
        fn with_earliest(self, day: &str) -> Self {
            let (start, _) = day_bounds_ms(day).unwrap();
            *self.earliest.lock().unwrap() = Some(start);
            self
        }
        fn with_counts(self, counts: Vec<ModelUsageCount>) -> Self {
            *self.counts.lock().unwrap() = counts;
            self
        }
        fn usages(&self) -> Vec<UsageEntry> {
            self.usages.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl SessionRepo for FakeSessions {
        async fn upsert_session(&self, _s: &crate::agent::types::Session) -> Result<(), String> {
            Ok(())
        }
        async fn append_messages(&self, _s: &str, _m: &[Message]) -> Result<(), String> {
            Ok(())
        }
        async fn replace_messages(&self, _s: &str, _m: &[Message]) -> Result<(), String> {
            Ok(())
        }
        async fn truncate_messages_from(&self, _s: &str, _m: &str) -> Result<(), String> {
            Ok(())
        }
        async fn replace_messages_from(
            &self,
            _s: &str,
            _f: &str,
            _m: &[Message],
        ) -> Result<(), String> {
            Ok(())
        }
        async fn list_sessions(&self) -> Result<Vec<crate::agent::types::Session>, String> {
            Ok(Vec::new())
        }
        async fn session_stats(
            &self,
        ) -> Result<Vec<crate::session_db::SessionStat>, String> {
            Ok(Vec::new())
        }
        async fn get_session(
            &self,
            _id: &str,
        ) -> Result<Option<crate::agent::types::Session>, String> {
            Ok(None)
        }
        async fn get_messages(&self, _id: &str) -> Result<Vec<Message>, String> {
            Ok(Vec::new())
        }
        async fn get_context_messages(&self, _id: &str) -> Result<Vec<Message>, String> {
            Ok(Vec::new())
        }
        async fn get_message_page(
            &self,
            _id: &str,
            _limit: usize,
            _before: Option<i64>,
        ) -> Result<crate::session_db::MessagePage, String> {
            Ok(crate::session_db::MessagePage {
                messages: Vec::new(),
                has_more: false,
                oldest_rowid: None,
            })
        }
        async fn get_user_message_refs(
            &self,
            _id: &str,
        ) -> Result<Vec<crate::session_db::UserMessageRef>, String> {
            Ok(Vec::new())
        }
        async fn search_messages(
            &self,
            _q: &str,
            _s: Option<&str>,
            _r: Option<&str>,
            _l: usize,
            _c: Option<crate::session_db::SearchCursor>,
        ) -> Result<crate::session_db::MessageSearchPage, String> {
            Ok(crate::session_db::MessageSearchPage {
                items: Vec::new(),
                has_more: false,
                next_cursor: None,
            })
        }
        async fn get_message_window(
            &self,
            _s: &str,
            _a: Option<&str>,
            _as: Option<i64>,
            _b: usize,
            _af: usize,
        ) -> Result<crate::session_db::MessageWindow, String> {
            Ok(crate::session_db::MessageWindow {
                anchor_found: false,
                anchor_seq: 0,
                start_seq: 0,
                end_seq: 0,
                total: 0,
                boundary_seq: None,
                clamped_by_boundary: false,
                messages: Vec::new(),
            })
        }
        async fn get_message_timeline(
            &self,
            _s: &str,
            _k: Option<&str>,
            _b: Option<i64>,
            _l: usize,
        ) -> Result<crate::session_db::MessageTimelinePage, String> {
            Ok(crate::session_db::MessageTimelinePage {
                items: Vec::new(),
                has_more: false,
                next_cursor: None,
                total: 0,
                boundary_seq: None,
            })
        }
        async fn delete_session(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        async fn purge_orphan_messages(&self) -> Result<usize, String> {
            Ok(0)
        }
        async fn day_materials(
            &self,
            start_ms: i64,
            end_ms: i64,
        ) -> Result<Vec<SessionMaterial>, String> {
            let all = self.materials.lock().unwrap().clone();
            Ok(all
                .into_iter()
                .filter(|(day, _)| {
                    day_bounds_ms(day)
                        .map(|(s, e)| s == start_ms && e == end_ms)
                        .unwrap_or(false)
                })
                .map(|(_, list)| list)
                .next()
                .unwrap_or_default())
        }
        async fn earliest_message_ts(&self) -> Result<Option<i64>, String> {
            Ok(*self.earliest.lock().unwrap())
        }
        async fn usage_model_counts(
            &self,
            _kind: &str,
            _limit: usize,
        ) -> Result<Vec<ModelUsageCount>, String> {
            Ok(self.counts.lock().unwrap().clone())
        }
        async fn append_usage(&self, entries: &[UsageEntry]) -> Result<(), String> {
            self.usages.lock().unwrap().extend_from_slice(entries);
            Ok(())
        }
        async fn usage_stats(
            &self,
            _q: &crate::session_db::UsageQuery,
        ) -> Result<crate::session_db::UsageStats, String> {
            Ok(Default::default())
        }
        async fn usage_records(
            &self,
            _q: &crate::session_db::UsageQuery,
        ) -> Result<crate::session_db::UsageRecordPage, String> {
            Ok(Default::default())
        }
        async fn clear_usage(&self) -> Result<i64, String> {
            Ok(0)
        }
    }

    /// 按 **provider id** 决定应答的 Provider（`bad*` → 调用失败）
    ///
    /// 桩用 provider id 而不是模型名来区分：`build()` 只拿到连接信息，模型是另外传进去的
    /// ——用 provider id 能直接验证「降级链跳到了下一个候选」。
    struct FakeProvider {
        provider_id: String,
    }

    #[async_trait]
    impl Provider for FakeProvider {
        async fn chat(
            &self,
            request: &ChatRequest,
            _cancel: &CancellationToken,
        ) -> Result<Message, String> {
            if self.provider_id.starts_with("bad") {
                return Err("provider 报错：rate limited".to_string());
            }
            // 桩的正文随**提示词**变化：否则两天产出的记忆文本相同，会被去重掉
            //（真实的模型当然也不会两天说出一模一样的话）
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            if let Some(Value::String(prompt)) = request.messages.first().map(|m| &m.content) {
                prompt.hash(&mut hasher);
            }
            let tag = hasher.finish();
            Ok(Message {
                id: "resp".into(),
                role: "assistant".into(),
                content: Value::String(format!(
                    "{{\"memories\":[{{\"summary\":\"在 virlen-app 实现记忆功能（{}:{}）\",\"kind\":\"project\"}}]}}",
                    request.model, tag
                )),
                usage: Some(TokenUsage {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                    cached_tokens: None,
                    cache_write_tokens: None,
                }),
                timestamp: 0,
                ..Default::default()
            })
        }
        async fn chat_stream(
            &self,
            _r: &ChatRequest,
            _c: &CancellationToken,
            _e: &mut (dyn FnMut(StreamEvent) + Send),
        ) -> Result<(), String> {
            unreachable!()
        }
    }

    #[derive(Default)]
    struct FakeBuilder {
        built: Mutex<Vec<String>>,
    }

    impl DistillProviderBuilder for FakeBuilder {
        fn build(&self, conn: &ProviderConnection) -> Result<Box<dyn Provider>, String> {
            self.built.lock().unwrap().push(conn.provider_id.clone());
            if conn.provider_id.starts_with("unsupported") {
                return Err("协议不支持".to_string());
            }
            Ok(Box::new(FakeProvider {
                provider_id: conn.provider_id.clone(),
            }))
        }
    }

    fn provider_json(id: &str, models: &[&str]) -> Value {
        json!({
            "id": id,
            "type": "openai",
            "apiKey": "sk-stub",
            "baseUrl": "https://api.example.com",
            "models": models,
            "enabled": true,
        })
    }

    struct FakeSettings(Map<String, Value>);

    #[async_trait]
    impl SettingsRepo for FakeSettings {
        async fn get_all(&self) -> Result<Map<String, Value>, String> {
            Ok(self.0.clone())
        }
        async fn upsert(&self, _e: Map<String, Value>) -> Result<(), String> {
            Ok(())
        }
        async fn import_if_empty(&self, _e: Map<String, Value>) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// 造一份 `app_settings`（每个 provider 的模型清单都非空，否则候选根本不会成立）
    fn settings(providers: Vec<(&str, Vec<&str>)>) -> FakeSettings {
        let list: Vec<Value> = providers
            .into_iter()
            .map(|(id, models)| provider_json(id, &models))
            .collect();
        let mut m = Map::new();
        m.insert("providers".to_string(), Value::Array(list));
        FakeSettings(m)
    }

    fn material(session: &str, text: &str) -> SessionMaterial {
        SessionMaterial {
            session_id: session.into(),
            title: format!("会话 {}", session),
            workspace: None,
            agent_id: None,
            summary: Some(text.into()),
            transcript: String::new(),
            updated_at: 1,
        }
    }

    fn counts(pairs: &[(&str, &str, i64)]) -> Vec<ModelUsageCount> {
        pairs
            .iter()
            .map(|(pid, model, calls)| ModelUsageCount {
                provider_config_id: (*pid).to_string(),
                model: (*model).to_string(),
                calls: *calls,
            })
            .collect()
    }

    fn now_at(day: &str) -> DateTime<Local> {
        let (start, _) = day_bounds_ms(day).unwrap();
        Local.timestamp_millis_opt(start + 12 * 3_600_000).unwrap()
    }

    fn deps<'a>(
        memory: &'a FakeRepo,
        sessions: &'a FakeSessions,
        settings: &'a FakeSettings,
        builder: &'a FakeBuilder,
        cancel: &'a CancellationToken,
    ) -> ConsolidateDeps<'a> {
        ConsolidateDeps {
            memory,
            sessions,
            settings,
            rag: None,
            builder,
            cancel,
        }
    }

    // ==================== 日期辅助 ====================

    #[test]
    fn day_helpers_round_trip_and_step() {
        let (start, end) = day_bounds_ms("2026-10-05").unwrap();
        assert!(end > start);
        // DST 日可能是 23 / 25 小时，但一定在合理范围内
        let hours = (end - start) / 3_600_000;
        assert!((23..=25).contains(&hours), "本地日长度异常: {} 小时", hours);
        // 边界必须落在这一天（任何时候都不会滑到隔壁）
        let dt = Local.timestamp_millis_opt(start).unwrap();
        assert_eq!(local_day_string(dt), "2026-10-05");
        let dt_end = Local.timestamp_millis_opt(end - 1).unwrap();
        assert_eq!(local_day_string(dt_end), "2026-10-05");

        assert_eq!(prev_day("2026-10-05").as_deref(), Some("2026-10-04"));
        assert_eq!(next_day("2026-10-05").as_deref(), Some("2026-10-06"));
        assert_eq!(prev_day("2026-03-01").as_deref(), Some("2026-02-28"));
        assert_eq!(next_day("2026-12-31").as_deref(), Some("2027-01-01"));
        assert!(prev_day("不是日期").is_none());
        assert!(day_bounds_ms("2026-13-99").is_none());
    }

    // ==================== 主流程 ====================

    #[tokio::test]
    async fn first_run_covers_every_day_until_yesterday() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-03")
            .with_day("2026-10-03", vec![material("s1", "第一天")])
            .with_day("2026-10-04", vec![material("s1", "第二天")]);
        let settings = settings(vec![("p1", vec!["good-model"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();

        assert_eq!(report.status, REPORT_OK);
        assert_eq!(report.calls, 2, "两天各一次调用");
        assert_eq!(report.items, 2);
        let days: Vec<&str> = report.days.iter().map(|d| d.day.as_str()).collect();
        assert_eq!(days, vec!["2026-10-03", "2026-10-04"], "处理到昨天为止");
        assert!(report.days.iter().all(|d| d.status == MEMORY_RUN_DONE));
        assert_eq!(repo.items.lock().unwrap().len(), 2);
        // 记流水 + 记账，各天一条
        assert_eq!(repo.runs.lock().unwrap().len(), 2);
        let usages = sessions.usages();
        assert_eq!(usages.len(), 2);
        assert_eq!(usages[0].kind, MEMORY_USAGE_KIND);
        assert_eq!(usages[0].message_id.as_deref(), Some("memory:2026-10-03"));
        assert!(usages[0].session_id.is_none(), "一天可能跨会话 → 不归属某个会话");
        assert_eq!(usages[0].total_tokens, 15);
        assert_eq!(usages[0].model, "good-model");
        assert_eq!(
            repo.runs.lock().unwrap()["2026-10-04"].model.as_deref(),
            Some("p1/good-model"),
            "流水里记下实际用的模型"
        );
        assert_eq!(builder.built.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn already_processed_days_are_not_rerun() {
        let repo = FakeRepo::default();
        // 第一天已 done → 本次只跑第二天
        repo.finish_run(&MemoryRun {
            day: "2026-10-03".into(),
            status: MEMORY_RUN_DONE.into(),
            attempts: 1,
            started_at: 1,
            ..Default::default()
        })
        .await
        .unwrap();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-01")
            .with_day("2026-10-03", vec![material("s1", "旧")])
            .with_day("2026-10-04", vec![material("s1", "新")]);
        let settings = settings(vec![("p1", vec!["good"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.calls, 1);
        let days: Vec<&str> = report.days.iter().map(|d| d.day.as_str()).collect();
        assert_eq!(days, vec!["2026-10-04"], "已处理的日不再出现在报告里");
    }

    #[tokio::test]
    async fn backfill_is_capped_per_run() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default().with_earliest("2026-09-01");
        let settings = settings(vec![("p1", vec!["good"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();

        assert_eq!(report.days.len(), MEMORY_MAX_DAYS_PER_RUN);
        assert_eq!(report.days[0].day, "2026-09-01", "从最早那头开始推进（进度单调不回退）");
        assert_eq!(report.calls, 0, "这些天都没有素材 → 不该调模型");
        assert!(report.days.iter().all(|d| d.status == MEMORY_RUN_SKIPPED));
        assert!(sessions.usages().is_empty(), "没调模型就不该有流水");
    }

    #[tokio::test]
    async fn day_without_material_is_marked_skipped() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-04")
            .with_day("2026-10-04", vec![material("s1", "有内容")]);
        let settings = settings(vec![("p1", vec!["good"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-06"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();

        let statuses: Vec<&str> = report.days.iter().map(|d| d.status.as_str()).collect();
        assert_eq!(
            statuses,
            vec![MEMORY_RUN_DONE, MEMORY_RUN_SKIPPED],
            "10-04 有素材 → done；10-05 没素材 → skipped（不调模型）"
        );
        assert_eq!(repo.runs.lock().unwrap()["2026-10-05"].status, MEMORY_RUN_SKIPPED);
        assert_eq!(report.calls, 1);
    }

    #[tokio::test]
    async fn model_chain_falls_back_to_the_next_candidate() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-04")
            .with_day("2026-10-04", vec![material("s1", "内容")])
            .with_counts(counts(&[("bad1", "m1", 9), ("p2", "m2", 5)]));
        // 候选一：provider id 以 bad 开头 → 调用失败；候选二：可用
        let settings = settings(vec![("bad1", vec!["m1"]), ("p2", vec!["m2"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();

        assert_eq!(report.days[0].status, MEMORY_RUN_DONE);
        assert_eq!(report.calls, 1, "成功一次就停，不再试后面的候选");
        assert_eq!(
            repo.runs.lock().unwrap()["2026-10-04"].model.as_deref(),
            Some("p2/m2"),
            "记下的是**实际成功**的那个模型"
        );
        assert_eq!(builder.built.lock().unwrap().as_slice(), ["bad1", "p2"], "先试排在前面的");
        assert_eq!(repo.items.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unbuildable_candidate_is_skipped() {
        // 协议不支持（headless 下的 gemini 等）→ 建 Provider 失败 → 换下一条，而不是整天失败
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-04")
            .with_day("2026-10-04", vec![material("s1", "内容")])
            .with_counts(counts(&[("unsupported1", "m1", 9), ("p2", "m2", 5)]));
        let settings = settings(vec![
            ("unsupported1", vec!["m1"]),
            ("p2", vec!["m2"]),
        ]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.days[0].status, MEMORY_RUN_DONE);
        assert_eq!(
            repo.runs.lock().unwrap()["2026-10-04"].model.as_deref(),
            Some("p2/m2")
        );
    }

    #[tokio::test]
    async fn all_candidates_failing_writes_nothing_and_can_be_retried() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-04")
            .with_day("2026-10-04", vec![material("s1", "内容")])
            .with_counts(counts(&[("bad1", "m1", 9), ("bad2", "m2", 5)]));
        let settings = settings(vec![("bad1", vec!["m1"]), ("bad2", vec!["m2"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();

        assert_eq!(report.days[0].status, MEMORY_RUN_FAILED);
        assert_eq!(
            builder.built.lock().unwrap().len(),
            2,
            "候选链全部试过（2 个可用候选）"
        );
        assert!(report.days[0]
            .error
            .as_deref()
            .unwrap()
            .contains("rate limited"));
        assert!(repo.items.lock().unwrap().is_empty(), "失败绝不写半截记忆");
        assert!(sessions.usages().is_empty(), "没拿到用量 → 不记账");
        let run = repo.runs.lock().unwrap()["2026-10-04"].clone();
        assert_eq!(run.status, MEMORY_RUN_FAILED);
        assert_eq!(run.attempts, 1);
        assert!(run.error.is_some());

        // 第二次：还能再试一次（attempts < 2）
        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(repo.runs.lock().unwrap()["2026-10-04"].attempts, 2);
        assert_eq!(report.days[0].status, MEMORY_RUN_FAILED);

        // 第三次：尝试次数耗尽 → 不再跑（避免每次启动都烧一次调用）
        let before = builder.built.lock().unwrap().len();
        consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(builder.built.lock().unwrap().len(), before);
    }

    #[tokio::test]
    async fn missing_model_config_reports_no_model_without_burning_attempts() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-04")
            .with_day("2026-10-04", vec![material("s1", "内容")]);
        let settings = FakeSettings(Map::new()); // 没有任何 provider
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();

        assert_eq!(report.status, REPORT_NO_MODEL);
        assert_eq!(report.calls, 0);
        assert!(repo.runs.lock().unwrap().is_empty(), "配置问题不消耗尝试次数");
        assert!(report.days[0].error.as_deref().unwrap().contains("模型配置"));
    }

    #[tokio::test]
    async fn disabled_switch_short_circuits() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default().with_day("2026-10-04", vec![material("s1", "内容")]);
        let mut m = Map::new();
        m.insert("memoryEnabled".to_string(), Value::Bool(false));
        let settings = FakeSettings(m);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.status, REPORT_DISABLED);
        assert_eq!(report.calls, 0);
        assert!(repo.items.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn explicit_day_runs_only_that_day_and_force_rewrites_it() {
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_day("2026-10-04", vec![material("s1", "内容")])
            .with_counts(vec![ModelUsageCount {
                provider_config_id: "p1".into(),
                model: "good".into(),
                calls: 3,
            }]);
        let settings = settings(vec![("p1", vec!["good"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        // 第一次：整理指定的一天
        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-10"),
            ConsolidateOptions {
                only_day: Some("2026-10-04".into()),
                force: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(report.days.len(), 1);
        assert_eq!(report.days[0].status, MEMORY_RUN_DONE);
        let first_id = repo.items.lock().unwrap()[0].id.clone();

        // 再点一次（不带 force）：已经整理过 → 明确告知，而不是假装又跑了一次
        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-10"),
            ConsolidateOptions {
                only_day: Some("2026-10-04".into()),
                force: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(report.calls, 0);
        assert!(report.days[0]
            .error
            .as_deref()
            .unwrap()
            .contains("已经整理过"));

        // 重新整理：覆盖旧条目（去重不会因此把新内容挡掉，因为旧条目先被删了）
        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-10"),
            ConsolidateOptions {
                only_day: Some("2026-10-04".into()),
                force: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(report.days[0].status, MEMORY_RUN_DONE);
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items.len(), 1, "旧条目被删掉，只剩新的那条");
        assert_ne!(items[0].id, first_id);

        // 非法日期 → 明确报错（而不是静默不跑）
        assert!(consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-10"),
            ConsolidateOptions {
                only_day: Some("10/04/2026".into()),
                force: false,
            },
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn unavailable_storage_short_circuits() {
        use crate::session_db::{NoopMemoryRepo, NoopSessionRepo};
        let memory = NoopMemoryRepo;
        let sessions = NoopSessionRepo;
        let settings = FakeSettings(Map::new());
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();
        let report = consolidate_pending(
            ConsolidateDeps {
                memory: &memory,
                sessions: &sessions,
                settings: &settings,
                rag: None,
                builder: &builder,
                cancel: &cancel,
            },
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.status, REPORT_UNAVAILABLE);
    }

    #[tokio::test]
    async fn nothing_to_do_when_already_caught_up() {
        let repo = FakeRepo::default();
        repo.finish_run(&MemoryRun {
            day: "2026-10-04".into(),
            status: MEMORY_RUN_DONE.into(),
            ..Default::default()
        })
        .await
        .unwrap();
        let sessions = FakeSessions::default();
        let settings = settings(vec![("p1", vec!["good"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.status, REPORT_NOTHING);
        assert!(report.days.is_empty());
    }

    #[tokio::test]
    async fn second_run_of_same_day_dedupes_new_entries() {
        // 同一天重跑时，已有条目仍是去重参照（除非显式 force 先删旧的）
        let repo = FakeRepo::default();
        let sessions = FakeSessions::default()
            .with_earliest("2026-10-04")
            .with_day("2026-10-04", vec![material("s1", "内容")]);
        let settings = settings(vec![("p1", vec!["good"])]);
        let builder = FakeBuilder::default();
        let cancel = CancellationToken::new();

        consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions {
                only_day: Some("2026-10-04".into()),
                force: true,
            },
        )
        .await
        .unwrap();
        let first = repo.items.lock().unwrap().len();

        // 重置流水（模拟「跑到一半崩了」）后再跑一次：旧条目先被删 → 结果仍然只有一条
        repo.runs.lock().unwrap().clear();
        let report = consolidate_pending(
            deps(&repo, &sessions, &settings, &builder, &cancel),
            now_at("2026-10-05"),
            ConsolidateOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(report.days[0].status, MEMORY_RUN_DONE);
        assert_eq!(repo.items.lock().unwrap().len(), first, "不会写出第二条重复记忆");
    }

    #[test]
    fn providers_from_settings_tolerates_dirty_entries() {
        // 只验证契约：一条脏 provider 不拖垮其余（真正的排序规则在 models.rs 的用例里）
        let s = FakeSettings({
            let mut m = Map::new();
            m.insert(
                "providers".to_string(),
                json!([{"id": "broken"}, provider_json("p1", &["m"])]),
            );
            m
        });
        let providers = providers_from_settings(&s.0);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "p1");
    }
}
