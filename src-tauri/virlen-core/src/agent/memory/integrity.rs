//! 记忆详情正文的**引用完整性自检**
//!
//! 「记忆条目 → 详情正文」是跨两个存储的引用：摘要与会话一样躺在 `virlen.db` 的 `memories` 表，
//! 正文是**知识库里的一篇文档**（`detail_kb_id` + `detail_doc_id`）。两处各自都会正常返回成功，
//! 于是任何一种断链都**静默**：
//!
//! | 现象 | 成因 | 后果 |
//! |---|---|---|
//! | 孤儿正文（[`OrphanDetail`]） | 记忆被删而正文没删掉（`forget_memory` 里 RAG 不可用 / 删失败）、知识库被拷回旧备份、再蒸馏中途失败 | 知识库越用越大，且检索时会被当成普通文档召回 —— 模型看到一段无主的长文 |
//! | 断链（[`DanglingLink`]） | 用户在知识库页删了正文（老版本还没有护栏）、换机 / 恢复备份后 `kb_id` 变了、库被重建 | 记忆「说有详情」但 `memory_recall` 读不到，模型只能看到摘要 |
//!
//! 这两类都无法在写入那一刻发现（写的时候两边都是好的），只能**主动核验**。本模块只做只读核验；
//! 清理是显式动作（[`purge_orphans`]）—— 自检绝不自己删东西：
//! 「孤儿」判断错一次就是永久丢正文，而这个判断依赖 RAG 当前列出的文档列表。
//! 清理也只动名字带 [`kb::DETAIL_DOC_NAME_PREFIX`] 前缀的那些（用户往这个库里手导的文档
//! 同样「没被引用」，但不是记忆的残留）。
//!
//! ## 口径
//!
//! - 引用有效性只看 [`crate::agent::memory::detail_link`]（两半都非空才算），与渲染、召回同一份判定；
//! - **停用的记忆也算持有引用**：归档成「改前版」的条目照样能被 `memory_recall` 读，正文当然不能算孤儿；
//! - 指向**别的知识库**的链接按断链报（`reason = "kb-mismatch"`），而不是孤儿 ——
//!   正文可能好端端躺在另一个库里，这里看不到，也就没有资格删。

use std::collections::HashMap;

use serde::Serialize;

use crate::agent::memory::{detail_link, kb};
use crate::rag::rag_service::RagService;
use crate::session_db::{MemoryRecord, SettingsRepo};

/// 知识库里的一篇文档（把 RAG 的 `DocumentInfo` 归一成自检需要的两列，便于纯函数单测）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailDoc {
    pub id: String,
    pub name: String,
}

/// 孤儿正文：在记忆详情库里、但没有任何记忆引用它
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDetail {
    pub doc_id: String,
    pub doc_name: String,
    /// 文档名带 [`kb::DETAIL_DOC_NAME_PREFIX`] 前缀 = 确实像「记忆详情」的正文（可安全清理）。
    ///
    /// `false` 的是「记忆详情库里的其它文档」（用户手动导入的）—— 它们同样没被引用，
    /// 但不是记忆的残留，`purge_orphans` **不会**删，需要人来判断。
    pub looks_like_detail: bool,
}

/// 断链：记忆的详情链接指向一个读不到的文档
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DanglingLink {
    pub memory_id: String,
    /// 记忆正文（摘要）：界面要能让用户认出是哪条，**不进埋点**
    pub summary: String,
    pub kb_id: String,
    pub doc_id: String,
    /// `"doc-missing"`（库还在，文档没了）/ `"kb-mismatch"`（指向别的知识库，或那个库已不在）
    pub reason: String,
    /// 该条目是否已停用（停用的仍能被 `memory_recall` 读到，所以同样算断链）
    pub disabled: bool,
}

/// 自检报告
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryIntegrityReport {
    /// 当前认定的「记忆详情」知识库 id（找不到就是 `None`）
    pub kb_id: Option<String>,
    /// RAG 是否可用（不可用 = 本次无法核验知识库侧，报告不代表「干净」）
    pub kb_available: bool,
    /// 参与核验的记忆条数（含停用）
    pub checked_memories: usize,
    /// 参与核验的知识库文档数
    pub checked_docs: usize,
    pub orphans: Vec<OrphanDetail>,
    pub dangling: Vec<DanglingLink>,
}

impl MemoryIntegrityReport {
    /// 没有发现问题（且确实核验过知识库侧）
    pub fn is_clean(&self) -> bool {
        self.kb_available && self.orphans.is_empty() && self.dangling.is_empty()
    }

    /// 一句人话（日志 / CLI / 界面提示共用，避免三处各写一套判断）
    pub fn summary(&self) -> String {
        if !self.kb_available {
            return "记忆详情知识库不可用，本次未能核验".to_string();
        }
        if self.is_clean() {
            return format!(
                "记忆详情引用完整（{} 条记忆 / {} 篇正文）",
                self.checked_memories, self.checked_docs
            );
        }
        format!(
            "记忆详情有 {} 篇孤儿正文、{} 条断链（{} 条记忆 / {} 篇正文）",
            self.orphans.len(),
            self.dangling.len(),
            self.checked_memories,
            self.checked_docs
        )
    }
}

/// 纯核验：给一批记忆与「记忆详情库当前有哪些文档」，算出孤儿与断链
///
/// `kb_id` 是**当前**认定的记忆详情库（空串 = 不知道 / 没有）：
/// 空串时所有带链接的条目都按 `kb-mismatch` 报 —— 那种情况下一条正文都不该被当成孤儿。
pub fn inspect(
    records: &[MemoryRecord],
    kb_id: &str,
    docs: &[DetailDoc],
) -> (Vec<OrphanDetail>, Vec<DanglingLink>) {
    let kb_id = kb_id.trim();
    let known: HashMap<&str, &DetailDoc> = docs.iter().map(|d| (d.id.as_str(), d)).collect();

    // 被引用的文档 id（**只算指向当前库的引用**：指向别的库的链接不能替这个库的文档「免责」）
    let mut referenced: HashMap<&str, &MemoryRecord> = HashMap::new();
    let mut dangling: Vec<DanglingLink> = Vec::new();
    for record in records {
        let Some((link_kb, link_doc)) = detail_link(record) else {
            continue;
        };
        let to_kb = !kb_id.is_empty() && link_kb.trim() == kb_id;
        if to_kb {
            referenced.insert(link_doc, record);
            if !known.contains_key(link_doc) {
                dangling.push(DanglingLink {
                    memory_id: record.id.clone(),
                    summary: record.summary.clone(),
                    kb_id: link_kb.trim().to_string(),
                    doc_id: link_doc.to_string(),
                    reason: "doc-missing".to_string(),
                    disabled: record.disabled,
                });
            }
        } else {
            dangling.push(DanglingLink {
                memory_id: record.id.clone(),
                summary: record.summary.clone(),
                kb_id: link_kb.trim().to_string(),
                doc_id: link_doc.to_string(),
                reason: "kb-mismatch".to_string(),
                disabled: record.disabled,
            });
        }
    }

    let mut orphans: Vec<OrphanDetail> = docs
        .iter()
        .filter(|doc| !referenced.contains_key(doc.id.as_str()))
        .map(|doc| OrphanDetail {
            doc_id: doc.id.clone(),
            doc_name: doc.name.clone(),
            looks_like_detail: is_detail_doc_name(&doc.name),
        })
        .collect();

    // 全序：同一份输入永远同一份报告（测试与界面都不会抖动）
    orphans.sort_by(|a, b| a.doc_id.cmp(&b.doc_id));
    dangling.sort_by(|a, b| {
        a.memory_id
            .cmp(&b.memory_id)
            .then_with(|| a.doc_id.cmp(&b.doc_id))
    });

    (orphans, dangling)
}

/// 核验一次（只读）
///
/// 拿 `kb_id` 的顺序与 [`kb::ensure_memory_kb`] 一致（缓存 → 按名字认领），但**不创建**：
/// 自检不该产生副作用（一个空库被「检查」出来，本身就是噪声）。
pub async fn check(
    settings: &dyn SettingsRepo,
    records: &[MemoryRecord],
    rag: Option<&'static RagService>,
) -> MemoryIntegrityReport {
    let mut report = MemoryIntegrityReport {
        kb_available: rag.is_some(),
        checked_memories: records.len(),
        ..Default::default()
    };
    let Some(rag) = rag else {
        return report;
    };

    // ① 认定记忆详情库（缓存 → 同名认领）
    let cached = settings
        .get_all()
        .await
        .ok()
        .and_then(|all| kb::cached_kb_id(&all));
    let kbs = match tokio::task::spawn_blocking(move || rag.list_knowledge_bases()).await {
        Ok(Ok(list)) => list,
        _ => {
            // 列不出来 = 知识库侧这次核不了，别把「没检查」说成「干净」
            report.kb_available = false;
            return report;
        }
    };
    let found = cached
        .as_deref()
        .and_then(|id| kbs.iter().find(|k| k.id == id))
        .or_else(|| kbs.iter().find(|k| k.name == kb::MEMORY_KB_NAME));
    let Some(found) = found else {
        // 连库都没有：带链接的条目都是断链，且没有任何文档可报孤儿
        let (orphans, dangling) = inspect(records, "", &[]);
        report.orphans = orphans;
        report.dangling = dangling;
        return report;
    };
    let kb_id = found.id.clone();
    report.kb_id = Some(kb_id.clone());

    // ② 列该库的文档
    let docs = match tokio::task::spawn_blocking({
        let kb_id = kb_id.clone();
        move || rag.list_documents(&kb_id)
    })
    .await
    {
        Ok(Ok(list)) => list,
        _ => {
            report.kb_available = false;
            return report;
        }
    };
    let docs: Vec<DetailDoc> = docs
        .into_iter()
        .map(|d| DetailDoc {
            id: d.id,
            name: d.file_name,
        })
        .collect();
    report.checked_docs = docs.len();

    // ③ 纯核验
    let (orphans, dangling) = inspect(records, &kb_id, &docs);
    report.orphans = orphans;
    report.dangling = dangling;
    report
}

/// 文档名看起来是「记忆详情」的正文？（见 [`kb::DETAIL_DOC_NAME_PREFIX`]）
pub fn is_detail_doc_name(name: &str) -> bool {
    name.trim_start().starts_with(kb::DETAIL_DOC_NAME_PREFIX)
}

/// 删除孤儿正文（**显式动作**，不进自检默认流程）；返回 `(删除成功, 失败, 跳过)`
///
/// 两条例外，都是为了不误删别人的东西：
/// - 名字不带 `记忆详情` 前缀的（用户往这个库里手导的文档）—— 同样没被引用，但不是记忆的残留，
///   交给人判断；
/// - 逐篇删：一篇删不掉不该挡住其它篇（`remove_document` 会重写索引与文档清单）。
pub async fn purge_orphans(
    rag: &'static RagService,
    kb_id: &str,
    orphans: &[OrphanDetail],
) -> (usize, usize, usize) {
    let mut removed = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    for orphan in orphans {
        if !orphan.looks_like_detail {
            skipped += 1;
            continue;
        }
        let kb_id = kb_id.to_string();
        let doc_id = orphan.doc_id.clone();
        let result =
            tokio::task::spawn_blocking(move || rag.remove_document(&kb_id, &doc_id)).await;
        match result {
            Ok(Ok(())) => removed += 1,
            _ => failed += 1,
        }
    }
    (removed, failed, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, summary: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: "normal".into(),
            kind: "decision".into(),
            summary: summary.into(),
            created_at: 1,
            ..Default::default()
        }
    }

    fn with_link(mut m: MemoryRecord, kb: &str, doc: &str) -> MemoryRecord {
        m.detail_kb_id = Some(kb.into());
        m.detail_doc_id = Some(doc.into());
        m
    }

    fn doc(id: &str, name: &str) -> DetailDoc {
        DetailDoc {
            id: id.into(),
            name: name.into(),
        }
    }

    /// 正常态：每个引用都命中，每篇文档都被引用 → 两项都空
    #[test]
    fn healthy_state_reports_nothing() {
        let records = [
            with_link(rec("m1", "有正文的决策"), "kb_mem", "d1"),
            rec("m2", "没正文的事实"),
        ];
        let docs = [doc("d1", "记忆详情：有正文的决策")];
        let (orphans, dangling) = inspect(&records, "kb_mem", &docs);
        assert!(orphans.is_empty());
        assert!(dangling.is_empty());
    }

    /// 记忆删了但正文还在 → 孤儿（且不报断链）
    #[test]
    fn unreferenced_document_is_an_orphan() {
        let records = [rec("m1", "已经删掉的那条")];
        let docs = [
            doc("d1", "记忆详情：已经删掉的那条"),
            doc("d2", "记忆详情：早先失败的整理"),
        ];
        let (orphans, dangling) = inspect(&records, "kb_mem", &docs);
        assert_eq!(
            orphans
                .iter()
                .map(|o| o.doc_id.as_str())
                .collect::<Vec<_>>(),
            vec!["d1", "d2"]
        );
        assert!(dangling.is_empty());
    }

    /// 孤儿分两类：像记忆详情的正文（可安全清理）与用户自己手导进这个库的文档（只报告、不删）
    #[test]
    fn orphan_flags_whether_it_looks_like_a_memory_detail() {
        let docs = [
            doc("d1", "记忆详情：项目用 pnpm 构建"),
            doc("d2", "公司制度.pdf"),
        ];
        let (orphans, _) = inspect(&[], "kb_mem", &docs);
        assert_eq!(orphans.len(), 2);
        let by_id = |id: &str| orphans.iter().find(|o| o.doc_id == id).unwrap();
        assert!(by_id("d1").looks_like_detail, "带前缀 = 记忆的正文");
        assert!(
            !by_id("d2").looks_like_detail,
            "用户手导的文档不能被 --purge 静默删掉"
        );

        // 前缀判定与 `detail_doc_name` 同源（摘要为空时是前缀本身，也认）
        assert!(is_detail_doc_name(&kb::detail_doc_name("")));
        assert!(is_detail_doc_name(&kb::detail_doc_name("某条决策")));
        assert!(!is_detail_doc_name("memory.md"));
    }

    /// 记忆说有正文、正文没了 → 断链（`doc-missing`），且不算孤儿
    #[test]
    fn missing_document_is_a_dangling_link() {
        let records = [with_link(rec("m1", "正文被删了"), "kb_mem", "d_gone")];
        let (orphans, dangling) = inspect(&records, "kb_mem", &[]);
        assert!(orphans.is_empty());
        assert_eq!(dangling.len(), 1);
        assert_eq!(dangling[0].memory_id, "m1");
        assert_eq!(dangling[0].reason, "doc-missing");
        assert_eq!(dangling[0].summary, "正文被删了");
    }

    /// 停用的条目**照样持有**引用：它的正文不是孤儿（归档的「改前版」还能被 recall 读）
    #[test]
    fn disabled_memory_still_holds_its_reference() {
        let mut archived = with_link(rec("m_old", "被顶替的旧版"), "kb_mem", "d1");
        archived.disabled = true;
        archived.superseded_by = Some("m_new".into());
        let docs = [doc("d1", "记忆详情：被顶替的旧版")];
        let (orphans, dangling) = inspect(&[archived], "kb_mem", &docs);
        assert!(orphans.is_empty(), "停用 ≠ 没引用：正文不能当孤儿删掉");
        assert!(dangling.is_empty());
    }

    /// 指向别的知识库（换机 / 库被重建后的旧 kb_id）→ `kb-mismatch`，且不能替本库文档免责
    #[test]
    fn link_to_another_kb_is_a_mismatch_not_an_orphan() {
        let records = [
            with_link(rec("m1", "旧的库链接"), "kb_old", "d1"),
            with_link(rec("m2", "本库的链接"), "kb_mem", "d2"),
        ];
        let docs = [
            doc("d1", "同一个 doc id 但在本库里"),
            doc("d2", "本库的另一篇"),
        ];
        let (orphans, dangling) = inspect(&records, "kb_mem", &docs);

        assert_eq!(dangling.len(), 1);
        assert_eq!(dangling[0].memory_id, "m1");
        assert_eq!(dangling[0].reason, "kb-mismatch");

        // d1 在本库里**没有**被本库的引用指着 → 是孤儿（别的库的链接不能替它免责）
        assert_eq!(
            orphans
                .iter()
                .map(|o| o.doc_id.as_str())
                .collect::<Vec<_>>(),
            vec!["d1"]
        );
    }

    /// 半截链接（只有一半）不算引用，也不算断链（与 `detail_link` 同口径）
    #[test]
    fn half_links_are_ignored_entirely() {
        let mut half = rec("m1", "只有一半链接");
        half.detail_kb_id = Some("kb_mem".into());
        half.detail_doc_id = None;
        let mut blank = rec("m2", "空串链接");
        blank.detail_kb_id = Some("  ".into());
        blank.detail_doc_id = Some("d1".into());

        let docs = [doc("d1", "本库里的一篇")];
        let (orphans, dangling) = inspect(&[half, blank], "kb_mem", &docs);
        assert!(dangling.is_empty(), "半截链接不该被当成断链");
        assert_eq!(orphans.len(), 1, "它也就不能替 d1 免责");
    }

    /// 找不到记忆详情库（kb_id 空）：带链接的条目全算断链，不报任何孤儿
    #[test]
    fn unknown_kb_reports_links_as_mismatch_and_no_orphans() {
        let records = [with_link(rec("m1", "谁的正文？"), "kb_mem", "d1")];
        let (orphans, dangling) = inspect(&records, "", &[]);
        assert!(orphans.is_empty(), "不知道是哪个库时没有资格判定孤儿");
        assert_eq!(dangling.len(), 1);
        assert_eq!(dangling[0].reason, "kb-mismatch");
    }

    /// 报告的全序 + 人话摘要
    #[test]
    fn report_is_ordered_and_summarized() {
        let records = [
            with_link(rec("m_b", "B 断链"), "kb_mem", "d_missing"),
            with_link(rec("m_a", "A 断链"), "kb_mem", "d_missing2"),
        ];
        let docs = [doc("d_z", "孤儿乙"), doc("d_a", "孤儿甲")];
        let (orphans, dangling) = inspect(&records, "kb_mem", &docs);
        assert_eq!(
            orphans
                .iter()
                .map(|o| o.doc_id.as_str())
                .collect::<Vec<_>>(),
            vec!["d_a", "d_z"],
            "孤儿按 doc_id 升序（全序，报告不抖动）"
        );
        assert_eq!(
            dangling
                .iter()
                .map(|d| d.memory_id.as_str())
                .collect::<Vec<_>>(),
            vec!["m_a", "m_b"]
        );

        let report = MemoryIntegrityReport {
            kb_id: Some("kb_mem".into()),
            kb_available: true,
            checked_memories: records.len(),
            checked_docs: docs.len(),
            orphans,
            dangling,
        };
        assert!(!report.is_clean());
        assert!(report.summary().contains("2 篇孤儿正文"));
        assert!(report.summary().contains("2 条断链"));

        // 核验不了的时候不许说「干净」
        let unavailable = MemoryIntegrityReport {
            kb_available: false,
            ..Default::default()
        };
        assert!(!unavailable.is_clean());
        assert!(unavailable.summary().contains("未能核验"));
    }
}
