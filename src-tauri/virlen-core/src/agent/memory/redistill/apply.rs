//! 再蒸馏的**落库 / 归档 / 停用 / 回滚 / 清理**（唯一会改库的一层）
//!
//! 三条口径（改这里前先读）：
//! - **先写后停用**：新条目（含归档详情）**全部写成功**才停用来源；任一步失败就**回滚**已写的新条目
//!   （连同详情文档一起删），来源一条不动 —— 宁可下次再来，不留半截状态；
//! - **没有归档就不许停用**：归档正文是「原文可回滚」的唯一凭据，而 D2 定了 30 天后要基于它硬删，
//!   所以某条来源的详情读不到时**不软删它**（计 `unarchived`，整批判 `partial`）；
//! - **清理走同一条删除路径**：与面板删除共用 `agent::memory::store::forget_memory`
//!   （条目 + 它自己的详情文档一起删），四条护栏缺一不删（方案 §4.8）。

use std::collections::HashMap;

use crate::agent::memory::redistill::plan::is_purge_candidate;
use crate::agent::memory::{kb, store, MEMORY_SUMMARY_MAX_CHARS};
use crate::rag::rag_service::RagService;
use crate::session_db::{MemoryRecord, MemoryRepo, SettingsRepo, MEMORY_ORIGIN_DISTILL};

/// 一条来源的详情状态（三态！`Absent` 与 `Unreadable` 的区别决定「能不能软删它」）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceDetail {
    /// 本来就没有详情（摘要即全文）→ 可以归档、可以软删
    Absent,
    /// 读到了详情正文
    Text(String),
    /// **有详情链接但读不到**（文档被用户在知识库页删了 / RAG 报错）→ 不软删该来源
    Unreadable,
}

impl SourceDetail {
    /// 归档正文里这段占多少字符（`Unreadable` / `Absent` 只留摘要）
    pub fn chars(&self) -> usize {
        match self {
            SourceDetail::Text(t) => t.chars().count(),
            _ => 0,
        }
    }

    pub fn text(&self) -> Option<&str> {
        match self {
            SourceDetail::Text(t) => Some(t.as_str()),
            _ => None,
        }
    }

    /// 该来源能不能被软删（原文是否已经进了归档）
    pub fn archivable(&self) -> bool {
        !matches!(self, SourceDetail::Unreadable)
    }
}

/// 落库所需依赖
pub struct ApplyDeps<'a> {
    pub memory: &'a dyn MemoryRepo,
    pub settings: &'a dyn SettingsRepo,
    /// 知识库句柄：`None` = 不可用 —— 合并落库由调用方在这时提前 skip（`no-rag`），
    /// 清理则**跳过删除**（删了条目会留下永远不被引用的孤儿详情文档）
    pub rag: Option<&'static RagService>,
}

/// 一条待落库的合并（归档正文已渲染、来源清单已定）
#[derive(Debug, Clone)]
pub struct PlanToApply {
    pub summary: String,
    pub kind: String,
    pub level: String,
    pub tags: Vec<String>,
    /// 来源记录（按输入顺序；字段映射与 CAS 期望值都取自它）
    pub sources: Vec<MemoryRecord>,
    /// 归档正文（已按 [`crate::agent::memory::MEMORY_DETAIL_MAX_CHARS`] 预算渲染）
    pub archive: String,
    /// 要 CAS 停用的来源 id（= `sources` 去掉「详情读不到」的那些）
    pub supersede: Vec<String>,
    /// 因详情读不到而**保持启用**的来源数（整批判 `partial` 的依据）
    pub unarchived: usize,
}

/// 一批落库的结果
#[derive(Debug, Clone, Default)]
pub struct ApplyOutcome {
    /// 本次写出的新条目 id
    pub new_ids: Vec<String>,
    /// 成功落了归档详情的条数
    pub details: usize,
    /// CAS 未命中的来源数（期间被 AI / 用户改过 → 保持启用）
    pub drifted: usize,
    /// 因详情读不到而未停用的来源数
    pub unarchived: usize,
}

/// 落库一批（含失败回滚）。返回 `Err` = 整批未生效（新条目已回滚，来源一条不动）。
pub async fn apply_batch(
    deps: &ApplyDeps<'_>,
    scope: &str,
    plans: &[PlanToApply],
    now_ms: i64,
) -> Result<ApplyOutcome, String> {
    let Some(rag) = deps.rag else {
        // 调用方本应在 RAG 不可用时提前 skip；这里 fail-closed，绝不写「没有归档的合并」
        return Err("知识库不可用：本轮不合并（没有归档就不许停用来源）".to_string());
    };

    let mut outcome = ApplyOutcome::default();
    // ── ① 先写新条目（含归档详情）────────────────────────────────
    for p in plans {
        let id = deps.memory.new_id().await;
        match write_one(deps, rag, &id, scope, p, now_ms).await {
            Ok(has_detail) => {
                if has_detail {
                    outcome.details += 1;
                }
                outcome.new_ids.push(id);
            }
            Err(e) => {
                // ── 回滚：删掉本次已写的新条目（连同详情文档），来源一条不动 ──
                rollback(deps, rag, &outcome.new_ids).await;
                return Err(format!("写入新记忆失败，已回滚本批：{}", e));
            }
        }
    }

    // ── ② 全部写成功 → CAS 停用来源 ─────────────────────────────
    for (idx, p) in plans.iter().enumerate() {
        let new_id = outcome.new_ids[idx].clone();
        let expected: HashMap<&str, i64> =
            p.sources.iter().map(|m| (m.id.as_str(), m.updated_at)).collect();
        let pairs: Vec<(String, i64, String)> = p
            .supersede
            .iter()
            .map(|sid| {
                (
                    sid.clone(),
                    expected.get(sid.as_str()).copied().unwrap_or(0),
                    new_id.clone(),
                )
            })
            .collect();
        if pairs.is_empty() {
            continue;
        }
        let hit = deps.memory.supersede(&pairs, now_ms).await?;
        outcome.drifted += pairs.len().saturating_sub(hit);
        outcome.unarchived += p.unarchived;
    }
    Ok(outcome)
}

/// 写一条新条目 + 它的归档详情。返回「是否真的落了详情」。
async fn write_one(
    deps: &ApplyDeps<'_>,
    rag: &'static RagService,
    id: &str,
    scope: &str,
    p: &PlanToApply,
    now_ms: i64,
) -> Result<bool, String> {
    // 归档详情：文档名带上「合并 N 条」，用户在知识库里一眼看出它是怎么来的
    let kb_id = kb::ensure_memory_kb(deps.settings, rag).await?;
    let doc_name = format!(
        "{}（合并 {} 条）",
        kb::detail_doc_name(&p.summary),
        p.sources.len()
    );
    let doc_id = kb::store_detail(rag, kb_id.clone(), doc_name, p.archive.clone()).await?;

    let record = MemoryRecord {
        id: id.to_string(),
        level: p.level.clone(),
        kind: p.kind.clone(),
        summary: p.summary.chars().take(MEMORY_SUMMARY_MAX_CHARS).collect(),
        project_path: match scope.trim() {
            "" => None,
            s => Some(s.to_string()),
        },
        detail_kb_id: Some(kb_id),
        detail_doc_id: Some(doc_id),
        tags: p.tags.clone(),
        source_day: p
            .sources
            .iter()
            .map(|m| m.source_day.trim().to_string())
            .max()
            .unwrap_or_default(),
        source_session_id: p
            .sources
            .iter()
            .filter_map(|m| m.source_session_id.clone())
            .min(),
        // 语义 = 蒸馏产出（沿用既有取值：CLI 已把它当「蒸馏」标记显示，前端零改动）
        origin: MEMORY_ORIGIN_DISTILL.to_string(),
        // 热度不丢：合并后的条目接着参与 top-k 排序
        hits: p.sources.iter().map(|m| m.hits).sum(),
        last_used_at: p.sources.iter().map(|m| m.last_used_at).max().unwrap_or(0),
        created_at: now_ms,
        updated_at: now_ms,
        disabled: false,
        // 它是顶替别人的那个，不是被顶替的
        superseded_by: None,
    };
    deps.memory.upsert(&record).await?;
    Ok(true)
}

/// 回滚：删掉已写的新条目（连带归档详情文档）。失败只打日志 —— 残留条目下次触发时是普通候选，
/// 不会污染（但必须如实记下来，因为用户可能看到一条没人认领的新记忆）。
async fn rollback(deps: &ApplyDeps<'_>, rag: &'static RagService, ids: &[String]) {
    for id in ids {
        if let Err(e) = store::forget_memory(deps.memory, Some(rag), id).await {
            eprintln!("[memory] 回滚新记忆失败（它会作为普通候选留在库里）: {} ({})", id, e);
        }
    }
}

// ==================== 归档清理（GC，§4.8） ====================

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PurgeOutcome {
    pub purged: usize,
    pub failed: usize,
}

/// 归档清理：**唯一**会真正删记忆的自动路径，因此四条护栏缺一不删。
///
/// ①②③ 是纯逻辑（[`is_purge_candidate`]）；④ **它指向的新条目仍然存在，且仍有归档详情** ——
/// 被顶替条目的原文只存在于新条目的归档里，新条目被删掉之后旧条目就是**唯一**的载体，
/// 这时清理等于把内容彻底抹掉。
pub async fn purge_archived(
    deps: &ApplyDeps<'_>,
    now_ms: i64,
    retention_ms: i64,
    limit: usize,
) -> PurgeOutcome {
    let mut out = PurgeOutcome::default();
    let all = match deps.memory.list(None, true).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[memory] 读取记忆失败，本轮不清理归档: {}", e);
            return out;
        }
    };
    let candidates: Vec<MemoryRecord> = all
        .into_iter()
        .filter(|m| is_purge_candidate(m, now_ms, retention_ms))
        .take(limit.max(1))
        .collect();
    if candidates.is_empty() {
        return out;
    }
    // 没有知识库就**不删**：删了条目会留下永远不被引用的孤儿详情文档（这是自动路径，没人看着）
    let Some(rag) = deps.rag else {
        eprintln!(
            "[memory] 知识库不可用，本轮跳过归档清理（{} 条待清理）",
            candidates.len()
        );
        out.failed = candidates.len();
        return out;
    };

    for m in candidates {
        let Some(new_id) = m
            .superseded_by
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
        else {
            continue; // 已由 `is_purge_candidate` 保证；双保险
        };
        // ④ 新条目仍在 且 仍有归档详情 —— 否则旧条目的原文只在自己这儿，不能删
        match deps.memory.get(&new_id).await {
            Ok(Some(new_rec)) if new_rec.detail_doc_id.is_some() => {}
            Ok(_) => {
                eprintln!(
                    "[memory] 保留归档条目 {}：它指向的新条目 {} 已不存在或没有归档详情",
                    m.id, new_id
                );
                continue;
            }
            Err(e) => {
                eprintln!("[memory] 查询归档条目的新条目失败（本轮不删）: {} ({})", m.id, e);
                out.failed += 1;
                continue;
            }
        }
        match store::forget_memory(deps.memory, Some(rag), &m.id).await {
            Ok(f) if f.removed => {
                out.purged += 1;
                if f.detail_removed == Some(false) {
                    // 条目确实没了，但详情文档没删掉（孤儿）—— 如实计数，别假装删干净了
                    out.failed += 1;
                }
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("[memory] 清理归档条目失败（下一轮再来）: {} ({})", m.id, e);
                out.failed += 1;
            }
        }
    }
    out
}
