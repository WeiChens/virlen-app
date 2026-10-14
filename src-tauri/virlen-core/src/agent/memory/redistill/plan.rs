//! 记忆再蒸馏（P2′）—— **纯逻辑层**（零 I/O）
//!
//! 答的都是「判断题」：哪些条目能被合并、哪一批先跑、模型这条输出能不能接受、合并后是哪一级、
//! 归档正文长什么样、哪条归档该被清理。全部是**纯函数**（固定输入 → 固定输出），因此可以被逐字断言；
//! 取数 / 调模型 / 落库在 `apply.rs` 与 `mod.rs`（编排）。
//!
//! 三条口径（改这里前先读）：
//! - **只动 AI 产出的（`origin <> 'user'`）且未停用的**条目（[`is_redistill_candidate`]）；
//! - 合并**只在同一作用下**发生（[`group_candidates`]）—— 跨项目合并会让其中一方再也看不到这条记忆；
//! - 级别**只降不升**（[`level_for_sources`]）：普通合并出来还是普通，永久污染面最大，不靠模型决定。

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::agent::memory::redistill::{
    MEMORY_REDISTILL_COOLDOWN_MS, MEMORY_REDISTILL_FAIL_BACKOFF_MS, MEMORY_REDISTILL_MAX_ATTEMPTS,
    MEMORY_REDISTILL_MIN_GROUP_ITEMS, MEMORY_REDISTILL_MIN_RATIO,
    MEMORY_REDISTILL_MODEL_DETAIL_MIN_CHARS, MEMORY_REDISTILL_PURGE_MIN_INTERVAL_MS,
    MEMORY_REDISTILL_STALE_MS, MEMORY_REDISTILL_TRIGGER_COUNT,
};
use crate::agent::memory::{clamp_summary, is_valid_kind, memory_created_day, memory_score};
use crate::agent::memory::MEMORY_MAX_TAGS;
use crate::agent::prompts;
use crate::session_db::{
    MemoryRecord, MemoryRedistillRun, MEMORY_LEVEL_NORMAL, MEMORY_LEVEL_PERMANENT,
    MEMORY_ORIGIN_USER, MEMORY_REDISTILL_DONE, MEMORY_REDISTILL_FAILED, MEMORY_REDISTILL_PARTIAL,
    MEMORY_REDISTILL_RUNNING,
};

// ==================== 候选 / 分组 / 选组 / 切批 ====================

/// 这条记忆能不能被自动整理：**未停用**且**不是用户手写的**。
///
/// 用户手写的不动是硬约定（自动合并用户自己的记忆 = 「我的记忆被 AI 改了」）；
/// 停用的本来就不注入，再花力气合并它没有意义（用户显式关掉了它）。
pub fn is_redistill_candidate(m: &MemoryRecord) -> bool {
    !m.disabled && m.origin.trim() != MEMORY_ORIGIN_USER
}

/// 分组键：`project_path` 原样（空串 = 不限定项目）。
///
/// 不做路径归一化（不调 `scope::path_key`）：归一化只影响「两个写法是否同一处」的判断，
/// 而这里要的是「**原样**把作用域守恒地带到新条目上」—— 归一化反而会让新条目与来源的
/// `project_path` 字面不一致（注入侧的 `scope::applies` 自己会归一化比较）。
pub fn scope_key(m: &MemoryRecord) -> String {
    m.project_path
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// 一个项目作用域内的候选集合（`items` 已按「最该合并的在前」排序）
#[derive(Debug, Clone)]
pub struct ScopeGroup {
    /// 作用域原样（`''` = 不限定项目）
    pub scope: String,
    pub items: Vec<MemoryRecord>,
}

/// 按作用域分组，只留下条数够的组；**全序**（条数降序 → 组名升序），第一组就是本次要跑的那组。
///
/// 组内排序 = 「最该合并的在前」：分数升序（越少被用到越该合并）→ 旧的在前 → id 升序。
/// 顺序即优先级，[`pick_batch`] 直接截取前 N 条，不再重新排序。
pub fn group_candidates(items: &[MemoryRecord], now_ms: i64) -> Vec<ScopeGroup> {
    let mut buckets: BTreeMap<String, Vec<MemoryRecord>> = BTreeMap::new();
    for m in items.iter().filter(|m| is_redistill_candidate(m)) {
        buckets.entry(scope_key(m)).or_default().push(m.clone());
    }
    let mut groups: Vec<ScopeGroup> = buckets
        .into_iter()
        .filter(|(_, items)| items.len() >= MEMORY_REDISTILL_MIN_GROUP_ITEMS)
        .map(|(scope, mut items)| {
            items.sort_by(|a, b| {
                memory_score(a.hits, a.created_at, now_ms)
                    .cmp(&memory_score(b.hits, b.created_at, now_ms))
                    .then_with(|| a.created_at.cmp(&b.created_at))
                    .then_with(|| a.id.cmp(&b.id))
            });
            ScopeGroup { scope, items }
        })
        .collect();
    groups.sort_by(|a, b| {
        b.items.len()
            .cmp(&a.items.len())
            .then_with(|| a.scope.cmp(&b.scope))
    });
    groups
}

/// 切出一批（条数上限 + 输入预算双闸；谁先满谁截断）。`items` 的顺序即优先级。
pub fn pick_batch(
    items: &[MemoryRecord],
    max_items: usize,
    max_input_chars: usize,
) -> Vec<MemoryRecord> {
    let mut out: Vec<MemoryRecord> = Vec::new();
    let mut used = 0usize;
    for m in items {
        if out.len() >= max_items.max(1) {
            break;
        }
        let n = memory_line(m).chars().count() + 1;
        // 第一条无论如何都收（否则超预算的单条会让整批永远跑不起来）
        if !out.is_empty() && used + n > max_input_chars.max(1) {
            break;
        }
        used += n;
        out.push(m.clone());
    }
    out
}

// ==================== 提示词组装 ====================

/// 提示词里的一条记忆行：`- (id: m_xxx) [kind] (2026-09-30) 正文`
///
/// ⚠️ **必须带 id**：模型的唯一凭据是 `source_ids`，没有 id 的输入就无从溯源，
/// 而「引用一个不存在的 id」是本方案里最危险的模型输出（校验层会整条丢）。
pub fn memory_line(m: &MemoryRecord) -> String {
    let day = memory_created_day(m.created_at);
    let date = if day.is_empty() {
        String::new()
    } else {
        format!(" ({})", day)
    };
    format!("- (id: {}) [{}]{} {}", m.id, m.kind, date, m.summary.trim())
}

/// 本批全部记忆的列表文本
pub fn render_memories_block(items: &[MemoryRecord]) -> String {
    items
        .iter()
        .map(memory_line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// 作用域的展示文本（不限定项目时说清是「全局」，模型才不会硬塞一个项目名进来）
pub fn scope_label(scope: &str) -> String {
    let s = scope.trim();
    if s.is_empty() {
        "(global — these memories are not tied to any project)".to_string()
    } else {
        s.to_string()
    }
}

/// 组装提示词。替换顺序固定为 `scope → max_items → memories`：
/// 记忆正文是用户内容，**最后**替换它才不会让正文里出现的 `{{scope}}` 字样被当模板再替换一次。
pub fn build_prompt(scope: &str, max_items: usize, items: &[MemoryRecord]) -> String {
    prompts::MEMORY_REDISTILL
        .replace("{{scope}}", &scope_label(scope))
        .replace("{{max_items}}", &max_items.to_string())
        .replace("{{memories}}", &render_memories_block(items))
}

// ==================== 幂等键：批次指纹 ====================

/// FNV-1a 64 位（确定性、无外部依赖；用它只为「同一批内容得到同一个键」）
pub fn fnv1a64(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in input.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 批次指纹 = `fnv1a64(scope + 每条 "id:updated_at")`，16 位十六进制。
///
/// ⚠️ **排序无关**：候选先按 id 排序再拼 —— 同一批内容无论以什么顺序取出来（组内排序、批大小变化），
/// 指纹都一样，`AlreadyDone` 才拦得住重复整理；而 `updated_at` 进指纹，让「期间被改过的条目」
/// 自然形成新的一批（该重跑）。
pub fn batch_fingerprint(scope: &str, items: &[MemoryRecord]) -> String {
    let mut keys: Vec<String> = items
        .iter()
        .map(|m| format!("{}:{}", m.id, m.updated_at))
        .collect();
    keys.sort();
    format!(
        "{:016x}",
        fnv1a64(&format!("{}\n{}", scope.trim(), keys.join(",")))
    )
}

// ==================== 输出校验（绝不猜 / 不新增 / 不重叠） ====================

/// 模型给的一条合并（解析产物，**未经校验**）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeDraft {
    pub source_ids: Vec<String>,
    pub summary: String,
    pub kind: String,
    pub tags: Vec<String>,
    /// 模型给的合并后说明（可选；只进归档正文的最前面）
    pub detail: Option<String>,
}

/// 校验通过的一条合并（作用域 / 级别 / 来源已由我们定死）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergePlan {
    /// 来源 id（按输入顺序，去重后 ≥ [`MEMORY_REDISTILL_MIN_RATIO`] 条）
    pub sources: Vec<String>,
    pub summary: String,
    pub kind: String,
    pub level: String,
    pub tags: Vec<String>,
    pub detail: Option<String>,
}

/// 校验结果（丢弃计数进日志 / 埋点，便于回答「模型这次为什么不干活」）
#[derive(Debug, Clone, Default)]
pub struct ValidatedPlans {
    pub plans: Vec<MergePlan>,
    /// 因越界 / 重叠 / 正文为空 / 压缩比不足被丢的条数
    pub dropped: usize,
    /// 因超出本批输出上限被丢的条数
    pub dropped_over_limit: usize,
}

/// 逐项校验（§4.4）。任一条不过只丢**那一条**；`source_ids` 与已接受项重叠的一律丢后者 ——
/// 一条记忆不能同时被两条新条目「继承」（否则回滚语义含糊）。
pub fn validate_drafts(
    drafts: &[MergeDraft],
    input: &[MemoryRecord],
    max_items: usize,
) -> ValidatedPlans {
    let by_id: HashMap<&str, &MemoryRecord> = input.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut used: HashSet<&str> = HashSet::new();
    let mut out = ValidatedPlans::default();

    for d in drafts {
        if out.plans.len() >= max_items.max(1) {
            out.dropped_over_limit += 1;
            continue;
        }
        let mut ids: Vec<&str> = Vec::new();
        let mut valid = true;
        for raw in &d.source_ids {
            let id = raw.trim();
            if id.is_empty() {
                continue;
            }
            // 越界（不在本批输入里）/ 重叠（别的新条目已认领）/ 重复引用 → 整条作废
            if !by_id.contains_key(id) || used.contains(id) || ids.contains(&id) {
                valid = false;
                break;
            }
            ids.push(id);
        }
        let summary = clamp_summary(&d.summary);
        if !valid || ids.len() < MEMORY_REDISTILL_MIN_RATIO || summary.is_empty() {
            out.dropped += 1;
            continue;
        }
        let sources: Vec<&MemoryRecord> = ids.iter().filter_map(|id| by_id.get(id).copied()).collect();
        let level = level_for_sources(&sources);
        for id in &ids {
            used.insert(id);
        }
        out.plans.push(MergePlan {
            sources: ids.iter().map(|s| (*s).to_string()).collect(),
            summary,
            kind: normalize_kind(&d.kind),
            level,
            tags: normalize_tags(&d.tags),
            detail: d
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from),
        });
    }
    out
}

/// 分类收敛：未知值 → `fact`（分类只是标签，错一个不值得丢整条记忆）
fn normalize_kind(kind: &str) -> String {
    let k = kind.trim();
    if is_valid_kind(k) {
        k.to_string()
    } else {
        "fact".to_string()
    }
}

/// 标签收敛：去空白 / 去重 / 截前 [`MEMORY_MAX_TAGS`] 个
fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if t.is_empty() || out.iter().any(|x| x == t) {
            continue;
        }
        out.push(t.to_string());
        if out.len() >= MEMORY_MAX_TAGS {
            break;
        }
    }
    out
}

/// 合并后的级别：来源**全是**永久 → 永久，否则普通。
///
/// ⚠️ **永不升级**：永久记忆是全量注入所有会话，污染面最大；普通来源合并出永久 = 凭空扩大影响面。
/// 模型一侧根本不输出 `level`（提示词里没有这个字段），这条推导是唯一的级别来源。
pub fn level_for_sources(sources: &[&MemoryRecord]) -> String {
    if !sources.is_empty() && sources.iter().all(|m| m.level == MEMORY_LEVEL_PERMANENT) {
        MEMORY_LEVEL_PERMANENT.to_string()
    } else {
        MEMORY_LEVEL_NORMAL.to_string()
    }
}

// ==================== 归档正文（不丢信息的唯一凭据） ====================

/// 归档正文里来源段的固定标题（`render_archive` 与 `fit_archive_budget` **共用一份**：
/// 漏算它的长度，「刚好装满」的批次就会超出一个标题的长度）
const ARCHIVE_SOURCES_HEADER: &str = "## 合并来源（自动归档）";

/// 归档正文里的一一条来源
#[derive(Debug, Clone)]
pub struct ArchiveEntry {
    pub record: MemoryRecord,
    /// 该来源自己的详情正文（`None` = 本来没有详情，或读不到 —— 后者由编排层用 `unarchived` 区分）
    pub detail: Option<String>,
}

/// 渲染一条来源的归档片段
fn render_entry(record: &MemoryRecord, detail: Option<&str>) -> String {
    let day = memory_created_day(record.created_at);
    let head = if day.is_empty() {
        format!("### {} · {}", record.id, record.kind)
    } else {
        format!("### {} · {} · {}", record.id, record.kind, day)
    };
    let mut out = format!("{}\n{}", head, record.summary.trim());
    if let Some(d) = detail.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("\n\n");
        out.push_str(d);
    }
    out
}

/// 一条来源在归档正文里占的字符数（含与下一条之间的空行）—— 切批时按它算预算
pub fn archive_entry_chars(record: &MemoryRecord, detail_chars: usize) -> usize {
    let placeholder = "x".repeat(detail_chars);
    let detail = if detail_chars > 0 {
        Some(placeholder.as_str())
    } else {
        None
    };
    render_entry(record, detail).chars().count() + 2
}

/// 归档正文。**由我们生成**（不靠模型）：模型给的 `detail` 放最前面（它更好读），
/// 逐条来源的原文跟在后面（它是保真的底）。
///
/// ⚠️ 预算冲突时**保来源**：模型那段只在「来源都装下之后剩下的空间」里截取，
/// 短于 [`MEMORY_REDISTILL_MODEL_DETAIL_MIN_CHARS`] 就整段丢掉（半截总结比没有更误导）。
pub fn render_archive(model_detail: Option<&str>, entries: &[ArchiveEntry], budget: usize) -> String {
    let sources_text = entries
        .iter()
        .map(|e| render_entry(&e.record, e.detail.as_deref()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let header = ARCHIVE_SOURCES_HEADER;
    let sources_cost = header.chars().count() + 1 + sources_text.chars().count();
    // 两段之间要留的空行 + 模型那段的标题
    let model_header = "## 合并后的完整说明\n";
    let remaining = budget
        .saturating_sub(sources_cost)
        .saturating_sub(model_header.chars().count() + 2);

    let mut out = String::new();
    if let Some(d) = model_detail.map(str::trim).filter(|s| !s.is_empty()) {
        // 看的是**剩余空间**而不是文本长度：剩余够就整段收（模型写得短不该被丢），
        // 剩余不够就一个字不留（半截总结比没有更误导）
        if remaining >= MEMORY_REDISTILL_MODEL_DETAIL_MIN_CHARS {
            let taken: String = d.chars().take(remaining).collect();
            out.push_str(model_header);
            out.push_str(taken.trim_end());
            out.push_str("\n\n");
        }
    }
    out.push_str(header);
    out.push('\n');
    out.push_str(&sources_text);
    out
}

/// 按归档预算收敛一批候选（§4.2 的第二条预算）。
#[derive(Debug, Clone, Default)]
pub struct FitOutcome {
    /// 保留在本批的候选（顺序不变）
    pub kept: Vec<MemoryRecord>,
    /// 因**单条来源详情过长**被移出本次候选的 id（保持启用；日志记 `source-detail-too-long`）
    pub too_long: Vec<String>,
    /// 因预算装不下而留给下一轮（超预算点之后的全部）
    pub deferred: Vec<String>,
}

/// 归档预算是**硬账**：装不下就不能软删该来源（D2 定了 30 天后要真删，归档是唯一凭据）。
/// 所以这里宁可本批小一点，也不让「部分来源没进归档」。
pub fn fit_archive_budget(
    items: &[MemoryRecord],
    detail_chars: &HashMap<String, usize>,
    budget: usize,
    max_source_detail: usize,
) -> FitOutcome {
    let mut out = FitOutcome::default();
    // ① 先剔除「单条详情过长」的 —— 它是**永久**移出本次候选（不是留给下一轮），
    //    因此必须在预算判断之外做：否则「预算先满就 break」会让它后面的巨无霸漏判。
    let eligible: Vec<&MemoryRecord> = items
        .iter()
        .filter(|m| {
            let n = detail_chars.get(&m.id).copied().unwrap_or(0);
            if n > max_source_detail {
                out.too_long.push(m.id.clone());
                false
            } else {
                true
            }
        })
        .collect();

    // ② 再按预算装（固定头部先占位，见 [`ARCHIVE_SOURCES_HEADER`]）
    let mut used = ARCHIVE_SOURCES_HEADER.chars().count() + 1;
    for (idx, m) in eligible.iter().enumerate() {
        let detail_len = detail_chars.get(&m.id).copied().unwrap_or(0);
        let n = archive_entry_chars(m, detail_len);
        if !out.kept.is_empty() && used + n > budget {
            out.deferred
                .extend(eligible[idx..].iter().map(|x| x.id.clone()));
            break;
        }
        used += n;
        out.kept.push((*m).clone());
    }
    out
}

// ==================== 归档清理（GC） ====================

/// 归档清理候选的**纯逻辑部分**（§4.8 的前三条；第四条「新条目仍在且有归档详情」要查库）。
///
/// 三条缺一不可：①已停用 ②有 `superseded_by`（= 我们顶替的，不是用户自己停用的）
/// ③距 `supersede` 那一刻已超过保留期（`updated_at` 由 `supersede` 写成 now）。
pub fn is_purge_candidate(m: &MemoryRecord, now_ms: i64, retention_ms: i64) -> bool {
    if !m.disabled || m.updated_at <= 0 {
        return false;
    }
    let superseded = m
        .superseded_by
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    superseded && now_ms.saturating_sub(m.updated_at) >= retention_ms.max(0)
}

// ==================== 触发判定（闸门第 ④ 步） ====================

/// 该不该跑、跑哪一种（纯逻辑；调用方只负责取数）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// 什么都不做
    None,
    /// 先清理、再合并
    Full,
    /// 只清理（清理不与阈值绑定：条数掉到阈值以下也要继续清，否则归档条目永久堆积）
    PurgeOnly,
}

/// 闸门判定：条数越线且值得合并 → `Full`；否则只要还有超期归档且距上次清理够久 → `PurgeOnly`。
pub fn decide_trigger(
    now_ms: i64,
    candidates: i64,
    purge_candidates: i64,
    has_group: bool,
    last_run: Option<&MemoryRedistillRun>,
    last_purge_at: Option<i64>,
) -> Trigger {
    if candidates >= MEMORY_REDISTILL_TRIGGER_COUNT as i64
        && has_group
        && cooldown_ok(last_run, now_ms)
    {
        return Trigger::Full;
    }
    let purge_due = last_purge_at.is_none_or(|t| {
        now_ms.saturating_sub(t) >= MEMORY_REDISTILL_PURGE_MIN_INTERVAL_MS
    });
    if purge_candidates > 0 && purge_due {
        return Trigger::PurgeOnly;
    }
    Trigger::None
}

/// 冷却 / 退避（§3.4）：上一轮 `done` / `partial` 距 30 分钟，`failed` 距离 6 小时且尝试未耗尽。
///
/// 尝试耗尽的指纹**不再自动重试**（等人工 `--force`）：「模型就是不吐合法 JSON」这类问题
/// 不该无限花钱。
fn cooldown_ok(last: Option<&MemoryRedistillRun>, now_ms: i64) -> bool {
    let Some(run) = last else {
        return true;
    };
    let finished = run.finished_at.unwrap_or(run.started_at);
    let elapsed = now_ms.saturating_sub(finished);
    match run.status.as_str() {
        MEMORY_REDISTILL_DONE | MEMORY_REDISTILL_PARTIAL => elapsed >= MEMORY_REDISTILL_COOLDOWN_MS,
        MEMORY_REDISTILL_FAILED => {
            run.attempts < MEMORY_REDISTILL_MAX_ATTEMPTS
                && elapsed >= MEMORY_REDISTILL_FAIL_BACKOFF_MS
        }
        // 崩溃残留：只有老化到阈值才可被抢占（否则两个窗口会同时跑）
        MEMORY_REDISTILL_RUNNING => elapsed >= MEMORY_REDISTILL_STALE_MS,
        // 未知状态按「刚跑过」处理（宁可少跑一次，也不要重复整理）
        _ => elapsed >= MEMORY_REDISTILL_COOLDOWN_MS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::memory::redistill::{
        MEMORY_REDISTILL_ARCHIVE_RETENTION_MS, MEMORY_REDISTILL_BATCH_MAX_ITEMS,
        MEMORY_REDISTILL_MAX_INPUT_CHARS, MEMORY_REDISTILL_MAX_OUT_ITEMS,
    };
    use crate::agent::memory::{MEMORY_DETAIL_MAX_CHARS, MEMORY_SUMMARY_MAX_CHARS};
    use crate::session_db::{MEMORY_KIND_PROJECT, MEMORY_ORIGIN_DISTILL};

    const NOW: i64 = 1_700_000_000_000;

    fn mem(id: &str, scope: Option<&str>, created_at: i64) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: MEMORY_LEVEL_NORMAL.into(),
            kind: MEMORY_KIND_PROJECT.into(),
            summary: format!("记忆 {}", id),
            project_path: scope.map(String::from),
            origin: MEMORY_ORIGIN_DISTILL.into(),
            created_at,
            updated_at: created_at,
            ..Default::default()
        }
    }

    // ── 候选 ──

    #[test]
    fn only_ai_written_and_enabled_entries_are_candidates() {
        assert!(is_redistill_candidate(&mem("a", None, 1)));
        let mut user = mem("u", None, 1);
        user.origin = "user".into();
        assert!(!is_redistill_candidate(&user), "用户手写的记忆不参与合并");
        let mut off = mem("d", None, 1);
        off.disabled = true;
        assert!(!is_redistill_candidate(&off), "停用的不参与（用户显式关掉了）");
    }

    // ── 分组 / 选组 ──

    #[test]
    fn groups_never_mix_scopes_and_need_min_items() {
        let mut items: Vec<MemoryRecord> = (0..5).map(|i| mem(&format!("a{i}"), Some("C:/p1"), 10 + i)).collect();
        // 只有 4 条：不成组
        items.extend((0..4).map(|i| mem(&format!("b{i}"), Some("C:/p2"), 10 + i)));
        // 不限定项目：5 条，成组
        items.extend((0..5).map(|i| mem(&format!("c{i}"), None, 10 + i)));
        let mut user = mem("u1", Some("C:/p1"), 5);
        user.origin = "user".into();
        items.push(user);

        let groups = group_candidates(&items, NOW);
        assert_eq!(groups.len(), 2, "只有两组够 5 条");
        assert_eq!(groups[0].items.len(), 5);
        assert_eq!(groups[0].scope, "", "条数并列时组名升序：空串在前");
        assert_eq!(groups[1].scope, "C:/p1");
        assert!(groups.iter().all(|g| g.items.iter().all(|m| m.id != "u1")));
    }

    #[test]
    fn groups_are_ordered_by_size_then_scope_and_batches_keep_priority() {
        let mut items: Vec<MemoryRecord> = (0..6).map(|i| mem(&format!("bb{i}"), Some("C:/b"), 10 + i)).collect();
        items.extend((0..7).map(|i| mem(&format!("aa{i}"), Some("C:/a"), 10 + i)));
        let groups = group_candidates(&items, NOW);
        assert_eq!(groups[0].scope, "C:/a", "条数多的组优先");
        assert_eq!(groups[0].items.len(), 7);

        // 组内：分数升序（hits 少的在前）；同分按旧的在前
        let mut hot = mem("hot", Some("C:/a"), 100);
        hot.hits = 9;
        let mut same_group: Vec<MemoryRecord> = groups[0].items.clone();
        same_group.push(hot);
        let groups = group_candidates(&same_group, NOW);
        let ids: Vec<&str> = groups[0].items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids.last().copied(), Some("hot"), "命中最多的排最后（最后才合并它）");
        assert_eq!(ids[0], "aa0", "同分时旧的在前");
    }

    #[test]
    fn batch_is_capped_by_items_and_input_budget() {
        let items: Vec<MemoryRecord> = (0..60)
            .map(|i| mem(&format!("m{:03}", i), None, 10 + i))
            .collect();
        let batch = pick_batch(&items, MEMORY_REDISTILL_BATCH_MAX_ITEMS, MEMORY_REDISTILL_MAX_INPUT_CHARS);
        assert_eq!(batch.len(), MEMORY_REDISTILL_BATCH_MAX_ITEMS, "条数闸先生效");

        // 即使每条都写满硬上限（150 字符 ≈ 169 字符/行），40 条也只有 ~6.8 k ——
        // 输入预算（24 k）是**防意外的安全阀**（将来调大条数上限时它才生效），不是当前的主要闸门
        let long: Vec<MemoryRecord> = (0..60)
            .map(|i| {
                let mut m = mem(&format!("m{:03}", i), None, 10 + i);
                m.summary = "字".repeat(MEMORY_SUMMARY_MAX_CHARS);
                m
            })
            .collect();
        assert_eq!(
            pick_batch(&long, MEMORY_REDISTILL_BATCH_MAX_ITEMS, MEMORY_REDISTILL_MAX_INPUT_CHARS).len(),
            MEMORY_REDISTILL_BATCH_MAX_ITEMS,
            "满额正文也还装得下 40 条（余量 2.6×）"
        );
        // 预算闸本身有效：给一个装不下 40 条的预算
        let tight = pick_batch(&long, MEMORY_REDISTILL_BATCH_MAX_ITEMS, 500);
        assert!(tight.len() < MEMORY_REDISTILL_BATCH_MAX_ITEMS && !tight.is_empty(), "实际：{}", tight.len());
        assert!(pick_batch(&long, MEMORY_REDISTILL_BATCH_MAX_ITEMS, 1).len() == 1, "第一条无论如何都收");
    }

    // ── 指纹 ──

    #[test]
    fn fingerprint_is_order_independent_but_tracks_updates() {
        let a = vec![mem("m1", None, 1), mem("m2", None, 2)];
        let mut b = a.clone();
        b.reverse();
        assert_eq!(
            batch_fingerprint("", &a),
            batch_fingerprint("", &b),
            "同一批内容换顺序必须同指纹（幂等键）"
        );
        assert_ne!(batch_fingerprint("", &a), batch_fingerprint("C:/p1", &a), "作用域进指纹");
        assert_ne!(
            batch_fingerprint("", &a),
            batch_fingerprint("", &[a[0].clone(), mem("m3", None, 3)]),
            "换了成员必须换指纹"
        );

        let mut edited = a.clone();
        edited[0].updated_at = 99;
        assert_ne!(batch_fingerprint("", &a), batch_fingerprint("", &edited), "改过的条目重跑");

        assert_eq!(batch_fingerprint("", &a).len(), 16, "定长十六进制");
    }

    #[test]
    fn fnv1a64_matches_the_reference_vectors() {
        assert_eq!(fnv1a64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64("a"), 0xaf63_dc4c_8601_ec8c);
    }

    // ── 校验 ──

    fn draft(ids: &[&str], summary: &str) -> MergeDraft {
        MergeDraft {
            source_ids: ids.iter().map(|s| (*s).to_string()).collect(),
            summary: summary.to_string(),
            kind: "project".into(),
            tags: Vec::new(),
            detail: None,
        }
    }

    #[test]
    fn validate_rejects_out_of_range_overlap_and_thin_ratio() {
        let input = vec![mem("m1", None, 1), mem("m2", None, 2), mem("m3", None, 3)];
        let out = validate_drafts(
            &[
                draft(&["m1", "m9"], "越界：引用了不存在的 id"),
                draft(&["m2"], "只有 1 个来源，压缩比 1:1"),
                draft(&["m3", "m3"], "重复引用同一条"),
                draft(&["m1", "m2"], "合法的"),
            ],
            &input,
            MEMORY_REDISTILL_MAX_OUT_ITEMS,
        );
        assert_eq!(out.dropped, 3);
        assert_eq!(out.plans.len(), 1);
        assert_eq!(out.plans[0].sources, vec!["m1", "m2"]);
    }

    #[test]
    fn validate_rejects_overlapping_second_claim() {
        let input = vec![mem("m1", None, 1), mem("m2", None, 2), mem("m3", None, 3)];
        let out = validate_drafts(
            &[
                draft(&["m1", "m2"], "先来先得"),
                draft(&["m2", "m3"], "m2 已被认领 → 整条丢"),
            ],
            &input,
            MEMORY_REDISTILL_MAX_OUT_ITEMS,
        );
        assert_eq!(out.plans.len(), 1);
        assert_eq!(out.plans[0].sources, vec!["m1", "m2"]);
        assert_eq!(out.dropped, 1, "一条记忆不能同时被两条新条目继承");
    }

    #[test]
    fn validate_drops_empty_summary_and_caps_output_count() {
        let input: Vec<MemoryRecord> = (0..8).map(|i| mem(&format!("m{}", i), None, i)).collect();
        // 1 条空正文 + 6 条单来源（一源一条 = 没合并）→ 全丢
        let mut drafts = vec![draft(&["m0", "m1"], "   ")];
        drafts.extend((2..8).map(|i| draft(&[&format!("m{}", i)], "太薄")));
        let out = validate_drafts(&drafts, &input, 2);
        assert_eq!(out.dropped, 7, "空正文 1 条 + 压缩比不足 6 条");
        assert_eq!(out.plans.len(), 0);
        assert_eq!(out.dropped_over_limit, 0, "上限还没轮到它们");

        // 上限：3 条合格输出、上限 2 → 第 3 条按出现顺序丢
        let input: Vec<MemoryRecord> = (0..6).map(|i| mem(&format!("m{}", i), None, i)).collect();
        let out = validate_drafts(
            &[
                draft(&["m0", "m1"], "a"),
                draft(&["m2", "m3"], "b"),
                draft(&["m4", "m5"], "c"),
            ],
            &input,
            2,
        );
        assert_eq!(out.plans.len(), 2);
        assert_eq!(out.dropped_over_limit, 1);
    }

    #[test]
    fn validate_normalizes_kind_tags_and_truncates_summary() {
        let input = vec![mem("m1", None, 1), mem("m2", None, 2)];
        let mut d = draft(&["m1", "m2"], &"字".repeat(MEMORY_SUMMARY_MAX_CHARS + 10));
        d.kind = "不知道".into();
        d.tags = vec![" a ".into(), "".into(), "a".into(), "b".into(), "c".into(), "d".into()];
        d.detail = Some("   ".into());
        let out = validate_drafts(&[d], &input, MEMORY_REDISTILL_MAX_OUT_ITEMS);
        let plan = &out.plans[0];
        assert_eq!(plan.kind, "fact", "未知分类收敛为 fact");
        assert_eq!(plan.tags, vec!["a", "b", "c"], "去空白 / 去重 / 截前 3 个");
        assert_eq!(plan.summary.chars().count(), MEMORY_SUMMARY_MAX_CHARS + 1);
        assert!(plan.detail.is_none(), "纯空白的 detail 当没给");
    }

    #[test]
    fn level_is_derived_and_never_upgraded() {
        let mut perm = mem("p1", None, 1);
        perm.level = MEMORY_LEVEL_PERMANENT.into();
        let mut perm2 = mem("p2", None, 2);
        perm2.level = MEMORY_LEVEL_PERMANENT.into();
        let normal = mem("n1", None, 3);
        let normal2 = mem("n2", None, 4);

        let input = vec![perm, perm2, normal, normal2];
        let out = validate_drafts(
            &[
                draft(&["p1", "p2"], "全永久来源 → 永久"),
                draft(&["n1", "n2"], "全普通来源 → 普通"),
            ],
            &input,
            MEMORY_REDISTILL_MAX_OUT_ITEMS,
        );
        assert_eq!(out.plans.len(), 2);
        assert_eq!(out.plans[0].level, MEMORY_LEVEL_PERMANENT);
        assert_eq!(out.plans[1].level, MEMORY_LEVEL_NORMAL, "永不升级");

        // 混了普通来源 → 降为普通（一条普通混进来就不该全量注入）
        let mut perm3 = mem("p3", None, 5);
        perm3.level = MEMORY_LEVEL_PERMANENT.into();
        let mut perm4 = mem("p4", None, 6);
        perm4.level = MEMORY_LEVEL_PERMANENT.into();
        let mixed = vec![perm3, perm4, mem("n3", None, 7)];
        let out = validate_drafts(&[draft(&["p3", "n3"], "混来源")], &mixed, 5);
        assert_eq!(out.plans[0].level, MEMORY_LEVEL_NORMAL);
    }

    // ── 提示词 ──

    #[test]
    fn prompt_carries_ids_scope_and_renders_lines() {
        let items = vec![mem("m_abc", Some("C:/work/app"), 1_700_000_000_000)];
        let prompt = build_prompt("C:/work/app", 20, &items);
        assert!(!prompt.contains("{{scope}}"));
        assert!(!prompt.contains("{{max_items}}"));
        assert!(!prompt.contains("{{memories}}"));
        assert!(prompt.contains("C:/work/app"));
        assert!(prompt.contains("20"));
        assert!(prompt.contains("- (id: m_abc) [project] ("));
        assert!(prompt.contains("记忆 m_abc"));

        // 不限定项目时说清楚（模型才不会硬塞一个项目名进来）
        let global = build_prompt("", 20, &items);
        assert!(global.contains("global"));

        // 正文里的 `{{scope}}` 字样不得被再次替换（提示词注入面）
        let mut tricky = mem("m_x", None, 1);
        tricky.summary = "用户提到 {{scope}} 这个占位符".into();
        let out = build_prompt("C:/work/app", 5, &[tricky]);
        assert!(out.contains("用户提到 {{scope}} 这个占位符"), "{out}");
    }

    #[test]
    fn memory_line_omits_date_when_created_at_is_missing() {
        let line = memory_line(&mem("m1", None, 0));
        assert_eq!(line, "- (id: m1) [project] 记忆 m1");
    }

    // ── 归档 ──

    #[test]
    fn archive_keeps_every_source_verbatim_and_puts_model_text_first() {
        let mut a = mem("m1", Some("C:/p"), 1_700_000_000_000);
        a.kind = "decision".into();
        a.summary = "会话导出改为 HTML 单文件".into();
        let mut b = mem("m2", Some("C:/p"), 1_700_100_000_000);
        b.summary = "导出省略工具调用 = 连工具结果一起省".into();

        let entries = vec![
            ArchiveEntry { record: a.clone(), detail: Some("详情的正文一段".into()) },
            ArchiveEntry { record: b.clone(), detail: None },
        ];
        let out = render_archive(Some("合并后的完整说明"), &entries, MEMORY_DETAIL_MAX_CHARS);
        assert!(out.starts_with("## 合并后的完整说明\n合并后的完整说明"));
        assert!(out.contains("## 合并来源（自动归档）"));
        assert!(out.contains("### m1 · decision · "));
        assert!(out.contains("会话导出改为 HTML 单文件"));
        assert!(out.contains("详情的正文一段"), "来源自己的详情必须一起归档（否则原文真丢）");
        assert!(out.contains("### m2 · project · "));
        assert!(out.contains("导出省略工具调用 = 连工具结果一起省"));
        assert!(out.chars().count() <= MEMORY_DETAIL_MAX_CHARS);
    }

    #[test]
    fn archive_never_lets_the_model_text_push_out_sources() {
        let mut a = mem("m1", None, 1);
        a.summary = "字".repeat(200);
        let entries = vec![ArchiveEntry { record: a, detail: None }];
        // 预算刚好只够来源（+10 字符余量）→ 模型那段装不下，整段丢弃
        let entry_cost = archive_entry_chars(&entries[0].record, 0);
        let tight = ARCHIVE_SOURCES_HEADER.chars().count() + 1 + entry_cost;
        let out = render_archive(Some(&"墨".repeat(8_000)), &entries, tight);
        assert!(out.chars().count() <= tight, "总长越界：{}", out.chars().count());
        assert!(out.contains(&"字".repeat(200)), "来源原文必须在");
        assert!(!out.contains("合并后的完整说明"), "模型那段被预算挤掉时整段丢弃");

        // 完全不给模型 detail：只有归档段
        let plain = render_archive(None, &entries, MEMORY_DETAIL_MAX_CHARS);
        assert!(plain.starts_with("## 合并来源（自动归档）"));
    }

    #[test]
    fn archive_entry_chars_tracks_detail_length() {
        let m = mem("m1", None, 1);
        let base = archive_entry_chars(&m, 0);
        assert_eq!(archive_entry_chars(&m, 500), base + 502, "详情长 500 → 多 500 + 两个换行");
    }

    #[test]
    fn fit_archive_budget_keeps_what_fits_and_moves_out_giants() {
        let items: Vec<MemoryRecord> = (0..5)
            .map(|i| {
                let mut m = mem(&format!("m{}", i), None, i);
                m.summary = "字".repeat(100);
                m
            })
            .collect();
        let mut lens = HashMap::new();
        lens.insert("m3".to_string(), 9_000); // 巨无霸：单项就超上限

        // 预算 300：单条片段 ≈ 122 → 只装得下 2 条，其余留给下一轮
        let single = fit_archive_budget(&items[3..4], &lens, 300, 4_000);
        assert_eq!(
            single.too_long,
            vec!["m3".to_string()],
            "单条也要能识别 too_long（lens={:?}）",
            lens
        );
        let fit = fit_archive_budget(&items, &lens, 300, 4_000);
        assert_eq!(
            fit.too_long,
            vec!["m3".to_string()],
            "ids={:?} lens={:?}",
            items.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
            lens
        );
        assert!(fit.kept.iter().all(|m| m.id != "m3"));
        assert_eq!(fit.kept.len(), 2, "实际：{}", fit.kept.len());
        assert!(!fit.deferred.is_empty(), "装不下的留给下一轮");

        // 预算足够 → 全部保留（除了那一条巨无霸）
        let fit = fit_archive_budget(&items, &HashMap::new(), 8_000, 4_000);
        assert_eq!(fit.kept.len(), 5);
        assert!(fit.deferred.is_empty());
    }

    // ── 清理 ──

    #[test]
    fn purge_needs_all_three_conditions() {
        let mut m = mem("m1", None, 1);
        m.updated_at = NOW - MEMORY_REDISTILL_ARCHIVE_RETENTION_MS - 1;
        m.disabled = true;
        m.superseded_by = Some("m_new".into());
        assert!(is_purge_candidate(&m, NOW, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS));

        // ① 没停用
        let mut enabled = m.clone();
        enabled.disabled = false;
        assert!(!is_purge_candidate(&enabled, NOW, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS));
        // ② 用户自己停用的（没有 superseded_by）—— 永不清理
        let mut manual = m.clone();
        manual.superseded_by = None;
        assert!(!is_purge_candidate(&manual, NOW, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS));
        let mut blank = m.clone();
        blank.superseded_by = Some("   ".into());
        assert!(!is_purge_candidate(&blank, NOW, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS));
        // ③ 没到保留期
        let mut fresh = m.clone();
        fresh.updated_at = NOW - 1000;
        assert!(!is_purge_candidate(&fresh, NOW, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS));
        // 无效时间戳（老数据）不清理
        let mut zero = m.clone();
        zero.updated_at = 0;
        assert!(!is_purge_candidate(&zero, NOW, MEMORY_REDISTILL_ARCHIVE_RETENTION_MS));
    }

    // ── 触发 / 冷却 ──

    fn run(status: &str, attempts: i64, finished_at: i64) -> MemoryRedistillRun {
        MemoryRedistillRun {
            fingerprint: "f".into(),
            status: status.into(),
            attempts,
            started_at: finished_at - 1,
            finished_at: Some(finished_at),
            ..Default::default()
        }
    }

    #[test]
    fn trigger_needs_count_threshold_and_a_group() {
        let many = MEMORY_REDISTILL_TRIGGER_COUNT as i64;
        assert_eq!(decide_trigger(NOW, many, 0, true, None, None), Trigger::Full);
        assert_eq!(
            decide_trigger(NOW, many, 0, false, None, None),
            Trigger::None,
            "没有值得合并的组：别白跑一次调用"
        );
        assert_eq!(
            decide_trigger(NOW, many - 1, 0, true, None, None),
            Trigger::None,
            "条数没到线"
        );
    }

    #[test]
    fn trigger_falls_back_to_purge_when_count_is_low() {
        assert_eq!(decide_trigger(NOW, 3, 5, false, None, None), Trigger::PurgeOnly);
        // 距上次清理 < 24h → 不重复清
        assert_eq!(
            decide_trigger(NOW, 3, 5, false, None, Some(NOW - 1000)),
            Trigger::None
        );
        // 没有超期归档 → 什么都不做
        assert_eq!(decide_trigger(NOW, 3, 0, false, None, None), Trigger::None);
        // 条数越线但冷却未到 → 退化成「只清理」（有超期归档时）
        assert_eq!(
            decide_trigger(NOW, MEMORY_REDISTILL_TRIGGER_COUNT as i64, 2, true, Some(&run(MEMORY_REDISTILL_DONE, 1, NOW - 1000)), None),
            Trigger::PurgeOnly
        );
    }

    #[test]
    fn cooldown_follows_status_and_attempts() {
        let many = MEMORY_REDISTILL_TRIGGER_COUNT as i64;
        let done_just_now = run(MEMORY_REDISTILL_DONE, 1, NOW - 1_000);
        assert_eq!(
            decide_trigger(NOW, many, 0, true, Some(&done_just_now), None),
            Trigger::None,
            "刚跑完 30 分钟内不再跑"
        );
        let done_long_ago = run(MEMORY_REDISTILL_DONE, 1, NOW - MEMORY_REDISTILL_COOLDOWN_MS - 1);
        assert_eq!(
            decide_trigger(NOW, many, 0, true, Some(&done_long_ago), None),
            Trigger::Full
        );

        // 失败：6 小时内退避
        let failed = run(MEMORY_REDISTILL_FAILED, 1, NOW - 1_000);
        assert_eq!(decide_trigger(NOW, many, 0, true, Some(&failed), None), Trigger::None);
        let failed_old = run(MEMORY_REDISTILL_FAILED, 1, NOW - MEMORY_REDISTILL_FAIL_BACKOFF_MS - 1);
        assert_eq!(decide_trigger(NOW, many, 0, true, Some(&failed_old), None), Trigger::Full);

        // 尝试耗尽：等人工
        let exhausted = run(MEMORY_REDISTILL_FAILED, MEMORY_REDISTILL_MAX_ATTEMPTS, NOW - MEMORY_REDISTILL_FAIL_BACKOFF_MS * 10);
        assert_eq!(
            decide_trigger(NOW, many, 0, true, Some(&exhausted), None),
            Trigger::None,
            "同一指纹不再自动重试"
        );

        // 崩溃残留：老化后可抢占
        let stale = run(MEMORY_REDISTILL_RUNNING, 1, NOW - MEMORY_REDISTILL_STALE_MS - 1);
        assert_eq!(decide_trigger(NOW, many, 0, true, Some(&stale), None), Trigger::Full);
        let fresh_running = run(MEMORY_REDISTILL_RUNNING, 1, NOW - 1_000);
        assert_eq!(decide_trigger(NOW, many, 0, true, Some(&fresh_running), None), Trigger::None);
    }
}
