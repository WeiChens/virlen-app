//! 记忆**落库**（P2）—— 校验 / 去重 / 写 `memories` / 详情落专用知识库
//!
//! 一次调用处理一整天的产出。三条硬约定：
//! - **去重只做「规范化后完全相同」**（[`normalize_summary`]）：一份记忆宁可少写一条，也不要写十遍
//!   —— 永久记忆是全量注入的，重复直接抬高每个会话的成本；向量相似度合并属 P3。
//! - **详情失败不牵连记忆条目**：知识库 / 嵌入不可用时记忆照写（`detail_*` 留空），只是这一天的
//!   整理记 `partial`（用户能在面板上看到原因）。
//! - **`origin = 'distill'`**：它是「重新整理某天」唯一会删掉的那一类；用户手写的（`user` / `model`）
//!   与别的日期的条目一律不动。

use crate::agent::memory::distill::DistilledMemory;
use crate::agent::memory::kb;
use crate::agent::memory::{
    near_duplicate, new_memory_id, normalize_summary, NearDuplicate, MEMORY_MAX_TAGS,
};
use crate::rag::rag_service::RagService;
use crate::session_db::{
    MemoryRecord, MemoryRepo, SessionMaterial, SettingsRepo, MEMORY_LEVEL_PERMANENT,
    MEMORY_ORIGIN_DISTILL,
};

/// 落库所需的依赖（显式注入，便于单测替换）
pub struct StoreDeps<'a> {
    pub memory: &'a dyn MemoryRepo,
    /// 详情知识库的 `kb_id` 缓存读写（`agent::memory::kb`）
    pub settings: &'a dyn SettingsRepo,
    /// RAG 未初始化时为 `None` → 不落详情（记忆条目照写）
    pub rag: Option<&'static RagService>,
}

/// 一次落库的结果（`memory_runs` 的几个计数都来自它）
#[derive(Debug, Clone, Default)]
pub struct StoreOutcome {
    /// 真正写进去的**新**条目
    pub records: Vec<MemoryRecord>,
    /// 其中落了详情的条数
    pub details: usize,
    /// 因「与现有记忆重复」被跳过的条数（规范化后完全相同）
    pub duplicates: usize,
    /// 因「与现有记忆近重复」被**合并**的条数（含「用户手写了一条，蒸馏产出被丢弃」）
    pub merged: usize,
    /// 详情落库失败的条数（>0 → 这一天记 `partial`）
    pub detail_errors: usize,
}

/// 把一天的产出写进库。
///
/// `sources` 是同一天的素材（用于回填 `source_session_id` 与默认 tags —— 素材只有一条会话时才有意义）。
pub async fn store_distilled(
    deps: &StoreDeps<'_>,
    day: &str,
    items: &[DistilledMemory],
    sources: &[SessionMaterial],
    now_ms: i64,
) -> Result<StoreOutcome, String> {
    let mut outcome = StoreOutcome::default();
    // 去重参照：现有全部记忆（含停用 —— 停用的条目也可能是同一条，不该再写一遍）
    //
    // 为什么用「记录列表 + 平行规范化列表」而不是一个 `HashSet`：近重复合并要**按索引回写**
    //（合并后要把库里的那条更新，后续条目也得拿新文本去比）。
    let mut state: Vec<MemoryRecord> = deps.memory.list(None, true).await?;
    let mut norms: Vec<String> = state.iter().map(|m| normalize_summary(&m.summary)).collect();

    for item in items {
        let norm = normalize_summary(&item.summary);
        if norm.is_empty() {
            outcome.duplicates += 1;
            continue;
        }
        // 第一道：规范化后完全相同（含同一天同一批里的重复 —— 模型偶尔会把同一条写两遍）
        if norms.iter().any(|n| n == &norm) {
            outcome.duplicates += 1;
            continue;
        }
        // 第二道：近重复 → 合并（而不是再写一条）
        if let Some((idx, ev)) = best_near_duplicate(&state, &item.summary) {
            let ctx = MergeCtx {
                deps,
                item,
                day,
                sources,
                now_ms,
            };
            let detail = merge_into(&ctx, &mut state, &mut norms, idx, ev).await?;
            outcome.merged += 1;
            match detail {
                DetailOutcome::NotNeeded => {}
                DetailOutcome::Attached => outcome.details += 1,
                // 详情写不进去也是降级：让这一天记 `partial`（与新增那条路径同口径）
                DetailOutcome::Failed => outcome.detail_errors += 1,
            }
            continue;
        }

        let mut record = MemoryRecord {
            id: new_memory_id(),
            level: item.level.clone(),
            kind: item.kind.clone(),
            summary: item.summary.clone(),
            detail_kb_id: None,
            detail_doc_id: None,
            tags: merge_tags(item, sources),
            source_day: day.to_string(),
            source_session_id: single_session(sources),
            origin: MEMORY_ORIGIN_DISTILL.to_string(),
            hits: 0,
            last_used_at: 0,
            created_at: now_ms,
            updated_at: now_ms,
            disabled: false,
        };

        if let (Some(title), Some(body)) = (item.detail_title.as_ref(), item.detail_body.as_ref()) {
            match store_detail(deps, title, body, &record.summary).await {
                Ok((kb_id, doc_id)) => {
                    record.detail_kb_id = Some(kb_id);
                    record.detail_doc_id = Some(doc_id);
                    outcome.details += 1;
                }
                Err(e) => {
                    // 详情失败不牵连条目本身：留空链接，计数让调用方记 partial
                    eprintln!("[memory] 详情落库失败（记忆条目照写）: {}", e);
                    outcome.detail_errors += 1;
                }
            }
        }

        deps.memory.upsert(&record).await?;
        norms.push(norm);
        state.push(record.clone());
        outcome.records.push(record);
    }

    Ok(outcome)
}

/// 在现有记忆里找**最强的**近重复候选（纯查找，不改任何状态）。
///
/// 选取规则：先看共享 gram 数（证据量），再看包含率；都相等时取**先出现的**那条
/// —— 全序，同一份输入永远合并到同一条。
fn best_near_duplicate(state: &[MemoryRecord], summary: &str) -> Option<(usize, NearDuplicate)> {
    let mut best: Option<(usize, NearDuplicate)> = None;
    for (idx, m) in state.iter().enumerate() {
        let Some(ev) = near_duplicate(summary, &m.summary) else {
            continue;
        };
        let better = match &best {
            None => true,
            Some((_, cur)) => {
                ev.overlap > cur.overlap
                    || (ev.overlap == cur.overlap && ev.containment > cur.containment)
            }
        };
        if better {
            best = Some((idx, ev));
        }
    }
    best
}

/// 合并时「详情那一支」的结果（决定 `memory_runs.status` 是否记 `partial`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetailOutcome {
    /// 本就不需要补详情（旧条目已有，或本次没带正文）
    NotNeeded,
    /// 补上了
    Attached,
    /// 想补但失败了（知识库 / 嵌入不可用）
    Failed,
}

/// 合并一次的输入（参数太多，收成一个结构体 —— 免得调用点靠位置猜意图）
struct MergeCtx<'a> {
    deps: &'a StoreDeps<'a>,
    item: &'a DistilledMemory,
    day: &'a str,
    sources: &'a [SessionMaterial],
    now_ms: i64,
}

/// 把一条新产出**合并**进已有的那条（[`best_near_duplicate`] 选中的下标）。
///
/// 合并策略（逐条理由见 `docs/memory-p3-plan.md` §2.3；这里只讲取舍）：
/// - **用户手写的那条（`origin != 'distill'`）一字不改** —— 蒸馏不该动用户亲手敲的字，
///   新产出直接丢弃（算 `merged`：确实做了一次合并判定）；
/// - 蒸馏 + 蒸馏：保留旧条目的 `id` / `created_at` / `hits` / `disabled`（身份与统计稳定，
///   注入段也就稳定）；正文取**更长**的那条（等长保留旧的）；`tags` 取并集；
///   `source_day` 跟着**存活的正文**走；`updated_at` 刷新；
/// - 级别只升不降：本次明确判 `permanent` 就升为永久（级别就是「是否全量注入」，新判断更准），
///   否则保持旧级别（不因为今天没说 permanent 就把用户升级过的降回去）。
///
/// 返回「详情那一支」的结果（旧条目本来没有详情、而本次带了详情正文时才可能 Attached / Failed）。
async fn merge_into(
    ctx: &MergeCtx<'_>,
    state: &mut [MemoryRecord],
    norms: &mut [String],
    idx: usize,
    ev: NearDuplicate,
) -> Result<DetailOutcome, String> {
    let (item, day, sources, now_ms) = (ctx.item, ctx.day, ctx.sources, ctx.now_ms);
    let old = state[idx].clone();
    if old.origin != MEMORY_ORIGIN_DISTILL {
        eprintln!(
            "[memory] 近重复（包含率 {:.2}）：现有「{}」不是蒸馏产出，保留它、丢弃本次产出",
            ev.containment, old.summary
        );
        return Ok(DetailOutcome::NotNeeded);
    }

    let keep_new_text = item.summary.chars().count() > old.summary.chars().count();
    let mut merged = old.clone();
    if keep_new_text {
        merged.summary = item.summary.clone();
        merged.source_day = day.to_string();
        // 存活正文的来源会话：新那天没单一来源时，保留旧的（别把溯源信息抹掉）
        merged.source_session_id = single_session(sources).or(old.source_session_id);
    }
    merged.tags = union_tags(&old.tags, &item.tags, sources);
    merged.updated_at = now_ms;
    if item.level == MEMORY_LEVEL_PERMANENT {
        merged.level = MEMORY_LEVEL_PERMANENT.to_string();
    }

    // 详情：旧条目没有详情、而本次带了正文 → 补上（旧条目已有详情就不动：避免同一天天往同一个文档里追加）
    let mut detail = DetailOutcome::NotNeeded;
    if merged.detail_doc_id.is_none() {
        if let (Some(title), Some(body)) = (item.detail_title.as_ref(), item.detail_body.as_ref()) {
            match store_detail(ctx.deps, title, body, &merged.summary).await {
                Ok((kb_id, doc_id)) => {
                    merged.detail_kb_id = Some(kb_id);
                    merged.detail_doc_id = Some(doc_id);
                    detail = DetailOutcome::Attached;
                }
                Err(e) => {
                    eprintln!("[memory] 合并时详情落库失败（合并照做）: {}", e);
                    detail = DetailOutcome::Failed;
                }
            }
        }
    }

    eprintln!(
        "[memory] 近重复合并（包含率 {:.2}，共享 {} 个 bigram）：{}「{}」",
        ev.containment,
        ev.overlap,
        if keep_new_text { "取更长的" } else { "保留原有的" },
        merged.summary
    );

    ctx.deps.memory.upsert(&merged).await?;
    state[idx] = merged.clone();
    norms[idx] = normalize_summary(&merged.summary);
    Ok(detail)
}

/// 删掉某天**蒸馏产出**的条目，并把它们的详情文档一并从知识库删掉（「重新整理某天」用）。
///
/// 删文档失败**不算失败**：孤儿文档可以在知识库页里手动删，而「整理」不该因为一个残留文档就中断。
/// 返回实际删掉的条目数。
pub async fn discard_day(deps: &StoreDeps<'_>, day: &str) -> Result<usize, String> {
    let removed = deps.memory.delete_distilled_day(day).await?;
    if let Some(rag) = deps.rag {
        for r in &removed {
            if let (Some(kb_id), Some(doc_id)) =
                (r.detail_kb_id.clone(), r.detail_doc_id.clone())
            {
                if let Err(e) = kb::remove_detail(rag, kb_id, doc_id).await {
                    eprintln!("[memory] 删除记忆详情文档失败（可在知识库页手动删）: {}", e);
                }
            }
        }
    }
    Ok(removed.len())
}

/// 写详情：`title` 优先做文档名（模型给的标题比摘要更像「目录项」）
async fn store_detail(
    deps: &StoreDeps<'_>,
    title: &str,
    body: &str,
    summary: &str,
) -> Result<(String, String), String> {
    let rag = deps
        .rag
        .ok_or_else(|| "知识库不可用（RAG 未初始化）".to_string())?;
    let kb_id = kb::ensure_memory_kb(deps.settings, rag).await?;
    let doc_name = kb::detail_doc_name(if title.trim().is_empty() {
        summary
    } else {
        title
    });
    let doc_id = kb::store_detail(rag, kb_id.clone(), doc_name, body.to_string()).await?;
    Ok((kb_id, doc_id))
}

/// 素材只有**一条**会话时才回填来源会话（多会话合成时没有单一来源，留空 —— 面板据 `source_day` 溯源）
fn single_session(sources: &[SessionMaterial]) -> Option<String> {
    match sources {
        [one] => Some(one.session_id.clone()),
        _ => None,
    }
}

/// 标签：模型的标签在前，再补一个工作目录名（一期「全局唯一 + tags 记工作目录」的落地），
/// 总量仍受 [`MEMORY_MAX_TAGS`] 限制，顺序稳定（先来先留）。
fn merge_tags(item: &DistilledMemory, sources: &[SessionMaterial]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for t in &item.tags {
        push_tag(&mut tags, t);
    }
    if let [one] = sources {
        if let Some(ws) = one.workspace.as_deref() {
            push_tag(&mut tags, workspace_label(ws));
        }
    }
    tags
}

/// 合并时的标签：**旧标签在前**（它们是稳定身份的一部分）再补本次的，总量与去重规则同 [`merge_tags`]。
fn union_tags(old: &[String], new: &[String], sources: &[SessionMaterial]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for t in old.iter().chain(new.iter()) {
        push_tag(&mut tags, t);
    }
    if let [one] = sources {
        if let Some(ws) = one.workspace.as_deref() {
            push_tag(&mut tags, workspace_label(ws));
        }
    }
    tags
}

/// 压入一个标签：去空白、去重、不超过上限（满了就静默丢弃 —— 标签只是辅助信息）
fn push_tag(tags: &mut Vec<String>, raw: &str) {
    let t = raw.trim();
    if t.is_empty() || tags.len() >= MEMORY_MAX_TAGS {
        return;
    }
    if !tags.iter().any(|x| x == t) {
        tags.push(t.to_string());
    }
}

/// 工作目录 → 标签（取最后一段目录名；`C:\code\virlen-app` → `virlen-app`）
fn workspace_label(workspace: &str) -> &str {
    workspace
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_db::{NoopSettingsRepo, MEMORY_LEVEL_NORMAL, MEMORY_LEVEL_PERMANENT};
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct StubRepo {
        items: Mutex<Vec<MemoryRecord>>,
    }

    #[async_trait]
    impl MemoryRepo for StubRepo {
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
            // 与真实仓储同语义：**按 id 覆盖**（合并就是靠它把旧条目改掉，不是再 push 一条）
            let mut items = self.items.lock().unwrap();
            match items.iter_mut().find(|m| m.id == record.id) {
                Some(slot) => *slot = record.clone(),
                None => items.push(record.clone()),
            }
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
        async fn get_run(
            &self,
            _day: &str,
        ) -> Result<Option<crate::session_db::MemoryRun>, String> {
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
        async fn delete_distilled_day(&self, day: &str) -> Result<Vec<MemoryRecord>, String> {
            let mut items = self.items.lock().unwrap();
            let (out, rest): (Vec<_>, Vec<_>) = items
                .drain(..)
                .partition(|m| m.source_day == day && m.origin == MEMORY_ORIGIN_DISTILL);
            *items = rest;
            Ok(out)
        }
    }

    fn deps<'a>(repo: &'a StubRepo, settings: &'a NoopSettingsRepo) -> StoreDeps<'a> {
        StoreDeps {
            memory: repo,
            settings,
            rag: None,
        }
    }

    fn item(summary: &str, level: &str) -> DistilledMemory {
        DistilledMemory {
            summary: summary.into(),
            kind: "project".into(),
            level: level.into(),
            tags: vec![],
            detail_title: None,
            detail_body: None,
        }
    }

    fn source(workspace: Option<&str>) -> SessionMaterial {
        SessionMaterial {
            session_id: "s1".into(),
            title: "会话".into(),
            workspace: workspace.map(String::from),
            agent_id: None,
            summary: Some("摘要".into()),
            transcript: String::new(),
            updated_at: 1,
        }
    }

    #[tokio::test]
    async fn stores_records_with_distill_origin_and_source_day() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        let out = store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[item("在 virlen-app 实现记忆功能", MEMORY_LEVEL_NORMAL)],
            &[source(Some("C:\\code\\virlen-app"))],
            1_700_000_000_000,
        )
        .await
        .unwrap();

        assert_eq!(out.records.len(), 1);
        assert_eq!(out.details, 0);
        assert_eq!(out.duplicates, 0);
        let stored = repo.items.lock().unwrap().clone();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].origin, MEMORY_ORIGIN_DISTILL);
        assert_eq!(stored[0].source_day, "2026-10-05");
        assert_eq!(stored[0].source_session_id.as_deref(), Some("s1"));
        assert_eq!(stored[0].created_at, 1_700_000_000_000);
        // 工作目录名自动进 tags（一期「全局唯一 + tags 记工作目录」）
        assert_eq!(stored[0].tags, vec!["virlen-app".to_string()]);
        assert!(stored[0].id.starts_with("m_"));
    }

    #[tokio::test]
    async fn explicit_permanent_level_is_kept() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[item("用户要求所有回复用中文", MEMORY_LEVEL_PERMANENT)],
            &[],
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            repo.items.lock().unwrap()[0].level,
            MEMORY_LEVEL_PERMANENT
        );
    }

    #[tokio::test]
    async fn duplicates_against_existing_and_within_batch_are_skipped() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        let mut old = item("在 virlen-app 实现记忆功能。", MEMORY_LEVEL_NORMAL);
        old.summary = "在 virlen-app 实现记忆功能".into();
        store_distilled(&deps(&repo, &settings), "2026-10-04", &[old], &[], 1)
            .await
            .unwrap();

        // 与现有记忆「规范化后相同」（句尾句号 / 多空格）或与同批重复 → 都不再写
        let out = store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[
                item("在 virlen-app 实现记忆功能。", MEMORY_LEVEL_NORMAL),
                item("新的结论", MEMORY_LEVEL_NORMAL),
                item("  新的结论  ", MEMORY_LEVEL_NORMAL),
            ],
            &[],
            2,
        )
        .await
        .unwrap();

        assert_eq!(out.records.len(), 1);
        assert_eq!(out.duplicates, 2);
        assert_eq!(repo.items.lock().unwrap().len(), 2, "库里有 1 条旧的 + 1 条新的");
    }

    #[tokio::test]
    async fn detail_without_knowledge_base_keeps_the_memory() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        let big = DistilledMemory {
            summary: "记忆功能设计要点".into(),
            kind: "decision".into(),
            level: MEMORY_LEVEL_NORMAL.into(),
            tags: vec!["记忆".into()],
            detail_title: Some("设计要点".into()),
            detail_body: Some("详".repeat(500)),
        };
        let out = store_distilled(&deps(&repo, &settings), "2026-10-05", &[big], &[], 1)
            .await
            .unwrap();

        assert_eq!(out.records.len(), 1, "详情失败不牵连条目");
        assert_eq!(out.detail_errors, 1);
        assert_eq!(out.details, 0);
        let stored = repo.items.lock().unwrap().clone();
        assert!(stored[0].detail_doc_id.is_none());
        assert_eq!(stored[0].tags, vec!["记忆".to_string()]);
    }

    #[tokio::test]
    async fn multi_session_material_leaves_source_session_empty() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        let mut second = source(None);
        second.session_id = "s2".into();
        store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[item("跨会话的结论", MEMORY_LEVEL_NORMAL)],
            &[source(None), second],
            1,
        )
        .await
        .unwrap();
        assert!(repo.items.lock().unwrap()[0].source_session_id.is_none());
    }

    #[tokio::test]
    async fn discard_day_only_removes_that_days_distilled_entries() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[item("要重新整理的一条", MEMORY_LEVEL_NORMAL)],
            &[],
            1,
        )
        .await
        .unwrap();
        {
            let mut items = repo.items.lock().unwrap();
            items.push(MemoryRecord {
                id: "u1".into(),
                level: MEMORY_LEVEL_PERMANENT.into(),
                kind: "user".into(),
                summary: "用户手写的".into(),
                source_day: "2026-10-05".into(),
                origin: "user".into(),
                ..Default::default()
            });
        }
        assert_eq!(discard_day(&deps(&repo, &settings), "2026-10-05").await.unwrap(), 1);
        let left = repo.items.lock().unwrap().clone();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "u1");
    }

    #[test]
    fn workspace_label_takes_the_last_segment() {
        assert_eq!(workspace_label("C:\\code\\virlen-app"), "virlen-app");
        assert_eq!(workspace_label("/home/me/proj/"), "proj");
        assert_eq!(workspace_label(""), "");
    }

    // ==================== 近重复合并（P3） ====================

    /// 先落一条蒸馏产出，再拿新的一条去合并
    async fn seed_then_merge(
        seed: DistilledMemory,
        next: DistilledMemory,
    ) -> (StubRepo, StoreOutcome) {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        store_distilled(&deps(&repo, &settings), "2026-10-04", &[seed], &[], 100)
            .await
            .unwrap();
        let out = store_distilled(&deps(&repo, &settings), "2026-10-05", &[next], &[], 200)
            .await
            .unwrap();
        (repo, out)
    }

    #[tokio::test]
    async fn longer_rewording_is_merged_into_the_existing_entry() {
        let (repo, out) = seed_then_merge(
            item("用户要求中文回复", MEMORY_LEVEL_NORMAL),
            item("用户要求中文回复，并且代码注释也用中文", MEMORY_LEVEL_NORMAL),
        )
        .await;

        assert!(out.records.is_empty(), "合并不得再写一条");
        assert_eq!(out.merged, 1);
        assert_eq!(out.duplicates, 0);
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items.len(), 1, "库里仍然只有一条");
        let m = &items[0];
        assert_eq!(m.summary, "用户要求中文回复，并且代码注释也用中文", "取更长的正文");
        assert_eq!(m.created_at, 100, "创建时间不变（永久区注入顺序才能稳定）");
        assert_eq!(m.updated_at, 200, "修改时间刷新");
        assert_eq!(m.source_day, "2026-10-05", "来源日期跟着存活的正文走");
    }

    #[tokio::test]
    async fn shorter_or_equal_new_text_keeps_the_old_one() {
        let (repo, out) = seed_then_merge(
            item("用户要求中文回复，并且代码注释也用中文", MEMORY_LEVEL_NORMAL),
            item("用户要求中文回复", MEMORY_LEVEL_NORMAL),
        )
        .await;
        assert_eq!(out.merged, 1);
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items[0].summary, "用户要求中文回复，并且代码注释也用中文");
        assert_eq!(items[0].source_day, "2026-10-04", "正文没换 → 来源日也不换");
    }

    #[tokio::test]
    async fn user_written_memories_are_never_overwritten() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        {
            let mut items = repo.items.lock().unwrap();
            items.push(MemoryRecord {
                id: "u1".into(),
                level: MEMORY_LEVEL_NORMAL.into(),
                kind: "user".into(),
                summary: "用户要求中文回复".into(),
                origin: "user".into(),
                created_at: 1,
                updated_at: 1,
                ..Default::default()
            });
        }
        let out = store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[item("用户要求中文回复，并且代码注释也用中文", MEMORY_LEVEL_NORMAL)],
            &[],
            200,
        )
        .await
        .unwrap();

        assert_eq!(out.merged, 1, "做了一次合并判定（结论是保留用户的）");
        assert!(out.records.is_empty());
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].summary, "用户要求中文回复", "用户手写的一字不改");
        assert_eq!(items[0].updated_at, 1, "连修改时间都不动");
    }

    #[tokio::test]
    async fn prefix_sharing_but_different_facts_stay_separate() {
        // 词形判定的保守阈值在这里兑现：两条都要在库里
        let (repo, out) = seed_then_merge(
            item("在 virlen-app 实现记忆功能", MEMORY_LEVEL_NORMAL),
            item("在 virlen-app 实现记忆面板", MEMORY_LEVEL_NORMAL),
        )
        .await;
        assert_eq!(out.merged, 0);
        assert_eq!(out.records.len(), 1, "结论不同 → 新增一条");
        assert_eq!(repo.items.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn merge_upgrades_level_and_unions_tags_without_downgrading() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        let mut seed = item("用户偏好中文回复", MEMORY_LEVEL_NORMAL);
        seed.tags = vec!["偏好".into()];
        store_distilled(&deps(&repo, &settings), "2026-10-04", &[seed], &[], 100)
            .await
            .unwrap();

        let mut next = item("用户偏好中文回复，而且讨厌 emoji", MEMORY_LEVEL_PERMANENT);
        next.tags = vec!["偏好".into(), "中文".into()];
        let out = store_distilled(&deps(&repo, &settings), "2026-10-05", &[next], &[], 200)
            .await
            .unwrap();
        assert_eq!(out.merged, 1);
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items[0].level, MEMORY_LEVEL_PERMANENT, "级别只升不降");
        assert_eq!(items[0].tags, vec!["偏好".to_string(), "中文".to_string()]);
    }

    #[tokio::test]
    async fn downgrading_the_level_is_refused_by_merge() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        store_distilled(
            &deps(&repo, &settings),
            "2026-10-04",
            &[item("用户偏好中文回复", MEMORY_LEVEL_PERMANENT)],
            &[],
            100,
        )
        .await
        .unwrap();
        // 今天没再说 permanent：不得把用户升级过的降回普通
        store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[item("用户偏好中文回复，而且讨厌 emoji", MEMORY_LEVEL_NORMAL)],
            &[],
            200,
        )
        .await
        .unwrap();
        assert_eq!(repo.items.lock().unwrap()[0].level, MEMORY_LEVEL_PERMANENT);
    }

    #[tokio::test]
    async fn merge_attaches_a_missing_detail_and_reports_a_failure() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        store_distilled(
            &deps(&repo, &settings),
            "2026-10-04",
            &[item("记忆功能的设计要点", MEMORY_LEVEL_NORMAL)],
            &[],
            100,
        )
        .await
        .unwrap();

        let mut with_detail = item("记忆功能的设计要点（含两级注入与蒸馏）", MEMORY_LEVEL_NORMAL);
        with_detail.detail_title = Some("设计要点".into());
        with_detail.detail_body = Some("详".repeat(500));
        // rag = None → 详情写不进去，但合并照做（降级信号进 detail_errors → 这天记 partial）
        let out = store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[with_detail],
            &[],
            200,
        )
        .await
        .unwrap();
        assert_eq!(out.merged, 1);
        assert_eq!(out.details, 0);
        assert_eq!(out.detail_errors, 1, "合并时详情失败也要记降级");
        let items = repo.items.lock().unwrap().clone();
        assert_eq!(items.len(), 1);
        assert!(items[0].detail_doc_id.is_none());
        assert!(items[0].summary.contains("两级注入"), "正文还是被换成了更长的");
        // 已合并的正文也要进反向去重表：同一句再来一次不能再写一条
        let again = store_distilled(
            &deps(&repo, &settings),
            "2026-10-06",
            &[item("记忆功能的设计要点（含两级注入与蒸馏）", MEMORY_LEVEL_NORMAL)],
            &[],
            300,
        )
        .await
        .unwrap();
        assert_eq!(again.duplicates, 1);
        assert_eq!(repo.items.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn batch_internal_near_duplicates_are_merged_too() {
        // 同一天的两条互为近重复：只能留一条（否则一次入库就能把永久区堵一倍）
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        let out = store_distilled(
            &deps(&repo, &settings),
            "2026-10-05",
            &[
                item("用户要求中文回复", MEMORY_LEVEL_NORMAL),
                item("用户要求中文回复，并且代码注释也用中文", MEMORY_LEVEL_NORMAL),
            ],
            &[],
            100,
        )
        .await
        .unwrap();
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.merged, 1);
        assert_eq!(repo.items.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn best_candidate_wins_when_several_are_similar() {
        let repo = StubRepo::default();
        let settings = NoopSettingsRepo;
        store_distilled(
            &deps(&repo, &settings),
            "2026-10-03",
            &[
                item("用户要求中文回复", MEMORY_LEVEL_NORMAL),
                item("用户要求中文回复，并且提交信息也用中文", MEMORY_LEVEL_NORMAL),
            ],
            &[],
            50,
        )
        .await
        .unwrap();
        // 先把两条合并成一条（长短那条胜出），再确认第三个变体不再新增
        let out = store_distilled(
            &deps(&repo, &settings),
            "2026-10-04",
            &[item("用户要求中文回复，并且提交信息也用中文，注释同理", MEMORY_LEVEL_NORMAL)],
            &[],
            100,
        )
        .await
        .unwrap();
        assert_eq!(out.merged, 1);
        assert_eq!(repo.items.lock().unwrap().len(), 1);
    }
}
