//! 记忆三工具 / 三命令的**共享实现**（原生工具与 GUI 命令走同一份逻辑）
//!
//! `memory_search` / `memory_recall` / `memory_write` 的语义定义在这里：
//! - 原生工具（`agent/native_tools/memory/*.rs`）从 `NativeToolCtx` 取依赖，把结果转成 `NativeToolOutcome`；
//! - GUI 命令（`cmd_memory_search` / `cmd_memory_recall` / `cmd_memory_write`）把同一份结果序列化给前端。
//!
//! 两边共用不是「省几行」，而是**防分叉**：语义一旦各写一份（比如一边拒绝非法 `level`、另一边静默改默认值），
//! 提示词里承诺的行为与实测行为就会长期不一致，而两边各自的测试都不会失败。
//!
//! 文案口径（与全仓一致）：`content` 给模型看 → **固定英文**；`ui_data` 给界面看 → 结构化字段，
//! 由 UI 组件按界面语言重建。

use crate::agent::memory::dedupe::{self, WriteDecision};
use crate::agent::memory::kb;
use crate::agent::memory::scope::{self, scope_for_write};
use crate::agent::memory::{
    clamp_summary, is_valid_kind, is_valid_level, MEMORY_KINDS, MEMORY_LEVEL_NORMAL,
    MEMORY_SUMMARY_HINT_CHARS, MEMORY_SUMMARY_MAX_CHARS,
};
use crate::rag::rag_service::RagService;
use crate::session_db::{MemoryRecord, MemoryRepo, SettingsRepo, MEMORY_LEVEL_PERMANENT};
use serde::Serialize;
use serde_json::{json, Value};

/// 检索默认 / 最大条数（模型一次能看的条目有限：给多了反而挑不出来）
pub const MEMORY_SEARCH_DEFAULT_LIMIT: usize = 5;
pub const MEMORY_SEARCH_MAX_LIMIT: usize = 20;

/// 存储不可用时的统一回话 —— 与 `chat` 分类工具同款口径：
/// 如实说「没有本地存储」，而不是把「查不到」伪装成「没有记忆」。
pub const MEMORY_UNAVAILABLE: &str =
    "Long-term memory is unavailable in this environment (local storage is not accessible).";

/// 原生工具与 GUI 命令共用的结果（命令直接把它序列化给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryToolOutput {
    /// 给模型看的英文文本
    pub content: String,
    /// 给界面看的结构化字段（按界面语言重建文案）
    pub ui_data: Value,
}

/// 执行一次记忆操作所需的依赖（显式注入：与 `NativeToolCtx` 同风格）
pub struct MemoryToolDeps<'a> {
    pub repo: &'a dyn MemoryRepo,
    /// 详情知识库的 kb_id 缓存读写要用它（`agent::memory::kb`）
    pub settings: &'a dyn SettingsRepo,
    /// RAG 服务未初始化时为 `None` → 详情不可读写，**不影响**记忆条目本身
    pub rag: Option<&'static RagService>,
    /// 来源会话（写入时记进 `source_session_id`，便于溯源）
    pub session_id: &'a str,
    /// 当前会话的**工作目录**（已解析：会话指定 > Agent 默认）。
    ///
    /// 两个用途：
    /// 1. 写 `kind = project` 的记忆时作为它的项目路径（见 `scope::scope_for_write`）；
    /// 2. 检索时筛掉属于**别的项目**的记忆（与注入同一规则，见 `scope::memory_applies`）。
    ///
    ///    空串 = 没有工作目录 → 项目记忆一概不写路径 / 不检索到。
    pub workspace: &'a str,
    pub now_ms: i64,
}

// ==================== memory_search ====================

/// `memory_search`：关键词检索（FTS5 trigram，短查询回退 LIKE）。
///
/// 命中即 `touch`（`hits += 1` / `last_used_at`）—— 与「被注入」共用同一个热度信号，
/// top-k / 排序都吃它；写失败只打日志（统计不该让检索失败）。
pub async fn run_search(
    deps: &MemoryToolDeps<'_>,
    query: &str,
    level: Option<&str>,
    kind: Option<&str>,
    limit: Option<i64>,
) -> Result<MemoryToolOutput, String> {
    if !deps.repo.is_available() {
        return Ok(unavailable("search"));
    }
    let query = query.trim();
    if query.is_empty() {
        return Ok(missing_param("query", "a keyword or phrase to search your memories"));
    }
    let level = normalize_opt(level);
    if let Some(l) = level {
        if !is_valid_level(l) {
            return Ok(invalid_param("level", l, "normal, permanent"));
        }
    }
    let kind = normalize_opt(kind);
    if let Some(k) = kind {
        if !is_valid_kind(k) {
            return Ok(invalid_param("kind", k, &MEMORY_KINDS.join(", ")));
        }
    }
    let limit = limit
        .unwrap_or(MEMORY_SEARCH_DEFAULT_LIMIT as i64)
        .clamp(1, MEMORY_SEARCH_MAX_LIMIT as i64) as usize;

    // 一次取满上限（本地 SQLite、20 行，开销可忽略）：作用域过滤在 Rust 侧做，
    // 若只取 `limit` 条再筛，别的项目的高热记忆会先把名额占完 —— 本项目明明有命中却报「没搜到」。
    let fetched = deps
        .repo
        .search(query, level, kind, MEMORY_SEARCH_MAX_LIMIT.max(limit))
        .await?;
    // 被作用域藏起来的条数（如实报出去：错报「没记过」比多一句说明危险得多）
    let mut hidden_by_scope = 0usize;
    let found: Vec<MemoryRecord> = fetched
        .into_iter()
        .filter(|m| {
            if scope::memory_applies(m, deps.workspace) {
                true
            } else {
                hidden_by_scope += 1;
                false
            }
        })
        .take(limit)
        .collect();
    if found.is_empty() {
        let mut content = format!("No memories found for \"{}\".", query);
        if let Some(note) = scope_note(hidden_by_scope) {
            content.push('\n');
            content.push_str(&note);
        }
        return Ok(MemoryToolOutput {
            content,
            ui_data: json!({
                "mode": "search",
                "query": query,
                "count": 0,
                "hiddenByScope": hidden_by_scope,
                "items": [],
            }),
        });
    }

    let ids: Vec<String> = found.iter().map(|m| m.id.clone()).collect();
    if let Err(e) = deps.repo.touch(&ids, deps.now_ms).await {
        eprintln!("[memory] 记录检索命中失败（只丢统计）: {}", e);
    }

    let mut lines = vec![format!("Found {} memories for \"{}\":", found.len(), query)];
    for m in &found {
        lines.push(format_memory_line(m));
    }
    if let Some(note) = scope_note(hidden_by_scope) {
        lines.push(String::new());
        lines.push(note);
    }
    lines.push(String::new());
    lines.push(
        "Entries showing an id also have a stored detail: read it with `memory_recall <id>`."
            .to_string(),
    );

    Ok(MemoryToolOutput {
        content: lines.join("\n"),
        ui_data: json!({
            "mode": "search",
            "query": query,
            "count": found.len(),
            "hiddenByScope": hidden_by_scope,
            "items": found.iter().map(memory_ui_item).collect::<Vec<_>>(),
        }),
    })
}

/// 「有多少条命中因项目作用域被藏起来」的说明行（没有就不加）。
///
/// 为什么一定要说：不说的话，模型（和看它回话的用户）会得出「没记过」这个**错误结论**
/// —— 记忆确实存在，只是属于另一个项目。
fn scope_note(hidden: usize) -> Option<String> {
    if hidden == 0 {
        return None;
    }
    Some(format!(
        "Note: {} more match(es) belong to other projects and are hidden in this workspace.",
        hidden
    ))
}

// ==================== memory_recall ====================

/// `memory_recall`：按 id 取一条记忆 —— 有详情链接就取详情正文，没有就**如实说「摘要即全文」**。
///
/// 显式指名（模型已知道 id）时**允许**读被停用的条目，但会在正文前注明它已停用 ——
/// 否则「明明记得有这条、却说没有」会诱导模型编造。
pub async fn run_recall(deps: &MemoryToolDeps<'_>, memory_id: &str) -> Result<MemoryToolOutput, String> {
    if !deps.repo.is_available() {
        return Ok(unavailable("recall"));
    }
    let memory_id = memory_id.trim();
    if memory_id.is_empty() {
        return Ok(missing_param("memory_id", "an id from the memory context block or memory_search"));
    }
    let Some(record) = deps.repo.get(memory_id).await? else {
        return Ok(MemoryToolOutput {
            content: format!(
                "No memory found with id \"{}\". Use memory_search to find the right id.",
                memory_id
            ),
            ui_data: json!({ "mode": "recall", "memoryId": memory_id, "found": false }),
        });
    };

    let link = detail_link(&record);
    let has_detail = link.is_some();
    let (body, detail_read) = match (link, deps.rag) {
        (Some((kb_id, doc_id)), Some(rag)) => match kb::read_detail(rag, kb_id, doc_id).await {
            Ok(text) => (
                format!(
                    "Detail of memory {} (kind: {}, level: {}):\n\n{}",
                    record.id, record.kind, record.level, text
                ),
                true,
            ),
            Err(e) => (
                format!(
                    "Memory {} has a stored detail, but it could not be read ({}). Its summary is:\n\n{}",
                    record.id, e, record.summary
                ),
                false,
            ),
        },
        (Some(_), None) => (
            format!(
                "Memory {} has a stored detail, but the knowledge base is unavailable in this environment. Its summary is:\n\n{}",
                record.id, record.summary
            ),
            false,
        ),
        (None, _) => (
            format!(
                "Memory {} has no stored detail — the summary is the whole content:\n\n{}",
                record.id, record.summary
            ),
            false,
        ),
    };
    let content = if record.disabled {
        format!("(This memory is disabled in the memory panel and is not injected into new sessions.)\n\n{}", body)
    } else {
        body
    };

    if let Err(e) = deps
        .repo
        .touch(std::slice::from_ref(&record.id), deps.now_ms)
        .await
    {
        eprintln!("[memory] 记录召回失败（只丢统计）: {}", e);
    }

    Ok(MemoryToolOutput {
        ui_data: json!({
            "mode": "recall",
            "memoryId": record.id,
            "found": true,
            "level": record.level,
            "kind": record.kind,
            "hasDetail": has_detail,
            "detailRead": detail_read,
            "chars": content.chars().count(),
        }),
        content,
    })
}

// ==================== memory_write ====================

/// `memory_write` 的入参
pub struct WriteRequest<'a> {
    pub summary: &'a str,
    /// `user` | `project` | `decision` | `fact`（非法值直接拒绝，让模型自己改）
    pub kind: &'a str,
    /// `normal`（默认）| `permanent`
    pub level: Option<&'a str>,
    /// 非空 → 详情正文落专用知识库，条目只留 `kb_id` / `doc_id`
    pub detail: Option<&'a str>,
}

/// `memory_write`：写入一条记忆（用户当场说「记住这个」时）。
///
/// - 正文：先按 [`MEMORY_SUMMARY_MAX_CHARS`] 截断（提示词要求 ≤ [`MEMORY_SUMMARY_HINT_CHARS`]）；
/// - **写入前查重**（[`crate::agent::memory::dedupe`]）：同作用域里逐字相同的句子不再新建条目，
///   只把新信息（级别升级 / 详情正文）并到旧条目上；「同一句被改写」则新建条目并把旧条目
///   归档成**改前版**（`disabled + superseded_by`，仍可 `memory_recall`，过了归档保留期才由清理删）——
///   这是「同一事实只留一份生效版本」的落地，否则「用 pnpm」与「改用 npm」会同时在库里
///   按分数抢排名，等于抛硬币；
/// - `kind = project` 时**自动**带上当前会话的工作目录作为项目路径（模型不必（也不该）自己猜路径）：
///   这条记忆之后只在该项目（或其子目录）里注入与召回；
/// - `detail` 非空 → 详情落知识库；**落库失败不牵连记忆条目**（返回里说明「只存了摘要」）；
/// - `level` 可给 `permanent`（已定稿：不设二次确认门，用户可以事后在面板降级 / 停用 / 删除）。
///
/// ⚠️ 与**永久记忆**几乎相同的写法不会被普通写入静默顶替（[`WriteDecision::KeepPermanent`]）：
/// 永久记忆是用户钉住的，让模型自行覆盖等于绕开用户授权。
pub async fn run_write(
    deps: &MemoryToolDeps<'_>,
    req: WriteRequest<'_>,
) -> Result<MemoryToolOutput, String> {
    if !deps.repo.is_available() {
        return Ok(unavailable("write"));
    }
    let raw_len = req.summary.trim().chars().count();
    let summary = clamp_summary(req.summary);
    if summary.is_empty() {
        return Ok(missing_param("summary", "the fact, preference or decision to remember"));
    }
    let kind = req.kind.trim();
    if !is_valid_kind(kind) {
        return Ok(invalid_param("kind", kind, &MEMORY_KINDS.join(", ")));
    }
    let level = normalize_opt(req.level);
    if let Some(l) = level {
        if !is_valid_level(l) {
            return Ok(invalid_param("level", l, "normal, permanent"));
        }
    }
    let level = level.unwrap_or(MEMORY_LEVEL_NORMAL);
    let detail = req.detail.unwrap_or("").trim();
    // 项目作用域：只有 project 才带，且以**当前工作目录**为值（模型看不到别的项目路径）
    let project_path = scope_for_write(kind, deps.workspace);

    // ① 写入前查重：只跟**同一作用域**的启用条目比（别的项目 / 已归档的都不参与）
    let candidates = match deps
        .repo
        .active_in_scope(
            project_path.as_deref(),
            dedupe::MEMORY_DEDUPE_MAX_CANDIDATES,
        )
        .await
    {
        Ok(list) => list,
        Err(e) => {
            // 查重是**增强**：读不到候选不该让「用户当场让记的事」写不进去
            eprintln!("[memory] 读取查重候选失败（本次不查重）: {}", e);
            Vec::new()
        }
    };
    let decision = dedupe::classify(&dedupe::WriteFacts { summary: &summary, level }, &candidates);

    // ② 逐字重复：不新建条目（同一条记忆说三遍不该占三份预算）
    if let WriteDecision::Duplicate { existing } = &decision {
        return Ok(merge_into_existing(deps, existing, level, detail, raw_len).await);
    }

    // ③ 其余分支（Add / Supersede / KeepPermanent）都要先落一条新条目
    let mut record = MemoryRecord {
        // id 由仓储发（生成 + 查一遍主键），短 id 撞车时不会覆盖别人
        id: deps.repo.new_id().await,
        level: level.to_string(),
        kind: kind.to_string(),
        summary: summary.clone(),
        project_path,
        origin: "model".to_string(),
        source_session_id: Some(deps.session_id.to_string()).filter(|s| !s.is_empty()),
        created_at: deps.now_ms,
        updated_at: deps.now_ms,
        ..Default::default()
    };

    // 详情：能落就落。任何一步失败都只记一句说明 —— 记忆本身必须写进去。
    let detail_note = if detail.is_empty() {
        None
    } else {
        match store_new_detail(deps, &summary, detail).await {
            Ok((kb_id, doc_id)) => {
                record.detail_kb_id = Some(kb_id.clone());
                record.detail_doc_id = Some(doc_id.clone());
                Some(format!(
                    "Detail stored in the memory knowledge base (kb: {}, doc: {}) — read it later with memory_recall.",
                    kb_id, doc_id
                ))
            }
            Err(reason) => Some(format!(
                "The detail was not stored: {}; only the summary was saved.",
                reason
            )),
        }
    };

    deps.repo.upsert(&record).await?;

    // ④ 改写：把旧条目归档成「改前版」（**不删**），永久记忆冲突则不静默顶替
    let dedupe_note = match &decision {
        WriteDecision::Supersede { old, similarity } => {
            Some(archive_previous(deps, old, &record.id, *similarity).await)
        }
        WriteDecision::KeepPermanent { existing } => Some(format!(
            "An earlier PERMANENT memory {} (\"{}\") looks like the same fact. It was left untouched — tell the user about the conflict and let them edit or delete it in the memory panel; do not assume it is outdated.",
            existing.id, existing.summary
        )),
        _ => None,
    };

    // 写入成功 → 顺手问一次「该不该后台整理」（§3.3 的写路径闸门）。
    // ⚠️ 只做「本地计数 + 入队」：**绝不在这里等 LLM**；任何错误只打日志（返回值一字不改）。
    // 返回 `false` 是常态（没越线 / 刚整理过 / 没有宿主），所以这里不看返回值。
    crate::agent::memory::redistill::sched::request(deps.repo, deps.settings, deps.now_ms).await;

    let mut content = format!(
        "Saved memory (id: {}, level: {}, kind: {}): {}",
        record.id, record.level, record.kind, record.summary
    );
    if let Some(path) = record.project_path.as_deref() {
        // 告诉模型它刚写的这条是「项目记忆」：以后再写同类事实时分类才一致
        content.push_str(&format!(
            "\nScope: project at {} (injected only in sessions working inside it).",
            path
        ));
    }
    if let Some(note) = &detail_note {
        content.push('\n');
        content.push_str(note);
    }
    if let Some(note) = &dedupe_note {
        content.push('\n');
        content.push_str(note);
    }
    if raw_len > MEMORY_SUMMARY_MAX_CHARS {
        content.push_str(&format!(
            "\nNote: the summary was longer than {} characters and was truncated to {}.",
            MEMORY_SUMMARY_HINT_CHARS, MEMORY_SUMMARY_MAX_CHARS
        ));
    }

    let (replaces, similarity) = match &decision {
        WriteDecision::Supersede { old, similarity } => (Some(old.id.clone()), Some(*similarity)),
        _ => (None, None),
    };

    Ok(MemoryToolOutput {
        ui_data: json!({
            "mode": "write",
            "memoryId": record.id,
            "level": record.level,
            "kind": record.kind,
            "projectPath": record.project_path,
            "hasDetail": record.detail_doc_id.is_some(),
            "truncated": raw_len > MEMORY_SUMMARY_MAX_CHARS,
            "chars": record.summary.chars().count(),
            // 查重结论：界面上「这次是不是真新建了一条」不该靠猜
            "deduped": false,
            "replaces": replaces,
            "similarity": similarity,
        }),
        content,
    })
}

// ==================== 内部辅助 ====================

/// 重复写入（[`WriteDecision::Duplicate`]）：把新信息并到已有条目上 —— **不新建条目**
///
/// 能并的只有三样，都不改「这条记忆说的是什么」：
/// - **级别只升不降**：再写一遍普通版的同一条，不得把用户钉住的 `permanent` 降回 `normal`；
/// - **补详情正文**：老条目没有正文、这次带了 → 补上（否则「又写了一遍但详情被丢掉」）；
///   已有正文时**不覆盖**，并且如实说一句（沉默丢掉新正文与「只存了摘要」那种诚实不一致）；
/// - **更新时间**：推到现在（落库的 `updated_at` 不能退回创建时间）。
async fn merge_into_existing(
    deps: &MemoryToolDeps<'_>,
    existing: &MemoryRecord,
    level: &str,
    detail: &str,
    raw_len: usize,
) -> MemoryToolOutput {
    let mut merged = existing.clone();
    let mut notes: Vec<String> = Vec::new();

    if level == MEMORY_LEVEL_PERMANENT && merged.level != MEMORY_LEVEL_PERMANENT {
        match deps.repo.set_level(&merged.id, MEMORY_LEVEL_PERMANENT).await {
            Ok(true) => {
                merged.level = MEMORY_LEVEL_PERMANENT.to_string();
                notes.push("It was upgraded to permanent.".to_string());
            }
            Ok(false) => notes.push(
                "It could not be upgraded to permanent (it may have been removed meanwhile)."
                    .to_string(),
            ),
            Err(e) => notes.push(format!("It could not be upgraded to permanent ({}).", e)),
        }
    }

    if !detail.is_empty() && detail_link(&merged).is_none() {
        match store_new_detail(deps, &merged.summary, detail).await {
            Ok((kb_id, doc_id)) => {
                merged.detail_kb_id = Some(kb_id);
                merged.detail_doc_id = Some(doc_id);
                // 合并是「刚刚发生的写入」：`updated_at` 跟着走（否则会退回创建时间）
                merged.updated_at = deps.now_ms;
                match deps.repo.upsert(&merged).await {
                    Ok(()) => notes.push(
                        "Its detail was stored in the memory knowledge base — read it with memory_recall."
                            .to_string(),
                    ),
                    Err(e) => {
                        // 正文已经写进知识库但链不上：如实说，别假装成功（否则知识库里多一份孤儿正文）
                        merged.detail_kb_id = None;
                        merged.detail_doc_id = None;
                        notes.push(format!("The detail document was created but could not be linked ({}).", e));
                    }
                }
            }
            Err(reason) => notes.push(format!("The detail was not stored: {}.", reason)),
        }
    } else if !detail.is_empty() {
        // 已经有正文：**不默默丢掉**这次传进来的文字（模型会以为正文更新了）
        notes.push(
            "It already has a detail document, so the new detail text was not stored — tell the user the existing detail was kept if that matters."
                .to_string(),
        );
    }

    let mut content = format!(
        "Already remembered (id: {}, level: {}, kind: {}): {}\nNo new entry was created — the existing memory already says this.",
        merged.id, merged.level, merged.kind, merged.summary
    );
    for note in &notes {
        content.push('\n');
        content.push_str(note);
    }
    if raw_len > MEMORY_SUMMARY_MAX_CHARS {
        content.push_str(&format!(
            "\nNote: the summary was longer than {} characters and was truncated to {}.",
            MEMORY_SUMMARY_HINT_CHARS, MEMORY_SUMMARY_MAX_CHARS
        ));
    }

    MemoryToolOutput {
        ui_data: json!({
            "mode": "write",
            "memoryId": merged.id,
            "level": merged.level,
            "kind": merged.kind,
            "projectPath": merged.project_path,
            "hasDetail": merged.detail_doc_id.is_some(),
            "truncated": raw_len > MEMORY_SUMMARY_MAX_CHARS,
            "chars": merged.summary.chars().count(),
            "deduped": true,
            "replaces": null,
            "similarity": null,
        }),
        content,
    }
}

/// 把旧条目归档成「改前版」：`disabled + superseded_by = 新 id`（**不删**）
///
/// 返回一句给模型看的话。三种结果都要如实说：
/// - 命中 → 旧版已归档，可用 `memory_recall` 读回（比对用）；
/// - CAS 未命中（0）→ 期间被用户或另一个会话改过/停用过，两条都保留；
/// - 写失败 → 两条都保留。
async fn archive_previous(
    deps: &MemoryToolDeps<'_>,
    old: &MemoryRecord,
    new_id: &str,
    similarity: f64,
) -> String {
    let pairs = [(
        old.id.clone(),
        old.updated_at,
        new_id.to_string(),
    )];
    match deps.repo.supersede(&pairs, deps.now_ms).await {
        Ok(1) => format!(
            "It replaces the earlier memory {} (\"{}\", similarity {:.2}). The previous version is archived, not deleted — read it with memory_recall {} if you need to compare.",
            old.id, old.summary, similarity, old.id
        ),
        Ok(_) => format!(
            "An earlier memory {} (\"{}\") looked like the same fact, but it changed meanwhile — both entries are kept.",
            old.id, old.summary
        ),
        Err(e) => format!(
            "An earlier memory {} (\"{}\") could not be archived ({}); both entries are kept.",
            old.id, old.summary, e
        ),
    }
}

/// 详情正文落专用知识库 → `(kb_id, doc_id)`；`Err` 是**原因短句**（调用方自己成句，
/// 因为「只存了摘要」这种收尾对新建与合并两句不一样）
async fn store_new_detail(
    deps: &MemoryToolDeps<'_>,
    summary: &str,
    detail: &str,
) -> Result<(String, String), String> {
    let Some(rag) = deps.rag else {
        return Err("the knowledge base is unavailable in this environment".to_string());
    };
    let kb_id = kb::ensure_memory_kb(deps.settings, rag)
        .await
        .map_err(|e| format!("the memory knowledge base is unavailable ({})", e))?;
    let doc_name = kb::detail_doc_name(summary);
    let doc_id = kb::store_detail(rag, kb_id.clone(), doc_name, detail.to_string())
        .await
        .map_err(|e| format!("the detail could not be stored ({})", e))?;
    Ok((kb_id, doc_id))
}

/// 单条记忆的模型侧文本行（与 `# Memory` 注入段同风格，便于模型把两处对应起来）。
///
/// id 的规则与注入段**逐字一致**：**只有带详情的条目才给 id**（没有详情的记忆召回出来就是
/// 这一行本身 —— 给 id 等于诱导模型白花一次工具调用）；`kb_id` / `doc_id` 一律不露（召回只要
/// 记忆 id，链接是内部实现细节）。
fn format_memory_line(m: &MemoryRecord) -> String {
    let mut flags = format!("kind: {}, level: {}", m.kind, m.level);
    if !m.source_day.trim().is_empty() {
        flags.push_str(&format!(", day: {}", m.source_day));
    }
    if m.hits > 0 {
        flags.push_str(&format!(", hits: {}", m.hits));
    }
    if let Some((_kb, _doc)) = detail_link(m) {
        flags.push_str(&format!(", id: {}", m.id));
    }
    format!("- ({}) {}", flags, m.summary)
}

/// 单条记忆的结构化字段（界面用；**不含**正文以外的敏感内容）
fn memory_ui_item(m: &MemoryRecord) -> Value {
    json!({
        "id": m.id,
        "level": m.level,
        "kind": m.kind,
        "summary": m.summary,
        "sourceDay": m.source_day,
        "hits": m.hits,
        "hasDetail": detail_link(m).is_some(),
    })
}

/// 详情链接（两半都非空才算有）—— 判定口径在 [`crate::agent::memory::detail_link`]，只有那一份；
/// 这里只是把 `&str` 拷成自有 `String`（调用处要拿去建 / 删文档）
fn detail_link(m: &MemoryRecord) -> Option<(String, String)> {
    crate::agent::memory::detail_link(m).map(|(kb, doc)| (kb.to_string(), doc.to_string()))
}

/// `Option<&str>` → 去空白后的 `Option<&str>`（空串视为「没给」）
fn normalize_opt(v: Option<&str>) -> Option<&str> {
    v.map(|s| s.trim()).filter(|s| !s.is_empty())
}

fn unavailable(mode: &str) -> MemoryToolOutput {
    MemoryToolOutput {
        content: MEMORY_UNAVAILABLE.to_string(),
        ui_data: json!({ "mode": mode, "available": false }),
    }
}

fn missing_param(name: &str, hint: &str) -> MemoryToolOutput {
    MemoryToolOutput {
        content: format!("Missing required parameter: \"{}\". Please provide {}.", name, hint),
        ui_data: json!({ "mode": "error", "error": "missing_param", "param": name }),
    }
}

fn invalid_param(name: &str, value: &str, allowed: &str) -> MemoryToolOutput {
    MemoryToolOutput {
        content: format!(
            "Invalid \"{}\": \"{}\". Allowed values: {}.",
            name, value, allowed
        ),
        ui_data: json!({ "mode": "error", "error": "invalid_param", "param": name }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use crate::session_db::{NoopSettingsRepo, MEMORY_LEVEL_PERMANENT as PERM};
    use std::sync::Mutex;

    /// 内存版仓储：只实现工具真正用到的那几个方法
    #[derive(Default)]
    struct StubRepo {
        items: Mutex<Vec<MemoryRecord>>,
        touched: Mutex<Vec<String>>,
        available: bool,
    }

    impl StubRepo {
        fn new(available: bool, items: Vec<MemoryRecord>) -> Self {
            Self {
                items: Mutex::new(items),
                touched: Mutex::new(Vec::new()),
                available,
            }
        }
    }

    #[async_trait]
    impl MemoryRepo for StubRepo {
        fn is_available(&self) -> bool {
            self.available
        }
        async fn list(&self, _l: Option<&str>, _d: bool) -> Result<Vec<MemoryRecord>, String> {
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
            query: &str,
            level: Option<&str>,
            kind: Option<&str>,
            limit: usize,
        ) -> Result<Vec<MemoryRecord>, String> {
            // 桩不做真检索：只按过滤条件返回（检索本身在 session_db::memory 有真测试）
            let mut out: Vec<MemoryRecord> = self
                .items
                .lock()
                .unwrap()
                .iter()
                .filter(|m| !m.disabled && m.summary.contains(query))
                .filter(|m| level.map(|l| m.level == l).unwrap_or(true))
                .filter(|m| kind.map(|k| m.kind == k).unwrap_or(true))
                .cloned()
                .collect();
            out.truncate(limit);
            Ok(out)
        }
        /// 查重候选：与 SQLite 实现同一套口径（未停用 + **作用域归一化后**相同）
        async fn active_in_scope(
            &self,
            project_path: Option<&str>,
            limit: usize,
        ) -> Result<Vec<MemoryRecord>, String> {
            // ⚠️ 与 SQL 侧同一个归一化：分隔符 / 尾斜杠 / 大小写（Win·macOS）不同也是同一个项目
            let scope = match project_path.map(str::trim).filter(|s| !s.is_empty()) {
                Some(p) => scope::path_key(p),
                None => String::new(),
            };
            let mut out: Vec<MemoryRecord> = self
                .items
                .lock()
                .unwrap()
                .iter()
                .filter(|m| !m.disabled)
                .filter(|m| {
                    let mine = match m.project_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                        Some(p) => scope::path_key(p),
                        None => String::new(),
                    };
                    mine == scope
                })
                .cloned()
                .collect();
            out.sort_by(|a, b| {
                b.hits
                    .cmp(&a.hits)
                    .then_with(|| b.updated_at.cmp(&a.updated_at))
                    .then_with(|| a.id.cmp(&b.id))
            });
            out.truncate(limit.clamp(1, 500));
            Ok(out)
        }
        async fn upsert(&self, record: &MemoryRecord) -> Result<(), String> {
            let mut items = self.items.lock().unwrap();
            match items.iter_mut().find(|m| m.id == record.id) {
                Some(slot) => *slot = record.clone(),
                None => items.push(record.clone()),
            }
            Ok(())
        }
        async fn delete(&self, id: &str) -> Result<bool, String> {
            let mut items = self.items.lock().unwrap();
            let before = items.len();
            items.retain(|m| m.id != id);
            Ok(items.len() != before)
        }
        async fn set_level(&self, id: &str, level: &str) -> Result<bool, String> {
            let mut items = self.items.lock().unwrap();
            match items.iter_mut().find(|m| m.id == id) {
                Some(m) => {
                    m.level = level.to_string();
                    Ok(true)
                }
                None => Ok(false),
            }
        }
        async fn set_disabled(&self, id: &str, disabled: bool) -> Result<bool, String> {
            let mut items = self.items.lock().unwrap();
            match items.iter_mut().find(|m| m.id == id) {
                Some(m) => {
                    m.disabled = disabled;
                    Ok(true)
                }
                None => Ok(false),
            }
        }
        /// 与 SQLite 实现同语义的 CAS 停用（只写 `superseded_by` 与停用时刻）
        async fn supersede(
            &self,
            ids: &[(String, i64, String)],
            now_ms: i64,
        ) -> Result<usize, String> {
            let mut items = self.items.lock().unwrap();
            let mut hit = 0usize;
            for (id, expected, new_id) in ids {
                if let Some(m) = items.iter_mut().find(|m| m.id == *id) {
                    if !m.disabled && m.updated_at == *expected {
                        m.disabled = true;
                        m.superseded_by = Some(new_id.clone());
                        m.updated_at = now_ms;
                        hit += 1;
                    }
                }
            }
            Ok(hit)
        }
        async fn touch(&self, ids: &[String], _now: i64) -> Result<(), String> {
            self.touched.lock().unwrap().extend_from_slice(ids);
            Ok(())
        }
    }

    fn rec(id: &str, summary: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: MEMORY_LEVEL_NORMAL.into(),
            kind: "project".into(),
            summary: summary.into(),
            origin: "user".into(),
            source_day: "2026-10-05".into(),
            created_at: 1_700_000_000_000,
            ..Default::default()
        }
    }

    fn deps<'a>(repo: &'a StubRepo, settings: &'a NoopSettingsRepo) -> MemoryToolDeps<'a> {
        deps_in(repo, settings, "")
    }

    /// 带工作目录的依赖（项目作用域用例用）
    fn deps_in<'a>(
        repo: &'a StubRepo,
        settings: &'a NoopSettingsRepo,
        workspace: &'a str,
    ) -> MemoryToolDeps<'a> {
        MemoryToolDeps {
            repo,
            settings,
            rag: None,
            session_id: "s1",
            workspace,
            now_ms: 1_700_000_000_000,
        }
    }

    fn with_detail(mut m: MemoryRecord) -> MemoryRecord {
        m.detail_kb_id = Some("kb_1".into());
        m.detail_doc_id = Some("doc_1".into());
        m
    }

    // ── 存储不可用 ──

    #[tokio::test]
    async fn all_three_report_unavailable_without_storage() {
        let repo = StubRepo::new(false, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        let s = run_search(&d, "任意", None, None, None).await.unwrap();
        let r = run_recall(&d, "m1").await.unwrap();
        let w = run_write(
            &d,
            WriteRequest { summary: "x", kind: "fact", level: None, detail: None },
        )
        .await
        .unwrap();

        for out in [s, r, w] {
            assert_eq!(out.content, MEMORY_UNAVAILABLE);
            assert_eq!(out.ui_data.get("available").and_then(|v| v.as_bool()), Some(false));
        }
    }

    // ── search ──

    #[tokio::test]
    async fn search_returns_lines_and_touches_hits() {
        let repo = StubRepo::new(true, vec![rec("m_a1", "记忆功能实现"), rec("m_b2", "无关内容")]);
        let settings = NoopSettingsRepo;
        let out = run_search(&deps(&repo, &settings), "记忆功能", None, None, None)
            .await
            .unwrap();

        assert!(out.content.contains("Found 1 memories for \"记忆功能\""));
        // 没有详情 → 不给 id（与注入段同一条规则）
        assert!(out.content.contains("- (kind: project, level: normal, day: 2026-10-05)"));
        assert!(!out.content.contains("m_a1"), "没详情的条目不得带 id：{out:?}");
        assert!(out.content.contains("memory_recall"));
        assert_eq!(out.ui_data["count"], 1);
        // UI 数据里 id 照旧（面板的选中 / 操作靠它），模型侧文本才是「按需给」
        assert_eq!(out.ui_data["items"][0]["id"], "m_a1");
        assert_eq!(out.ui_data["items"][0]["hasDetail"], false);
        // 命中即记账（top-k 排序的输入）
        assert_eq!(repo.touched.lock().unwrap().as_slice(), ["m_a1".to_string()]);
    }

    #[tokio::test]
    async fn search_line_carries_id_only_for_entries_with_a_detail() {
        let with_detail = {
            let mut r = rec("m_d1", "有详情的记忆");
            r.detail_kb_id = Some("kb_1".into());
            r.detail_doc_id = Some("doc_1".into());
            r
        };
        let repo = StubRepo::new(true, vec![with_detail]);
        let settings = NoopSettingsRepo;
        let out = run_search(&deps(&repo, &settings), "有详情", None, None, None)
            .await
            .unwrap();
        assert!(out.content.contains("id: m_d1"), "{}", out.content);
        // kb / doc 不进模型侧文本：召回只要记忆 id
        assert!(!out.content.contains("kb_1") && !out.content.contains("doc_1"));
        assert!(out.content.contains("memory_recall"));
        assert_eq!(out.ui_data["items"][0]["hasDetail"], true);
    }

    #[tokio::test]
    async fn search_rejects_empty_query_and_bad_enum_values() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        let empty = run_search(&d, "   ", None, None, None).await.unwrap();
        assert!(empty.content.starts_with("Missing required parameter: \"query\""));
        // 非法枚举：直接拒绝并给出允许值（让模型自己改，而不是静默改写用户的意思）
        let bad_level = run_search(&d, "x", Some("very"), None, None).await.unwrap();
        assert!(bad_level.content.contains("Allowed values: normal, permanent"));
        let bad_kind = run_search(&d, "x", None, Some("note"), None).await.unwrap();
        assert!(bad_kind.content.contains("Allowed values: user, project, decision, fact"));
    }

    #[tokio::test]
    async fn search_empty_result_is_a_normal_answer() {
        let repo = StubRepo::new(true, vec![rec("m_a1", "记忆功能")]);
        let settings = NoopSettingsRepo;
        let out = run_search(&deps(&repo, &settings), "不存在", None, None, None)
            .await
            .unwrap();
        assert_eq!(out.content, "No memories found for \"不存在\".");
        assert!(repo.touched.lock().unwrap().is_empty());
    }

    // ── recall ──

    #[tokio::test]
    async fn recall_without_detail_link_says_summary_is_all() {
        let repo = StubRepo::new(true, vec![rec("m_a1", "用户偏好中文回复")]);
        let settings = NoopSettingsRepo;
        let out = run_recall(&deps(&repo, &settings), "m_a1").await.unwrap();

        assert!(out.content.contains("has no stored detail"));
        assert!(out.content.contains("用户偏好中文回复"));
        assert_eq!(out.ui_data["hasDetail"], false);
        assert_eq!(out.ui_data["detailRead"], false);
        assert_eq!(repo.touched.lock().unwrap().as_slice(), ["m_a1".to_string()]);
    }

    #[tokio::test]
    async fn recall_without_rag_is_honest_about_the_missing_detail() {
        let repo = StubRepo::new(true, vec![with_detail(rec("m_a1", "摘要")), ]);
        let settings = NoopSettingsRepo;
        let out = run_recall(&deps(&repo, &settings), "m_a1").await.unwrap();

        assert!(out.content.contains("knowledge base is unavailable"), "{}", out.content);
        assert_eq!(out.ui_data["hasDetail"], true);
        assert_eq!(out.ui_data["detailRead"], false);
    }

    #[tokio::test]
    async fn recall_unknown_id_and_missing_param() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        let missing = run_recall(&d, "  ").await.unwrap();
        assert!(missing.content.starts_with("Missing required parameter: \"memory_id\""));

        let not_found = run_recall(&d, "m_zzz").await.unwrap();
        assert!(not_found.content.contains("No memory found with id \"m_zzz\""));
        assert_eq!(not_found.ui_data["found"], false);
    }

    #[tokio::test]
    async fn recall_marks_disabled_entries() {
        let mut off = rec("m_a1", "已停用的记忆");
        off.disabled = true;
        let repo = StubRepo::new(true, vec![off]);
        let settings = NoopSettingsRepo;
        let out = run_recall(&deps(&repo, &settings), "m_a1").await.unwrap();
        assert!(out.content.starts_with("(This memory is disabled"));
    }

    // ── write ──

    #[tokio::test]
    async fn write_validates_params_and_stores_the_record() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        let missing = run_write(&d, WriteRequest { summary: "  ", kind: "fact", level: None, detail: None })
            .await
            .unwrap();
        assert!(missing.content.starts_with("Missing required parameter: \"summary\""));

        let bad_kind = run_write(&d, WriteRequest { summary: "x", kind: "note", level: None, detail: None })
            .await
            .unwrap();
        assert!(bad_kind.content.contains("Allowed values: user, project, decision, fact"));

        let bad_level = run_write(
            &d,
            WriteRequest { summary: "x", kind: "fact", level: Some("high"), detail: None },
        )
        .await
        .unwrap();
        assert!(bad_level.content.contains("Allowed values: normal, permanent"));

        // 正常写入：id 前缀 / 级别默认 normal / 来源会话 / 原文
        let ok = run_write(
            &d,
            WriteRequest { summary: "  用户偏好中文回复  ", kind: "user", level: None, detail: None },
        )
        .await
        .unwrap();
        assert!(ok.content.starts_with("Saved memory (id: m_"));
        assert!(ok.content.contains("level: normal, kind: user"));
        assert!(ok.content.contains("用户偏好中文回复"));
        let stored = repo.items.lock().unwrap().clone();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].origin, "model");
        assert_eq!(stored[0].source_session_id.as_deref(), Some("s1"));
        assert_eq!(stored[0].summary, "用户偏好中文回复");
    }

    #[tokio::test]
    async fn write_can_set_permanent_and_truncates_over_the_hard_limit() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let long = "字".repeat(MEMORY_SUMMARY_MAX_CHARS + 20);
        let out = run_write(
            &deps(&repo, &settings),
            WriteRequest { summary: &long, kind: "user", level: Some(PERM), detail: None },
        )
        .await
        .unwrap();

        assert!(out.content.contains("level: permanent"));
        assert!(out.content.contains("was truncated"));
        assert_eq!(out.ui_data["truncated"], true);
        let stored = repo.items.lock().unwrap().clone();
        assert_eq!(stored[0].summary.chars().count(), MEMORY_SUMMARY_MAX_CHARS + 1, "150 + 省略号");
    }

    #[tokio::test]
    async fn write_with_detail_without_knowledge_base_keeps_the_summary() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let out = run_write(
            &deps(&repo, &settings),
            WriteRequest {
                summary: "重要结论",
                kind: "decision",
                level: None,
                detail: Some("很长很长的正文……"),
            },
        )
        .await
        .unwrap();

        assert!(out.content.contains("only the summary was saved"), "{}", out.content);
        assert_eq!(out.ui_data["hasDetail"], false);
        // 记忆条目照写（详情写不进去不牵连记忆本身）
        assert_eq!(repo.items.lock().unwrap().len(), 1);
    }

    // ── 写入前查重（P1）──

    #[tokio::test]
    async fn write_duplicate_creates_no_second_entry() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        let first = run_write(
            &d,
            WriteRequest { summary: "用户偏好中文回复", kind: "user", level: None, detail: None },
        )
        .await
        .unwrap();
        assert!(first.content.starts_with("Saved memory"));

        // 同一句话再写一遍（标点 / 空白差异被归一化掉）：不新建条目
        let again = run_write(
            &d,
            WriteRequest { summary: "  用户偏好中文回复。", kind: "user", level: None, detail: None },
        )
        .await
        .unwrap();
        assert!(again.content.starts_with("Already remembered"), "{}", again.content);
        assert!(again.content.contains("No new entry was created"));
        assert_eq!(again.ui_data["deduped"], true);
        assert_eq!(
            again.ui_data["memoryId"], first.ui_data["memoryId"],
            "返回的必须是库里那条的 id（不是新造的）"
        );
        assert_eq!(repo.items.lock().unwrap().len(), 1, "库里只能有一条");
    }

    /// 再写一遍**只升不降**：普通版重复写入不得把用户钉住的 `permanent` 降回 `normal`
    #[tokio::test]
    async fn duplicate_write_upgrades_level_but_never_downgrades() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        run_write(
            &d,
            WriteRequest { summary: "用户偏好中文回复", kind: "user", level: None, detail: None },
        )
        .await
        .unwrap();

        let upgraded = run_write(
            &d,
            WriteRequest { summary: "用户偏好中文回复", kind: "user", level: Some(PERM), detail: None },
        )
        .await
        .unwrap();
        assert!(upgraded.content.contains("upgraded to permanent"), "{}", upgraded.content);
        assert_eq!(upgraded.ui_data["level"], "permanent");

        // 再来一次普通写入：不得降级
        let again = run_write(
            &d,
            WriteRequest { summary: "用户偏好中文回复", kind: "user", level: None, detail: None },
        )
        .await
        .unwrap();
        assert_eq!(again.ui_data["level"], "permanent");
        assert_eq!(repo.items.lock().unwrap()[0].level, "permanent");
    }

    /// 同一句被改写：新建条目 + 旧条目归档成「改前版」（不删、仍可 recall）
    #[tokio::test]
    async fn rewrite_archives_the_previous_version_and_keeps_it() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps_in(&repo, &settings, "C:/work/app");

        let old = run_write(
            &d,
            WriteRequest { summary: "项目用 pnpm 构建", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();
        let old_id = old.ui_data["memoryId"].as_str().unwrap().to_string();

        let new = run_write(
            &d,
            WriteRequest { summary: "项目用 npm 构建", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();
        let new_id = new.ui_data["memoryId"].as_str().unwrap().to_string();
        assert!(new.content.starts_with("Saved memory"));
        assert!(
            new.content.contains("replaces the earlier memory")
                && new.content.contains("archived, not deleted"),
            "必须告诉模型旧版去哪了：{}",
            new.content
        );
        assert_eq!(new.ui_data["replaces"], old_id.as_str());
        assert_ne!(new_id, old_id);

        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items.len(), 2, "两条都在（旧版只是归档）");
        let archived = items.iter().find(|m| m.id == old_id).unwrap();
        assert!(archived.disabled, "旧版不再注入");
        assert_eq!(archived.superseded_by.as_deref(), Some(new_id.as_str()));
        assert_eq!(archived.summary, "项目用 pnpm 构建", "改前版正文不得被改写");
        let fresh = items.iter().find(|m| m.id == new_id).unwrap();
        assert!(!fresh.disabled, "新事实照常注入");
    }

    /// 冲突对象是永久记忆：普通写入不静默顶替，也不假装成功
    #[tokio::test]
    async fn conflicting_permanent_memory_is_left_untouched() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        run_write(
            &d,
            WriteRequest { summary: "项目用 pnpm 构建", kind: "project", level: Some(PERM), detail: None },
        )
        .await
        .unwrap();
        let out = run_write(
            &d,
            WriteRequest { summary: "项目用 npm 构建", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();

        assert!(out.content.contains("PERMANENT memory"), "{}", out.content);
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items.len(), 2);
        assert!(
            items.iter().all(|m| !m.disabled),
            "永久记忆必须保持原样（用户钉住的级别不能由模型绕过）"
        );
    }

    /// 查重只看**同一作用域**：别的项目的同文条目不得被顶替
    #[tokio::test]
    async fn dedupe_only_compares_within_the_same_project_scope() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;

        let app = deps_in(&repo, &settings, "C:/work/app");
        run_write(
            &app,
            WriteRequest { summary: "项目用 pnpm 构建", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();

        let other = deps_in(&repo, &settings, "C:/work/other");
        let out = run_write(
            &other,
            WriteRequest { summary: "项目用 pnpm 构建", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();
        assert!(out.content.starts_with("Saved memory"), "{}", out.content);
        assert_eq!(out.ui_data["deduped"], false);
        assert_eq!(repo.items.lock().unwrap().len(), 2, "两个项目各留一条");
    }

    /// 同一个项目换个**写法**（反斜杠 / 尾斜杠）再写同一件事：仍然要查得出来
    ///
    /// 回归锁：作用域以前按原字符串相等比，同一项目换个写法就漏查重 —— 互斥的两条事实
    /// 会在同一个项目里静默并存（正是本功能要消灭的场景）。
    #[tokio::test]
    async fn dedupe_treats_path_spellings_of_the_same_project_as_one_scope() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;

        // 第一次写：工作目录是 Windows 风格带尾斜杠
        let first = deps_in(&repo, &settings, "C:\\work\\app\\");
        run_write(
            &first,
            WriteRequest { summary: "项目用 pnpm 构建", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();

        // 第二次写：同一个项目的另一种写法
        let second = deps_in(&repo, &settings, "C:/work/app");
        let out = run_write(
            &second,
            WriteRequest { summary: "项目用 pnpm 构建", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();

        assert_eq!(out.ui_data["deduped"], true, "{}", out.content);
        assert_eq!(repo.items.lock().unwrap().len(), 1, "同一个项目只该有一条");
    }

    /// 重复写入带了新正文、但老条目**已有**正文：不覆盖，也不能沉默
    ///
    /// （沉默丢掉新传入的正文，与「详情没存进去就如实说只存了摘要」那条原则不一致 ——
    /// 模型会以为正文已经更新了。）
    #[tokio::test]
    async fn duplicate_write_with_detail_keeps_the_existing_detail_and_says_so() {
        let existing = with_detail(MemoryRecord {
            id: "m_old".into(),
            level: "normal".into(),
            kind: "decision".into(),
            summary: "项目用 pnpm 构建".into(),
            created_at: 1_600_000_000_000,
            updated_at: 1_600_000_000_000,
            ..Default::default()
        });
        let repo = StubRepo::new(true, vec![existing]);
        let settings = NoopSettingsRepo;
        let d = deps(&repo, &settings);

        let out = run_write(
            &d,
            WriteRequest {
                summary: "项目用 pnpm 构建",
                kind: "decision",
                level: None,
                detail: Some("一份新的、更详细的正文"),
            },
        )
        .await
        .unwrap();

        assert_eq!(out.ui_data["deduped"], true, "{}", out.content);
        assert!(
            out.content.contains("already has a detail document"),
            "必须告诉模型正文没被更新：{}",
            out.content
        );
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items.len(), 1, "不新建条目");
        assert_eq!(
            items[0].detail_doc_id.as_deref(),
            Some("doc_1"),
            "已存在的正文不能被新正文顶掉"
        );
    }

    // ── 项目作用域 ──

    #[tokio::test]
    async fn project_writes_get_the_workspace_others_do_not() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let d = deps_in(&repo, &settings, "C:/work/app");

        run_write(&d, WriteRequest { summary: "项目约定", kind: "project", level: None, detail: None })
            .await
            .unwrap();
        run_write(&d, WriteRequest { summary: "用户喜欢简洁", kind: "user", level: None, detail: None })
            .await
            .unwrap();

        let stored = repo.items.lock().unwrap().clone();
        assert_eq!(stored[0].project_path.as_deref(), Some("C:/work/app"));
        assert_eq!(stored[1].project_path, None, "非 project 分类不限定项目");

        // 没有工作目录时（CLI / 未设目录的会话）project 也不带路径 = 通用记忆
        let repo2 = StubRepo::new(true, vec![]);
        run_write(
            &deps_in(&repo2, &settings, "  "),
            WriteRequest { summary: "项目约定", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();
        assert_eq!(repo2.items.lock().unwrap()[0].project_path, None);
    }

    #[tokio::test]
    async fn write_reports_the_scope_to_the_model() {
        let repo = StubRepo::new(true, vec![]);
        let settings = NoopSettingsRepo;
        let out = run_write(
            &deps_in(&repo, &settings, "C:/work/app"),
            WriteRequest { summary: "项目约定", kind: "project", level: None, detail: None },
        )
        .await
        .unwrap();
        assert!(out.content.contains("Scope: project at C:/work/app"), "{}", out.content);
        assert_eq!(out.ui_data["projectPath"], "C:/work/app");
    }

    #[tokio::test]
    async fn search_hides_other_projects_and_says_how_many() {
        let mut mine = rec("m_mine", "记忆功能实现");
        mine.project_path = Some("C:/work/app".into());
        let mut other = rec("m_other", "记忆功能的历史决策");
        other.project_path = Some("C:/work/other".into());
        let repo = StubRepo::new(true, vec![mine, other]);
        let settings = NoopSettingsRepo;

        let out = run_search(&deps_in(&repo, &settings, "C:/work/app/src"), "记忆功能", None, None, None)
            .await
            .unwrap();
        assert_eq!(out.ui_data["count"], 1);
        assert_eq!(out.ui_data["items"][0]["id"], "m_mine");
        assert_eq!(out.ui_data["hiddenByScope"], 1);
        assert!(
            out.content.contains("1 more match(es) belong to other projects"),
            "必须如实说明被藏起来的条数，否则看起来像「没记过」：{}",
            out.content
        );
        // 只给看得见的那条记账
        assert_eq!(repo.touched.lock().unwrap().as_slice(), ["m_mine".to_string()]);

        // 全部命中都被藏起来时也要说清楚（不然就是一句干巴巴的 "No memories found"）
        let out = run_search(&deps_in(&repo, &settings, "C:/work/third"), "记忆功能", None, None, None)
            .await
            .unwrap();
        assert!(out.content.starts_with("No memories found"));
        assert!(out.content.contains("2 more match(es) belong to other projects"));
        assert!(repo.touched.lock().unwrap().iter().all(|id| id != "m_other"));
    }
}
