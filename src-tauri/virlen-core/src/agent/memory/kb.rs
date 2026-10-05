//! 记忆详情知识库 —— 「重要且庞大」的内容落在**专用知识库**里，记忆条目只留 link（`kb_id` + `doc_id`）
//!
//! 设计要点（沿用 `docs/memory-plan.md` §4.4 / §4.6）：
//! - 库**自动创建**（名 [`MEMORY_KB_NAME`]），用户不需要先手工建库；`kb_id` 缓存在保留设置键
//!   [`MEMORY_KB_SETTING_KEY`]（`__` 前缀 = 保留键，前端 `pickKnownSettings` 会原样带过，不会被当未知键丢掉）。
//! - **缓存失效要能自愈**：用户可能在知识库页里把它删了 —— 此时重新创建（先按名字认领同名库，避免残留数据变成孤儿）。
//! - **RAG 不可用不牵连记忆条目**：详情写不进去时记忆照写，只是没有 link（工具返回里会说明）。
//!
//! ⚠️ 本模块的 `RagService` 调用是**阻塞 I/O**（文件 + 向量索引），因此一律经 `spawn_blocking`
//! 包装后再 await —— 否则会卡住 tokio worker。

use crate::rag::rag_service::RagService;
use crate::session_db::SettingsRepo;
use serde_json::{Map, Value};

/// `kb_id` 缓存键（保留键，见模块头）
pub const MEMORY_KB_SETTING_KEY: &str = "__memoryKbId";

/// 自动创建的知识库名（同时是「缓存失效后按名字认领」的锚点）
pub const MEMORY_KB_NAME: &str = "记忆详情";

/// 自动创建库的说明 —— 用户在知识库列表里能一眼看出它不是手建的
pub const MEMORY_KB_DESCRIPTION: &str =
    "记忆功能自动维护：存放重要记忆的详情正文，记忆条目本身只保留 ≤150 字符的摘要与指向这里的链接。";

/// 从设置快照里取缓存的 `kb_id`（空串 / 类型不对 → `None`）
pub fn cached_kb_id(settings: &Map<String, Value>) -> Option<String> {
    settings
        .get(MEMORY_KB_SETTING_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 取（必要时创建）记忆详情库的 id。
///
/// 三种情形：
/// 1. 缓存命中且库还在 → 直接用；
/// 2. 缓存失效（用户删了库）或未缓存 → 先按名字找同名库（复用，别把已有详情变成孤儿），找到就补缓存；
/// 3. 都没有 → 建库并缓存。
pub async fn ensure_memory_kb(
    settings: &dyn SettingsRepo,
    rag: &'static RagService,
) -> Result<String, String> {
    let all = settings
        .get_all()
        .await
        .map_err(|e| format!("读取配置失败: {}", e))?;
    let cached = cached_kb_id(&all);

    let kbs = tokio::task::spawn_blocking(move || rag.list_knowledge_bases())
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("列出知识库失败: {}", e))?;

    if let Some(id) = cached.as_deref() {
        if kbs.iter().any(|k| k.id == id) {
            return Ok(id.to_string());
        }
    }
    if let Some(found) = kbs.iter().find(|k| k.name == MEMORY_KB_NAME) {
        cache_kb_id(settings, &found.id).await;
        return Ok(found.id.clone());
    }

    let kb = tokio::task::spawn_blocking(move || {
        rag.create_knowledge_base(MEMORY_KB_NAME, MEMORY_KB_DESCRIPTION)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("创建记忆详情知识库失败: {}", e))?;
    cache_kb_id(settings, &kb.id).await;
    Ok(kb.id)
}

/// 补写 `kb_id` 缓存 —— 失败**不算错误**（下次照样能按名字认领，功能不受影响）
async fn cache_kb_id(settings: &dyn SettingsRepo, kb_id: &str) {
    let mut map = Map::new();
    map.insert(
        MEMORY_KB_SETTING_KEY.to_string(),
        Value::String(kb_id.to_string()),
    );
    if let Err(e) = settings.upsert(map).await {
        eprintln!("[memory] 缓存记忆知识库 id 失败（不影响功能）: {}", e);
    }
}

/// 写详情正文 → 返回文档 id（文档名取摘要前缀，便于用户在知识库里认出来）
pub async fn store_detail(
    rag: &'static RagService,
    kb_id: String,
    doc_name: String,
    content: String,
) -> Result<String, String> {
    let doc = tokio::task::spawn_blocking(move || {
        rag.add_text_document(&kb_id, &doc_name, &content)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| format!("写入记忆详情失败: {}", e))?;
    Ok(doc.id)
}

/// 读详情正文
pub async fn read_detail(
    rag: &'static RagService,
    kb_id: String,
    doc_id: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || rag.get_document_content(&kb_id, &doc_id))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("读取记忆详情失败: {}", e))
}

/// 删除详情文档（「重新整理某天」清掉旧条目时用；失败不算致命 —— 孤儿文档可以手动删）
pub async fn remove_detail(
    rag: &'static RagService,
    kb_id: String,
    doc_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || rag.remove_document(&kb_id, &doc_id))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("删除记忆详情失败: {}", e))
}

/// 文档名：`记忆详情` 前缀 + 摘要（≤40 字符），让知识库列表里可读
pub fn detail_doc_name(summary: &str) -> String {
    let head: String = summary.chars().take(40).collect();
    if head.is_empty() {
        "记忆详情".to_string()
    } else {
        format!("记忆详情：{}", head)
    }
}
