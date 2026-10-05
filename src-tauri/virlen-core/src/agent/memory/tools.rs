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

use crate::agent::memory::kb;
use crate::agent::memory::scope::{self, scope_for_write};
use crate::agent::memory::{
    clamp_summary, is_valid_kind, is_valid_level, MEMORY_KINDS, MEMORY_LEVEL_NORMAL,
    MEMORY_SUMMARY_HINT_CHARS, MEMORY_SUMMARY_MAX_CHARS,
};
use crate::rag::rag_service::RagService;
use crate::session_db::{MemoryRecord, MemoryRepo, SettingsRepo};
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
/// - `kind = project` 时**自动**带上当前会话的工作目录作为项目路径（模型不必（也不该）自己猜路径）：
///   这条记忆之后只在该项目（或其子目录）里注入与召回；
/// - `detail` 非空 → 详情落知识库；**落库失败不牵连记忆条目**（返回里说明「只存了摘要」）；
/// - `level` 可给 `permanent`（已定稿：不设二次确认门，用户可以事后在面板降级 / 停用 / 删除）。
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
        match deps.rag {
            Some(rag) => match kb::ensure_memory_kb(deps.settings, rag).await {
                Ok(kb_id) => {
                    let doc_name = kb::detail_doc_name(&summary);
                    match kb::store_detail(rag, kb_id.clone(), doc_name, detail.to_string()).await {
                        Ok(doc_id) => {
                            record.detail_kb_id = Some(kb_id.clone());
                            record.detail_doc_id = Some(doc_id.clone());
                            Some(format!(
                                "Detail stored in the memory knowledge base (kb: {}, doc: {}) — read it later with memory_recall.",
                                kb_id, doc_id
                            ))
                        }
                        Err(e) => Some(format!(
                            "The detail could not be stored ({}); only the summary was saved.",
                            e
                        )),
                    }
                }
                Err(e) => Some(format!(
                    "The memory knowledge base is unavailable ({}); only the summary was saved.",
                    e
                )),
            },
            None => Some(
                "The knowledge base is unavailable in this environment; only the summary was saved."
                    .to_string(),
            ),
        }
    };

    deps.repo.upsert(&record).await?;

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
    if raw_len > MEMORY_SUMMARY_MAX_CHARS {
        content.push_str(&format!(
            "\nNote: the summary was longer than {} characters and was truncated to {}.",
            MEMORY_SUMMARY_HINT_CHARS, MEMORY_SUMMARY_MAX_CHARS
        ));
    }

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
        }),
        content,
    })
}

// ==================== 内部辅助 ====================

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
        async fn touch(&self, ids: &[String], _now: i64) -> Result<(), String> {
            self.touched.lock().unwrap().extend_from_slice(ids);
            Ok(())
        }
        // 整理流水（P2）：工具用例不涉及蒸馏
        async fn get_run(&self, _day: &str) -> Result<Option<crate::session_db::MemoryRun>, String> {
            Ok(None)
        }
        async fn list_runs(
            &self,
            _limit: usize,
        ) -> Result<Vec<crate::session_db::MemoryRun>, String> {
            Ok(Vec::new())
        }
        async fn last_done_day(&self) -> Result<Option<String>, String> {
            Ok(None)
        }
        async fn claim_run(
            &self,
            _day: &str,
            _opts: crate::session_db::ClaimOptions,
        ) -> Result<Option<crate::session_db::MemoryRun>, String> {
            Ok(None)
        }
        async fn finish_run(&self, _run: &crate::session_db::MemoryRun) -> Result<(), String> {
            Ok(())
        }
        async fn delete_distilled_day(
            &self,
            _day: &str,
        ) -> Result<Vec<MemoryRecord>, String> {
            Ok(Vec::new())
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
