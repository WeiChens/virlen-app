//! 记忆再蒸馏（P2′）—— **编排层**
//!
//! ```text
//! ① 清理     归档超期条目（§4.8 四条护栏；与阈值无关，幂等，单轮 ≤ 50 条）
//! ② 取快照   list(None, true) → 过滤 origin <> 'user'
//! ③ 分组     按 project_path 分组；只留条数 ≥ 5 的组
//! ④ 选组     条数最多的组（并列时组名升序 —— 全序，可测）
//! ⑤ 切批     组内按 score 升序取前 40 条；再按归档预算收敛（读详情后才知道真长度）
//! ⑥ 指纹     fnv1a64(scope + Σ "id:updated_at")  ← 幂等键
//! ⑦ claim    memory_redistill_runs（AlreadyDone / Busy / Exhausted / Claimed）
//! ⑧ 组装     提示词 prompts/memory-redistill.md（{{scope}} / {{max_items}} / {{memories}}）
//! ⑨ 调用     降级链 ≤ 3 个候选模型，非流式、max_tokens 8000、temperature 0.2、可取消
//! ⑩ 校验     解析 + 逐项校验（§4.4）；整批无有效输出 → skipped(no-gain)
//! ⑪ 落库     写新条目（含归档详情）→ 全部成功后 CAS 停用来源（回滚在 apply）
//! ⑫ 记账     usage_ledger kind='memory'，message_id = "memory:redistill:<fingerprint>"（幂等）
//! ⑬ 终态     runs 一行落地；本轮还有批且未越线 → 回到 ②
//! ```
//!
//! 用户全程无感（D5）：没有 UI、没有审批、没有弹窗；失败只落日志 / 埋点 / 账本。
//!
//! ⚠️ 本模块只做「取数 → 判定 → 调用 → 落库」的顺序编排：纯逻辑在 `plan.rs`，改库在 `apply.rs`，
//! 谁在跑在 `sched.rs`。三处各自可测，合起来才是这条流水线。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::cancellation::CancellationToken;
use crate::agent::memory::prompt::enabled_from_settings;
use crate::agent::memory::redistill::apply::{
    apply_batch, purge_archived, ApplyDeps, PlanToApply, SourceDetail,
};
use crate::agent::memory::redistill::models::{
    memory_model_candidates, MemoryProviderBuilder, ModelCandidate,
};
use crate::agent::memory::redistill::parse::{content_text, parse_redistill_response};
use crate::agent::memory::redistill::plan::{
    batch_fingerprint, build_prompt, fit_archive_budget, group_candidates, pick_batch,
    render_archive, validate_drafts, ArchiveEntry,
};
use crate::agent::memory::{detail_link, kb, MEMORY_DETAIL_MAX_CHARS};
use crate::agent::provider::Provider;
use crate::agent::types::{ChatRequest, Message, TokenUsage};
use crate::agent::usage::ledger_tokens;
use crate::rag::rag_service::RagService;
use crate::session_db::{
    ClaimOptions, MemoryRecord, MemoryRepo, MemoryRedistillRun, SessionRepo, SettingsRepo, UsageEntry,
    MEMORY_REDISTILL_DONE, MEMORY_REDISTILL_FAILED, MEMORY_REDISTILL_PARTIAL,
    MEMORY_REDISTILL_PURGE_FINGERPRINT, MEMORY_REDISTILL_SKIPPED,
};

pub mod apply;
pub mod models;
pub mod parse;
pub mod plan;
pub mod sched;

// ==================== 常量（§11.1 参数一览） ====================

/// 触发阈值：`disabled = 0 AND origin <> 'user'` 的条数达到它才考虑合并
pub const MEMORY_REDISTILL_TRIGGER_COUNT: usize = 100;

/// 单批最多喂多少条（完全没有详情时的上限；40 × 170 ≈ 6 800 < 归档预算 8 000）
pub const MEMORY_REDISTILL_BATCH_MAX_ITEMS: usize = 40;

/// 输入预算（字符）：只算 `summary` + 骨架，**不算详情正文**（40 条 ≈ 9 k，留 2.6× 余量）
pub const MEMORY_REDISTILL_MAX_INPUT_CHARS: usize = 24_000;

/// 组内条数下限：太少的组不值得一次模型调用
pub const MEMORY_REDISTILL_MIN_GROUP_ITEMS: usize = 5;

/// 单批最多输出多少条（跑飞的兜底）
pub const MEMORY_REDISTILL_MAX_OUT_ITEMS: usize = 20;

/// 压缩比下限：每条输出至少要有这么多来源（1:1 的「合并」没有收益，只会改写正文）
pub const MEMORY_REDISTILL_MIN_RATIO: usize = 2;

/// 单轮最多跑几批（= 单轮模型调用上限）
pub const MEMORY_REDISTILL_MAX_BATCHES_PER_RUN: usize = 3;

/// 轮次间隔：上一轮 `done` / `partial` 之后至少等这么久
pub const MEMORY_REDISTILL_COOLDOWN_MS: i64 = 1_800_000;

/// 失败退避
pub const MEMORY_REDISTILL_FAIL_BACKOFF_MS: i64 = 21_600_000;

/// 同一指纹最多尝试几次（之后等人工 `--force`）
pub const MEMORY_REDISTILL_MAX_ATTEMPTS: i64 = 3;

/// `running` 超过它即视为崩溃残留，可被下一次 claim 抢占
pub const MEMORY_REDISTILL_STALE_MS: i64 = 600_000;

/// 蒸馏调用的 `max_tokens`。
///
/// ⚠️ **必须显式钳制**：GUI 会话默认 `maxTokens` 是 `2000000`（不限制），原样透传给服务端会被
/// 直接拒掉（400 `Invalid max_tokens value`）。
pub const MEMORY_REDISTILL_MAX_TOKENS: i64 = 8_000;

/// 温度：要严格 JSON，取低值（`title.rs` 是 0.3）
pub const MEMORY_REDISTILL_TEMPERATURE: f64 = 0.2;

/// 降级链长度：3 次尝试全失败就退出
pub const MEMORY_REDISTILL_MODEL_MAX_CANDIDATES: usize = 3;

/// 逃生开关（D5）—— `app_settings` 键名，与 TS `SettingsStore.memoryRedistillEnabled` 同名同层。
/// **缺键 = 开**：默认开、不进 UI（用户察觉不到）；想关掉就手改库一行：
/// `UPDATE app_settings SET value='false' WHERE key='memoryRedistillEnabled';`
pub const MEMORY_REDISTILL_ENABLED_KEY: &str = "memoryRedistillEnabled";

/// 归档保留期（30 天）：`supersede` 那一刻起算，到期后由清理按四条护栏硬删
pub const MEMORY_REDISTILL_ARCHIVE_RETENTION_MS: i64 = 2_592_000_000;

/// 单轮清理上限（每次删除都要动知识库，要有界）
pub const MEMORY_REDISTILL_PURGE_MAX_PER_RUN: usize = 50;

/// 两次清理的最小间隔（清理不花钱，但要读一次库、要删详情文档）
pub const MEMORY_REDISTILL_PURGE_MIN_INTERVAL_MS: i64 = 86_400_000;

/// 单条来源自己的详情超过它就移出本次候选（不让一条巨无霸把整批压成 1 条）
pub const MEMORY_REDISTILL_MAX_SOURCE_DETAIL_CHARS: usize = 4_000;

/// 归档正文里「模型给的合并说明」至少要占这么多字符才值得保留（半截总结比没有更误导）
pub const MEMORY_REDISTILL_MODEL_DETAIL_MIN_CHARS: usize = 200;

/// 记账类型（`usage_ledger.kind`）
pub const MEMORY_USAGE_KIND: &str = "memory";

/// 记账幂等键前缀：`memory:redistill:<fingerprint>`（同一批重试不重复记账）
pub const MEMORY_LEDGER_PREFIX: &str = "memory:redistill:";

/// 报告级状态
pub const REPORT_OK: &str = "ok";
/// 记忆功能或再蒸馏被关掉
pub const REPORT_DISABLED: &str = "disabled";
/// 没有本地库（浏览器 dev / 库打不开）
pub const REPORT_UNAVAILABLE: &str = "unavailable";
/// 没有可用的模型配置（不消耗尝试次数）
pub const REPORT_NO_MODEL: &str = "no-model";
/// 没有需要处理的东西
pub const REPORT_NOTHING: &str = "nothing";

/// 批次级跳过原因（写进 runs / 报告）
pub const REASON_NO_GAIN: &str = "no-gain";
pub const REASON_NO_RAG: &str = "no-rag";
pub const REASON_ARCHIVE_TOO_LONG: &str = "archive-too-long";
pub const REASON_TOO_FEW_ITEMS: &str = "too-few-items";
pub const REASON_ALREADY_DONE: &str = "already-done";

/// 一轮内最多尝试几个组（已处理 / 装不下的组会被跳过，防止在它们身上空转）
const MAX_GROUP_ATTEMPTS: usize = 5;

// ==================== 任务与报告 ====================

/// 一次任务的类型（队列里的元素）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedistillTask {
    /// 先清理、再合并
    Full,
    /// 只做归档清理（清理与阈值解绑：条数掉到阈值以下也要继续清）
    PurgeOnly,
}

impl RedistillTask {
    pub fn label(&self) -> &'static str {
        match self {
            RedistillTask::Full => "full",
            RedistillTask::PurgeOnly => "purge",
        }
    }
}

/// 一批的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub fingerprint: String,
    pub scope: String,
    /// `done` | `partial` | `skipped` | `failed`
    pub status: String,
    pub items_in: i64,
    pub items_out: i64,
    pub details: i64,
    pub drifted: i64,
    pub unarchived: i64,
    pub model: Option<String>,
    /// 跳过原因（[`REASON_NO_GAIN`] 等）；成功时为 `None`
    pub reason: Option<String>,
    /// 失败原因 / 降级说明（**不含记忆正文**）
    pub error: Option<String>,
}

/// 一次触发的总体结果（GUI 命令 / CLI 直接展示它）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedistillReport {
    /// `ok` | `disabled` | `unavailable` | `no-model` | `nothing`
    pub status: String,
    /// `full` | `purge`
    pub task: String,
    pub purged: usize,
    pub purged_failed: usize,
    pub batches: Vec<BatchReport>,
    pub items_in: usize,
    pub items_out: usize,
    /// 实际发生的模型调用次数
    pub calls: usize,
}

impl RedistillReport {
    fn empty(status: &str, task: RedistillTask) -> Self {
        Self {
            status: status.to_string(),
            task: task.label().to_string(),
            purged: 0,
            purged_failed: 0,
            batches: Vec::new(),
            items_in: 0,
            items_out: 0,
            calls: 0,
        }
    }
}

/// 编排所需的依赖（GUI 命令 / CLI / 后台宿主各装配一次）
pub struct RedistillDeps<'a> {
    pub memory: &'a dyn MemoryRepo,
    /// 用量账本在会话仓储里
    pub sessions: &'a dyn SessionRepo,
    pub settings: &'a dyn SettingsRepo,
    pub rag: Option<&'static RagService>,
    /// 按候选建 Provider（GUI 走桥接工厂，CLI 走原生工厂）
    pub builder: &'a dyn MemoryProviderBuilder,
    pub cancel: &'a CancellationToken,
}

// ==================== 编排 ====================

/// 用**当前时间**跑一轮（宿主入口）
pub async fn run_now(
    deps: RedistillDeps<'_>,
    task: RedistillTask,
    force: bool,
) -> Result<RedistillReport, String> {
    run_at(deps, task, crate::telemetry::now_ms(), force).await
}

/// 跑一轮。`force`（面板 / CLI 显式触发）= 忽略冷却与「这批处理过」的幂等判定。
#[allow(clippy::too_many_lines)] // 逐批流水线的十三个步骤写在一起才看得清「顺序即契约」
pub async fn run_at(
    deps: RedistillDeps<'_>,
    task: RedistillTask,
    now_ms: i64,
    force: bool,
) -> Result<RedistillReport, String> {
    if !deps.memory.is_available() || !deps.sessions.is_available() {
        return Ok(RedistillReport::empty(REPORT_UNAVAILABLE, task));
    }
    let settings = match deps.settings.get_all().await {
        Ok(m) => m,
        Err(e) => return Err(format!("读取配置失败: {}", e)),
    };
    if !enabled_from_settings(&settings) {
        return Ok(RedistillReport::empty(REPORT_DISABLED, task));
    }
    // 逃生开关：缺键 = 开（默认开、不进 UI）
    if !settings
        .get(MEMORY_REDISTILL_ENABLED_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Ok(RedistillReport::empty(REPORT_DISABLED, task));
    }

    let mut report = RedistillReport::empty(REPORT_OK, task);
    let apply_deps = ApplyDeps {
        memory: deps.memory,
        settings: deps.settings,
        rag: deps.rag,
    };

    // ── ① 清理（与阈值无关：条数掉到 100 以下也要继续清，否则归档条目永久堆积）──
    let purge = purge_archived(
        &apply_deps,
        now_ms,
        MEMORY_REDISTILL_ARCHIVE_RETENTION_MS,
        MEMORY_REDISTILL_PURGE_MAX_PER_RUN,
    )
    .await;
    report.purged = purge.purged;
    report.purged_failed = purge.failed;
    if matches!(task, RedistillTask::Full) || purge.purged > 0 || purge.failed > 0 {
        record_purge_run(&deps, now_ms, &purge).await;
    }
    if matches!(task, RedistillTask::PurgeOnly) {
        if purge.purged == 0 && purge.failed == 0 {
            report.status = REPORT_NOTHING.to_string();
        }
        return Ok(report);
    }

    // ── ②–⑬ 逐批循环 ──
    let mut candidates: Option<Vec<ModelCandidate>> = None;
    let mut calls = 0usize;
    let mut attempts = 0usize;
    // 一轮内已试过 / 已处理的组（按作用域屏蔽，避免在同一个组上空转）
    let mut blocked: Vec<String> = Vec::new();

    while calls < MEMORY_REDISTILL_MAX_BATCHES_PER_RUN && attempts < MAX_GROUP_ATTEMPTS {
        if deps.cancel.is_cancelled() {
            break;
        }
        attempts += 1;

        // ② 取快照 ③ 分组 ④ 选组
        let all = deps.memory.list(None, true).await?;
        let Some(group) = group_candidates(&all, now_ms)
            .into_iter()
            .find(|g| !blocked.contains(&g.scope))
        else {
            if report.batches.is_empty() {
                report.status = REPORT_NOTHING.to_string();
            }
            break;
        };

        // ⑤ 切批（先按条数 / 输入预算，读详情后再按归档预算收敛）
        let batch = pick_batch(
            &group.items,
            MEMORY_REDISTILL_BATCH_MAX_ITEMS,
            MEMORY_REDISTILL_MAX_INPUT_CHARS,
        );

        // RAG 不可用 → 整批 skipped(no-rag)：没有归档就不许停用来源
        if deps.rag.is_none() {
            report.status = REPORT_OK.to_string();
            report.batches.push(BatchReport {
                fingerprint: batch_fingerprint(&group.scope, &batch),
                scope: group.scope.clone(),
                status: MEMORY_REDISTILL_SKIPPED.to_string(),
                items_in: batch.len() as i64,
                items_out: 0,
                details: 0,
                drifted: 0,
                unarchived: 0,
                model: None,
                reason: Some(REASON_NO_RAG.to_string()),
                error: Some("知识库不可用".to_string()),
            });
            break;
        }

        let details = read_source_details(&deps, &batch).await;
        let lens: HashMap<String, usize> = details
            .iter()
            .map(|(id, d)| (id.clone(), d.chars()))
            .collect();
        let fit = fit_archive_budget(
            &batch,
            &lens,
            MEMORY_DETAIL_MAX_CHARS,
            MEMORY_REDISTILL_MAX_SOURCE_DETAIL_CHARS,
        );
        if !fit.too_long.is_empty() {
            eprintln!(
                "[memory] {} 条记忆的详情过长，本次候选里已移出: {:?}",
                fit.too_long.len(),
                fit.too_long
            );
        }
        let batch = fit.kept;

        // 候选模型（惰性：只有真要去合并时才解析配置）
        if candidates.is_none() {
            candidates =
                Some(memory_model_candidates(&settings, MEMORY_REDISTILL_MODEL_MAX_CANDIDATES));
        }
        let cands: Vec<ModelCandidate> = candidates.clone().unwrap_or_default();
        if cands.is_empty() {
            // 不做尝试（不消耗 attempts）：这是配置问题，不是记忆库的问题
            report.status = REPORT_NO_MODEL.to_string();
            break;
        }
        if batch.len() < MEMORY_REDISTILL_MIN_RATIO {
            blocked.push(group.scope.clone());
            report.batches.push(BatchReport {
                fingerprint: batch_fingerprint(&group.scope, &batch),
                scope: group.scope.clone(),
                status: MEMORY_REDISTILL_SKIPPED.to_string(),
                items_in: batch.len() as i64,
                items_out: 0,
                details: 0,
                drifted: 0,
                unarchived: 0,
                model: None,
                reason: Some(REASON_TOO_FEW_ITEMS.to_string()),
                error: None,
            });
            continue;
        }

        // ⑥ 指纹 ⑦ claim
        let fingerprint = batch_fingerprint(&group.scope, &batch);
        let opts = ClaimOptions {
            now_ms,
            stale_ms: MEMORY_REDISTILL_STALE_MS,
            max_attempts: MEMORY_REDISTILL_MAX_ATTEMPTS,
            force,
        };
        let Some(mut run) = deps
            .memory
            .claim_redistill_run(&fingerprint, &group.scope, opts)
            .await?
        else {
            // 已处理 / 别人在跑 / 尝试耗尽 → 换下一组（一轮内不再试这一组）
            blocked.push(group.scope.clone());
            report.batches.push(BatchReport {
                fingerprint,
                scope: group.scope.clone(),
                status: MEMORY_REDISTILL_SKIPPED.to_string(),
                items_in: batch.len() as i64,
                items_out: 0,
                details: 0,
                drifted: 0,
                unarchived: 0,
                model: None,
                reason: Some(REASON_ALREADY_DONE.to_string()),
                error: None,
            });
            continue;
        };

        // ⑧ 组装 ⑨ 调用（降级链）
        let prompt = build_prompt(&group.scope, MEMORY_REDISTILL_MAX_OUT_ITEMS, &batch);
        let mut last_error: Option<String> = None;
        let mut success: Option<(CallOutput, ModelCandidate)> = None;
        for cand in &cands {
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
            match call_once(provider.as_ref(), &cand.model_id, prompt.clone(), deps.cancel).await {
                Ok(out) => {
                    success = Some((out, cand.clone()));
                    break;
                }
                Err(e) => last_error = Some(format!("{}: {}", cand.label(), e)),
            }
        }
        let Some((out, cand)) = success else {
            let error = last_error.unwrap_or_else(|| "所有候选模型都失败".to_string());
            finish_run(
                &deps,
                &mut run,
                MEMORY_REDISTILL_FAILED,
                batch.len(),
                0,
                0,
                0,
                cand_label(&cands),
                None,
                Some(error.clone()),
                now_ms,
                None,
            )
            .await;
            report.batches.push(BatchReport {
                fingerprint,
                scope: group.scope.clone(),
                status: MEMORY_REDISTILL_FAILED.to_string(),
                items_in: batch.len() as i64,
                items_out: 0,
                details: 0,
                drifted: 0,
                unarchived: 0,
                model: cand_label(&cands),
                reason: None,
                error: Some(error),
            });
            // 模型失败通常是全局性的（网络 / 配置）：换一组大概率还是失败，别白花钱
            break;
        };
        report.calls += 1;
        // ⑫ 记账（失败只打日志；放在这儿是因为钱**确实**已经花掉了）
        record_usage(
            deps.sessions,
            &fingerprint,
            &cand,
            out.usage.as_ref(),
            out.duration_ms,
        )
        .await;

        // ⑩ 校验
        let validated = validate_drafts(&out.drafts, &batch, MEMORY_REDISTILL_MAX_OUT_ITEMS);
        if validated.plans.is_empty() {
            finish_run(
                &deps,
                &mut run,
                MEMORY_REDISTILL_SKIPPED,
                batch.len(),
                0,
                0,
                0,
                Some(cand.label()),
                Some(REASON_NO_GAIN),
                None,
                now_ms,
                out.usage.clone(),
            )
            .await;
            report.batches.push(BatchReport {
                fingerprint,
                scope: group.scope.clone(),
                status: MEMORY_REDISTILL_SKIPPED.to_string(),
                items_in: batch.len() as i64,
                items_out: 0,
                details: 0,
                drifted: 0,
                unarchived: 0,
                model: Some(cand.label()),
                reason: Some(REASON_NO_GAIN.to_string()),
                error: None,
            });
            // 自然停止条件：压不动了就停
            break;
        }

        // ⑪ 组装落库计划（归档正文由我们生成，不靠模型）
        let by_id: HashMap<&str, &MemoryRecord> =
            batch.iter().map(|m| (m.id.as_str(), m)).collect();
        let mut to_apply: Vec<PlanToApply> = Vec::new();
        let mut archive_too_long = false;
        for plan in &validated.plans {
            let sources: Vec<MemoryRecord> = plan
                .sources
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).map(|m| (*m).clone()))
                .collect();
            let entries: Vec<ArchiveEntry> = sources
                .iter()
                .map(|s| ArchiveEntry {
                    record: s.clone(),
                    detail: details.get(&s.id).and_then(|d| d.text()).map(String::from),
                })
                .collect();
            let archive = render_archive(plan.detail.as_deref(), &entries, MEMORY_DETAIL_MAX_CHARS);
            if archive.chars().count() > MEMORY_DETAIL_MAX_CHARS {
                // 保真优先：装不下就宁可不整理（切批时已按预算收敛，这里是 fail-safe）
                archive_too_long = true;
                break;
            }
            let supersede: Vec<String> = sources
                .iter()
                .filter(|s| details.get(&s.id).map(SourceDetail::archivable).unwrap_or(true))
                .map(|s| s.id.clone())
                .collect();
            let unarchived = sources.len() - supersede.len();
            to_apply.push(PlanToApply {
                summary: plan.summary.clone(),
                kind: plan.kind.clone(),
                level: plan.level.clone(),
                tags: plan.tags.clone(),
                sources,
                archive,
                supersede,
                unarchived,
            });
        }
        if archive_too_long {
            finish_run(
                &deps,
                &mut run,
                MEMORY_REDISTILL_SKIPPED,
                batch.len(),
                0,
                0,
                0,
                Some(cand.label()),
                Some(REASON_ARCHIVE_TOO_LONG),
                None,
                now_ms,
                out.usage.clone(),
            )
            .await;
            report.batches.push(BatchReport {
                fingerprint,
                scope: group.scope.clone(),
                status: MEMORY_REDISTILL_SKIPPED.to_string(),
                items_in: batch.len() as i64,
                items_out: 0,
                details: 0,
                drifted: 0,
                unarchived: 0,
                model: Some(cand.label()),
                reason: Some(REASON_ARCHIVE_TOO_LONG.to_string()),
                error: None,
            });
            break;
        }

        // ⑫ 落库（失败已回滚：来源一条不动）
        match apply_batch(&apply_deps, &group.scope, &to_apply, now_ms).await {
            Err(e) => {
                finish_run(
                    &deps,
                    &mut run,
                    MEMORY_REDISTILL_FAILED,
                    batch.len(),
                    0,
                    0,
                    0,
                    Some(cand.label()),
                    None,
                    Some(e.clone()),
                    now_ms,
                    out.usage.clone(),
                )
                .await;
                report.batches.push(BatchReport {
                    fingerprint,
                    scope: group.scope.clone(),
                    status: MEMORY_REDISTILL_FAILED.to_string(),
                    items_in: batch.len() as i64,
                    items_out: 0,
                    details: 0,
                    drifted: 0,
                    unarchived: 0,
                    model: Some(cand.label()),
                    reason: None,
                    error: Some(e),
                });
                break;
            }
            Ok(outcome) => {
                let degraded = outcome.unarchived > 0 || outcome.drifted > 0;
                let error = if outcome.unarchived > 0 {
                    Some(format!(
                        "{} 条来源的详情读不到，未停用它们（保持启用）",
                        outcome.unarchived
                    ))
                } else if outcome.drifted > 0 {
                    Some(format!(
                        "{} 条来源在整理期间被改动，未停用它们",
                        outcome.drifted
                    ))
                } else {
                    None
                };
                finish_run(
                    &deps,
                    &mut run,
                    if degraded {
                        MEMORY_REDISTILL_PARTIAL
                    } else {
                        MEMORY_REDISTILL_DONE
                    },
                    batch.len(),
                    outcome.new_ids.len(),
                    outcome.details,
                    outcome.drifted,
                    Some(cand.label()),
                    None,
                    error.clone(),
                    now_ms,
                    out.usage.clone(),
                )
                .await;
                // 顺带把 out_ids 落进 runs（为将来的「撤销本次整理」留口）
                let mut final_run = run.clone();
                final_run.out_ids = outcome.new_ids.clone();
                if let Err(e) = deps.memory.finish_redistill_run(&final_run).await {
                    eprintln!("[memory] 写入整理流水失败（不影响记忆本身）: {}", e);
                }
                report.items_in += batch.len();
                report.items_out += outcome.new_ids.len();
                report.batches.push(BatchReport {
                    fingerprint,
                    scope: group.scope.clone(),
                    status: final_run.status.clone(),
                    items_in: batch.len() as i64,
                    items_out: outcome.new_ids.len() as i64,
                    details: outcome.details as i64,
                    drifted: outcome.drifted as i64,
                    unarchived: outcome.unarchived as i64,
                    model: Some(cand.label()),
                    reason: None,
                    error,
                });
            }
        }
        calls += 1;
    }

    Ok(report)
}

// ==================== 流水落库 / 记账 / 调用 ====================

/// 清理流水：`fingerprint = "purge"` 的唯一一行 —— 它的 `finished_at` 就是「上次清理时间」。
async fn record_purge_run(
    deps: &RedistillDeps<'_>,
    now_ms: i64,
    outcome: &apply::PurgeOutcome,
) {
    let run = MemoryRedistillRun {
        fingerprint: MEMORY_REDISTILL_PURGE_FINGERPRINT.to_string(),
        status: MEMORY_REDISTILL_DONE.to_string(),
        purged: outcome.purged as i64,
        purged_failed: outcome.failed as i64,
        started_at: now_ms,
        finished_at: Some(now_ms),
        ..Default::default()
    };
    if let Err(e) = deps.memory.finish_redistill_run(&run).await {
        eprintln!("[memory] 写入清理流水失败（不影响清理本身）: {}", e);
    }
}

/// 落终态（不含 `out_ids`：它由落库路径单独补写）
#[allow(clippy::too_many_arguments)]
async fn finish_run(
    deps: &RedistillDeps<'_>,
    run: &mut MemoryRedistillRun,
    status: &str,
    items_in: usize,
    items_out: usize,
    details: usize,
    drifted: usize,
    model: Option<String>,
    reason: Option<&str>,
    error: Option<String>,
    now_ms: i64,
    usage: Option<TokenUsage>,
) {
    run.status = status.to_string();
    run.items_in = items_in as i64;
    run.items_out = items_out as i64;
    run.details = details as i64;
    run.drifted = drifted as i64;
    run.model = model;
    // 跳过原因与失败原因共用 `error` 列（面板 / CLI 只展示，不区分语义）
    run.error = reason.map(String::from).or(error);
    run.finished_at = Some(now_ms);
    run.prompt_tokens = usage.as_ref().map(|u| u.prompt_tokens);
    run.completion_tokens = usage.as_ref().map(|u| u.completion_tokens);
    if let Err(e) = deps.memory.finish_redistill_run(run).await {
        eprintln!("[memory] 写入整理流水失败（不影响记忆本身）: {}", e);
    }
}

/// 候选链的标签（报告里用；只报 `providerConfigId/modelId`，不带 key）
fn cand_label(cands: &[ModelCandidate]) -> Option<String> {
    cands.first().map(ModelCandidate::label)
}

/// 记账：`kind = 'memory'`，`message_id = memory:redistill:<fingerprint>`（幂等键）。
///
/// ⚠️ **不复用** [`crate::agent::usage::record_usage`]：它要求一个 `Session`，而整理是跨会话的
///（`session_id` 留空）。token 口径仍走 [`ledger_tokens`]（与聊天 / 压缩同一套）。
async fn record_usage(
    sessions: &dyn SessionRepo,
    fingerprint: &str,
    cand: &ModelCandidate,
    usage: Option<&TokenUsage>,
    duration_ms: i64,
) {
    let Some(usage) = usage else {
        return; // provider 没回报用量 → 不记账（与 title 同一取舍）
    };
    let tokens = ledger_tokens(usage, &cand.provider_type);
    let entry = UsageEntry {
        ts: None,
        session_id: None,
        message_id: Some(format!("{}{}", MEMORY_LEDGER_PREFIX, fingerprint)),
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
        duration_ms: Some(duration_ms).filter(|d| *d > 0),
        trace_id: None,
    };
    if let Err(e) = sessions.append_usage(&[entry]).await {
        eprintln!("[memory] 再蒸馏记账失败（不影响记忆本身）: {}", e);
    }
}

/// 一次模型调用的产物
struct CallOutput {
    drafts: Vec<plan::MergeDraft>,
    /// provider 未回报用量时为 `None`（不记账 —— 与 `title.rs` 同一取舍）
    usage: Option<TokenUsage>,
    duration_ms: i64,
}

/// 执行一次非流式调用（**不落库、不记账**）：失败一律 `Err`，由调用方换下一个候选。
async fn call_once(
    provider: &dyn Provider,
    model: &str,
    prompt: String,
    cancel: &CancellationToken,
) -> Result<CallOutput, String> {
    let request = build_request(model, prompt);
    let started = crate::telemetry::now_ms();
    let response = provider.chat(&request, cancel).await?;
    let duration_ms = crate::telemetry::now_ms() - started;
    let raw = match &response.content {
        Value::String(s) => s.clone(),
        other => content_text(other),
    };
    let drafts = parse_redistill_response(&raw)?;
    Ok(CallOutput {
        drafts,
        usage: response.usage,
        duration_ms,
    })
}

/// 请求形状：单条 user 消息（提示词自带全部规则）、非流式、不带工具、**关思考**
/// （产出是严格 JSON，思考只会把 `max_tokens` 吃在推理上 —— `title.rs` 踩过同一个坑）。
fn build_request(model: &str, prompt: String) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        messages: vec![Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: "user".to_string(),
            content: Value::String(prompt),
            timestamp: crate::telemetry::now_ms(),
            ..Default::default()
        }],
        system_prompt: None,
        tools: Vec::new(),
        temperature: MEMORY_REDISTILL_TEMPERATURE,
        // 中性值：`top_p` 与 `temperature` 不建议同时调（本模块只调 temperature）
        top_p: 1.0,
        max_tokens: MEMORY_REDISTILL_MAX_TOKENS,
        stream: false,
        tool_choice: "none".to_string(),
        reasoning_effort: None,
        thinking: Some(false),
    }
}

/// 读每条来源的详情（三态）。多读一次库不是「顺便」，而是为了两件事：
/// ① 归档预算（真实字符数 —— 详情正文也要进归档）；② 「有详情但读不到」→ 该来源**不许软删**。
async fn read_source_details(
    deps: &RedistillDeps<'_>,
    items: &[MemoryRecord],
) -> HashMap<String, SourceDetail> {
    let mut out: HashMap<String, SourceDetail> = HashMap::new();
    let Some(rag) = deps.rag else {
        return out;
    };
    for m in items {
        let state = match detail_link(m) {
            None => SourceDetail::Absent,
            Some((kb_id, doc_id)) => {
                match kb::read_detail(rag, kb_id.to_string(), doc_id.to_string()).await {
                    Ok(text) => SourceDetail::Text(text),
                    Err(e) => {
                        eprintln!(
                            "[memory] 读取记忆详情失败（该来源不会被停用）: {} ({})",
                            m.id, e
                        );
                        SourceDetail::Unreadable
                    }
                }
            }
        };
        out.insert(m.id.clone(), state);
    }
    out
}

/// 逃生开关的读取口径（缺键 / 类型不对 → 开）—— 与 [`run_at`] / [`sched::request`] 同一口径，
/// 单独导出是给契约测试与宿主判断用的。
pub fn redistill_enabled_from_settings(settings: &Map<String, Value>) -> bool {
    settings
        .get(MEMORY_REDISTILL_ENABLED_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::host::HostEnv;
    use crate::agent::memory::render_memory_section;
    use crate::agent::types::{ProviderConnection, StreamEvent};
    use crate::session_db::{open_session_db, SessionDb, MEMORY_ORIGIN_MODEL};
    use async_trait::async_trait;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const NOW: i64 = 1_700_000_100_000;

    /// 宿主桩：库放临时目录（`open_session_db` 是唯一的公开入口）
    struct TestHost(PathBuf);

    impl HostEnv for TestHost {
        fn resource_candidates(&self) -> Vec<PathBuf> {
            Vec::new()
        }
        fn data_dir(&self) -> PathBuf {
            self.0.clone()
        }
    }

    /// 测试用 RAG：本地 n-gram 嵌入 + 临时目录（不访问网络、不碰真数据目录）
    fn test_rag() -> &'static RagService {
        let dir = std::env::temp_dir().join(format!("virlen_redistill_rag_{}", uuid::Uuid::new_v4()));
        let provider = Arc::new(crate::rag::embedding::NgramEmbeddingProvider::new(512));
        Box::leak(Box::new(RagService::new(dir, provider).expect("建测试用 RAG")))
    }

    /// 模型桩：固定回复 + 调用计数（验「一轮只调一次 / 幂等后不再调」）
    struct StubProvider {
        reply: Value,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Provider for StubProvider {
        async fn chat(
            &self,
            _request: &ChatRequest,
            _cancel: &CancellationToken,
        ) -> Result<Message, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Message {
                id: "resp".into(),
                role: "assistant".into(),
                content: self.reply.clone(),
                usage: Some(TokenUsage {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120,
                    cached_tokens: None,
                    cache_write_tokens: None,
                }),
                timestamp: 0,
                ..Default::default()
            })
        }

        async fn chat_stream(
            &self,
            _request: &ChatRequest,
            _cancel: &CancellationToken,
            _on_event: &mut (dyn FnMut(StreamEvent) + Send),
        ) -> Result<(), String> {
            unreachable!("再蒸馏只走非流式 chat")
        }
    }

    struct StubBuilder {
        reply: String,
        calls: Arc<AtomicUsize>,
    }

    impl MemoryProviderBuilder for StubBuilder {
        fn build(&self, _conn: &ProviderConnection) -> Result<Box<dyn Provider>, String> {
            Ok(Box::new(StubProvider {
                reply: Value::String(self.reply.clone()),
                calls: self.calls.clone(),
            }))
        }
    }

    fn rec(id: &str, scope: Option<&str>, created_at: i64) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: "normal".into(),
            kind: "project".into(),
            summary: format!("记忆 {id}"),
            project_path: scope.map(String::from),
            origin: MEMORY_ORIGIN_MODEL.into(),
            created_at,
            updated_at: created_at,
            ..Default::default()
        }
    }

    async fn test_db(tag: &str) -> (SessionDb, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "virlen_redistill_{}_{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = open_session_db(&TestHost(dir.clone()), &|fut| {
            tokio::spawn(fut);
        })
        .expect("建库");
        (db, dir)
    }

    /// 让候选链有货：一个启用的 provider（否则整批 `no-model`）
    async fn seed_provider(db: &SessionDb) {
        let mut m = Map::new();
        m.insert(
            "providers".to_string(),
            serde_json::json!([{
                "id": "p1",
                "type": "openai",
                "name": "p1",
                "apiKey": "sk-x",
                "baseUrl": "https://example.com",
                "models": ["m1"],
                "enabled": true
            }]),
        );
        db.settings.upsert(m).await.unwrap();
    }

    /// 端到端：一批候选 → 合并成 1 条 → 条数下降、注入变短、原文可从新条目的归档里逐字读到、
    /// 来源只停用不删除。
    #[tokio::test]
    async fn end_to_end_merges_a_group_and_keeps_every_original() {
        let (db, dir) = test_db("e2e").await;
        seed_provider(&db).await;
        let memory = db.memory.as_ref();
        let rag = test_rag();

        // 10 条：6 条同作用域（够成组），4 条别的项目（不够成组，不该被动）
        for i in 0..6 {
            memory
                .upsert(&rec(&format!("m_a{i:03}"), None, 1_700_000_000_000 + i))
                .await
                .unwrap();
        }
        for i in 0..4 {
            memory
                .upsert(&rec(&format!("m_b{i:03}"), Some("C:/other"), 1_700_000_000_000 + i))
                .await
                .unwrap();
        }
        let before = render_memory_section(&memory.list(None, false).await.unwrap())
            .chars()
            .count();

        let calls = Arc::new(AtomicUsize::new(0));
        let builder = StubBuilder {
            reply: r#"{"groups":[{"source_ids":["m_a000","m_a001","m_a002"],"summary":"三条合并成的一条","kind":"project","tags":["merged"]}]}"#.to_string(),
            calls: calls.clone(),
        };
        let cancel = CancellationToken::new();
        let report = run_at(
            RedistillDeps {
                memory,
                sessions: db.repo.as_ref(),
                settings: db.settings.as_ref(),
                rag: Some(rag),
                builder: &builder,
                cancel: &cancel,
            },
            RedistillTask::Full,
            NOW,
            false,
        )
        .await
        .unwrap();

        assert_eq!(report.status, REPORT_OK);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "一轮一批一次调用");
        assert_eq!(report.items_out, 1);
        assert_eq!(report.calls, 1);
        let batch = &report.batches[0];
        assert_eq!(batch.status, MEMORY_REDISTILL_DONE);
        assert_eq!(batch.items_in, 6);
        assert_eq!(batch.drifted, 0);
        assert_eq!(batch.unarchived, 0);

        // ① 条数下降：10 - 3 + 1
        let live = memory.list(None, false).await.unwrap();
        assert_eq!(live.len(), 8);
        // ② 注入段变短
        let after = render_memory_section(&live).chars().count();
        assert!(after < before, "注入段必须变短：{after} < {before}");

        // ④ 来源：只停用、不删除，且指向新条目
        let new_rec = live
            .iter()
            .find(|m| m.origin == crate::session_db::MEMORY_ORIGIN_DISTILL)
            .cloned()
            .expect("有合并产出的新条目");
        assert_eq!(new_rec.summary, "三条合并成的一条");
        assert_eq!(new_rec.tags, vec!["merged".to_string()]);
        for id in ["m_a000", "m_a001", "m_a002"] {
            let m = memory.get(id).await.unwrap().unwrap();
            assert!(m.disabled, "{id} 应已停用");
            assert_eq!(m.superseded_by.as_deref(), Some(new_rec.id.as_str()));
        }
        for id in ["m_a003", "m_a004", "m_a005", "m_b000"] {
            let m = memory.get(id).await.unwrap().unwrap();
            assert!(!m.disabled, "{id} 没被合并，不该被动");
            assert!(m.superseded_by.is_none());
        }

        // ③ 归档详情：原文逐字可读（不丢信息的唯一凭据）
        let (kb_id, doc_id) = crate::agent::memory::detail_link(&new_rec).expect("新条目有归档详情");
        let text = kb::read_detail(rag, kb_id.to_string(), doc_id.to_string())
            .await
            .unwrap();
        assert!(text.contains("## 合并来源（自动归档）"), "{text}");
        for id in ["m_a000", "m_a001", "m_a002"] {
            assert!(text.contains(&format!("记忆 {id}")), "归档缺少 {id} 的原文");
        }

        // ⑤ 流水：指纹即幂等键，`out_ids` 为将来的「撤销本次整理」留口
        let run = memory
            .get_redistill_run(&batch.fingerprint)
            .await
            .unwrap()
            .expect("有流水");
        assert_eq!(run.status, MEMORY_REDISTILL_DONE);
        assert_eq!(run.scope, "");
        assert_eq!(run.out_ids, vec![new_rec.id.clone()]);
        assert_eq!(run.model.as_deref(), Some("p1/m1"));

        // 再跑一轮：同作用域只剩 3 条（< 5）→ 没有组可跑，不再调模型
        let builder2 = StubBuilder {
            reply: "{\"groups\":[]}".to_string(),
            calls: calls.clone(),
        };
        let report2 = run_at(
            RedistillDeps {
                memory,
                sessions: db.repo.as_ref(),
                settings: db.settings.as_ref(),
                rag: Some(rag),
                builder: &builder2,
                cancel: &cancel,
            },
            RedistillTask::Full,
            NOW + 60_000,
            false,
        )
        .await
        .unwrap();
        assert_eq!(report2.status, REPORT_NOTHING);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "没有组可跑就不该调模型");

        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 知识库不可用 → 整批 `skipped(no-rag)`：**不写任何条目、不停用任何来源**
    #[tokio::test]
    async fn no_rag_skips_the_whole_batch_without_touching_anything() {
        let (db, dir) = test_db("norag").await;
        seed_provider(&db).await;
        let memory = db.memory.as_ref();
        for i in 0..6 {
            memory
                .upsert(&rec(&format!("m_a{i:03}"), None, 1_700_000_000_000 + i))
                .await
                .unwrap();
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let builder = StubBuilder {
            reply: "{\"groups\":[]}".to_string(),
            calls: calls.clone(),
        };
        let cancel = CancellationToken::new();
        let report = run_at(
            RedistillDeps {
                memory,
                sessions: db.repo.as_ref(),
                settings: db.settings.as_ref(),
                rag: None,
                builder: &builder,
                cancel: &cancel,
            },
            RedistillTask::Full,
            NOW,
            false,
        )
        .await
        .unwrap();
        assert_eq!(report.batches.len(), 1);
        assert_eq!(report.batches[0].status, MEMORY_REDISTILL_SKIPPED);
        assert_eq!(report.batches[0].reason.as_deref(), Some(REASON_NO_RAG));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "不调模型");
        assert_eq!(memory.list(None, false).await.unwrap().len(), 6, "一条不动");
        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 归档清理：四条护栏逐条断言 —— 这是**唯一**会真正删记忆的自动路径。
    #[tokio::test]
    async fn purge_removes_only_archived_and_expired_with_a_live_target() {
        let (db, dir) = test_db("purge").await;
        let memory = db.memory.as_ref();
        let rag = test_rag();
        let retention = MEMORY_REDISTILL_ARCHIVE_RETENTION_MS;

        // 顶替者：有一条真的归档详情（④ 的前提）
        let kb_id = kb::ensure_memory_kb(db.settings.as_ref(), rag).await.unwrap();
        let doc_id = kb::store_detail(rag, kb_id.clone(), "记忆详情：归档".into(), "原文".into())
            .await
            .unwrap();
        let mut new_rec = rec("m_new", None, 1);
        new_rec.detail_kb_id = Some(kb_id.clone());
        new_rec.detail_doc_id = Some(doc_id.clone());
        memory.upsert(&new_rec).await.unwrap();

        let expired = NOW - retention - 1;
        // ⚠️ `superseded_by` **只能**由 `supersede` 写（upsert 刻意不碰它）—— 所以这里都走真路径：
        // 先落库，再把「停用时刻」定在想要的时刻（`supersede` 同时把 `updated_at` 写成它）
        async fn archive(
            memory: &dyn MemoryRepo,
            record: &MemoryRecord,
            new_id: &str,
            at_ms: i64,
        ) {
            memory.upsert(record).await.unwrap();
            let stored = memory.get(&record.id).await.unwrap().unwrap();
            let hit = memory
                .supersede(
                    &[(record.id.clone(), stored.updated_at, new_id.to_string())],
                    at_ms,
                )
                .await
                .unwrap();
            assert_eq!(hit, 1, "{} 应被停用", record.id);
        }

        // ① 合格候选：停用 + 有 superseded_by + 超期（还带一条自己的详情文档）
        let own_doc = kb::store_detail(
            rag,
            kb_id.clone(),
            "记忆详情：旧条目".into(),
            "旧条目自己的原文".into(),
        )
        .await
        .unwrap();
        let mut ok = rec("m_ok", None, 1);
        ok.detail_kb_id = Some(kb_id.clone());
        ok.detail_doc_id = Some(own_doc.clone());
        archive(memory, &ok, "m_new", expired).await;
        // ② 用户自己停用的（没有 superseded_by）→ 永不清理
        let manual = rec("m_manual", None, 1);
        memory.upsert(&manual).await.unwrap();
        assert!(memory.set_disabled("m_manual", true).await.unwrap());
        // ③ 没到保留期
        archive(memory, &rec("m_fresh", None, 1), "m_new", NOW - 1_000).await;
        // ④-a 指向的新条目已不存在 → 原文只可能在旧条目这儿，不删
        archive(memory, &rec("m_orphan", None, 1), "m_gone", expired).await;
        // ④-b 指向的新条目还在、但没有归档详情 → 同样不删
        memory.upsert(&rec("m_new_bare", None, 1)).await.unwrap();
        archive(memory, &rec("m_nodetail", None, 1), "m_new_bare", expired).await;

        let deps = ApplyDeps {
            memory,
            settings: db.settings.as_ref(),
            rag: Some(rag),
        };
        let purge = purge_archived(&deps, NOW, retention, 50).await;
        assert_eq!(purge.purged, 1);
        assert_eq!(purge.failed, 0);
        assert!(memory.get("m_ok").await.unwrap().is_none(), "合格的应被清掉");
        for keep in ["m_manual", "m_fresh", "m_orphan", "m_nodetail", "m_new"] {
            assert!(memory.get(keep).await.unwrap().is_some(), "{keep} 不该被清");
        }

        // 单轮上限：剩下的下轮再来（这里只验证计数语义）
        let purge_again = purge_archived(&deps, NOW, retention, 50).await;
        assert_eq!(purge_again.purged, 0, "幂等：清空了就再无可清");

        // RAG 不可用 → **一条都不删**（自动路径没人看着，不留孤儿详情文档）
        archive(memory, &rec("m_ok2", None, 1), "m_new", expired).await;
        let no_rag = ApplyDeps {
            memory,
            settings: db.settings.as_ref(),
            rag: None,
        };
        let purge_no_rag = purge_archived(&no_rag, NOW, retention, 50).await;
        assert_eq!(purge_no_rag.purged, 0);
        assert_eq!(
            purge_no_rag.failed, 3,
            "候选 3 条（m_ok2 + 两条被护栏保住的）——如实记下没删成，下一轮再来"
        );
        assert!(memory.get("m_ok2").await.unwrap().is_some());

        // 被清掉的条目：它自己的详情文档也一起删了（走与面板同一条 forget_memory）
        assert!(
            kb::read_detail(rag, kb_id.clone(), own_doc).await.is_err(),
            "被清理条目的详情文档必须一起删（否则留下永远不被引用的孤儿）"
        );
        assert!(
            kb::read_detail(rag, kb_id, doc_id).await.is_ok(),
            "顶替者的归档不受影响"
        );
        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }
}
