//! 记忆**删除**（本模块唯一的职责）：删掉一条记忆条目，并把它的详情正文一并从「记忆详情」知识库删掉。
//!
//! 为什么连详情一起删：详情正文是一整段文档，条目只是指向它的 link。只删条目 = 在知识库里留下一份
//! **永远不会被引用**的正文，用户清理记忆时会越积越多（面板的批量删除会把这个洞放得更大）。
//!
//! 三条口径：
//! - **先取快照再删行**：删完行就不知道该删哪个文档了；
//! - 详情删失败**不算失败**（记忆条目确实已经没了，孤儿文档可以在知识库页手动删），
//!   但**如实回传** `detail_removed = Some(false)`，不假装删干净了；
//! - `None` 与 `Some(false)` 必须分得开：「本来就没有详情」和「有详情但没删掉」是两回事。

use crate::agent::memory::kb;
use crate::rag::rag_service::RagService;
use crate::session_db::MemoryRepo;

/// 删一条记忆的结果（面板单条 / 批量删除共用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetOutcome {
    /// 是否真的删到了行（id 不存在 → `false`）
    pub removed: bool,
    /// 详情文档的处置：`None` = 这条本来就没有详情；`Some(true)` = 一并删掉了；
    /// `Some(false)` = **没删掉**（RAG 不可用 / 删除失败）—— 会留下孤儿文档，调用方应记录
    pub detail_removed: Option<bool>,
}

/// 删一条记忆，并把它的详情文档一并从「记忆详情」知识库删掉。
pub async fn forget_memory(
    memory: &dyn MemoryRepo,
    rag: Option<&'static RagService>,
    id: &str,
) -> Result<ForgetOutcome, String> {
    let record = memory.get(id).await?;
    if !memory.delete(id).await? {
        return Ok(ForgetOutcome {
            removed: false,
            detail_removed: None,
        });
    }
    let details = record
        .as_ref()
        .and_then(|r| r.detail_kb_id.clone().zip(r.detail_doc_id.clone()));
    let Some((kb_id, doc_id)) = details else {
        return Ok(ForgetOutcome {
            removed: true,
            detail_removed: None,
        });
    };
    let Some(rag) = rag else {
        // 知识库不可用：详情文档还在库里，不能当成「没有详情」
        eprintln!(
            "[memory] 知识库不可用，记忆详情文档未删除（可在知识库页手动删）: {}",
            doc_id
        );
        return Ok(ForgetOutcome {
            removed: true,
            detail_removed: Some(false),
        });
    };
    let detail_removed = match kb::remove_detail(rag, kb_id, doc_id.clone()).await {
        Ok(()) => true,
        Err(e) => {
            eprintln!(
                "[memory] 删除记忆详情文档失败（可在知识库页手动删）: {}",
                e
            );
            false
        }
    };
    Ok(ForgetOutcome {
        removed: true,
        detail_removed: Some(detail_removed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_db::MemoryRecord;
    use async_trait::async_trait;
    use std::sync::Mutex;

    /// 内存版仓储：只实现删一条路径用到的方法
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
            Ok(Vec::new())
        }
        async fn upsert(&self, record: &MemoryRecord) -> Result<(), String> {
            // 与真实仓储同语义：**按 id 覆盖**
            let mut items = self.items.lock().unwrap();
            match items.iter_mut().find(|m| m.id == record.id) {
                Some(slot) => *slot = record.clone(),
                None => items.push(record.clone()),
            }
            Ok(())
        }
        async fn delete(&self, id: &str) -> Result<bool, String> {
            // 与真实仓储同语义：删到才返回 `true`（`forget_memory` 靠这个返回值判「有没有删到」）
            let mut items = self.items.lock().unwrap();
            let before = items.len();
            items.retain(|m| m.id != id);
            Ok(items.len() < before)
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
    }

    /// 有详情但 RAG 不可用：记忆条目删掉了，但**不能假装详情也删干净了**
    /// （`Some(false)` 是要上报的事实，不是错误路径）
    #[tokio::test]
    async fn forget_reports_unremoved_detail_when_rag_is_missing() {
        let repo = StubRepo::default();
        repo.items.lock().unwrap().push(MemoryRecord {
            id: "m_1".into(),
            detail_kb_id: Some("kb_1".into()),
            detail_doc_id: Some("doc_1".into()),
            ..Default::default()
        });

        let out = forget_memory(&repo, None, "m_1").await.unwrap();
        assert!(out.removed);
        assert_eq!(out.detail_removed, Some(false));
        assert!(repo.items.lock().unwrap().is_empty(), "条目本身该已删除");
    }

    /// 本来就没有详情：`None`（与「有详情但删失败」必须区分得开）
    #[tokio::test]
    async fn forget_without_detail_reports_none() {
        let repo = StubRepo::default();
        repo.items.lock().unwrap().push(MemoryRecord {
            id: "m_1".into(),
            ..Default::default()
        });

        let out = forget_memory(&repo, None, "m_1").await.unwrap();
        assert!(out.removed);
        assert_eq!(out.detail_removed, None);
    }

    /// id 不存在：`removed = false`，不报错也不去惊动知识库
    #[tokio::test]
    async fn forget_missing_id_is_a_noop() {
        let repo = StubRepo::default();
        let out = forget_memory(&repo, None, "m_nope").await.unwrap();
        assert!(!out.removed);
        assert_eq!(out.detail_removed, None);
    }
}
