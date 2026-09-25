//! `list_knowledge_bases` 工具（原生）— 列出全部知识库（含文档数/分块数与部分文档标题）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::rag_service;

pub(crate) async fn list_knowledge_bases_tool(
    _ctx: &NativeToolCtx<'_>,
    _args: &Value,
) -> Result<NativeToolOutcome, String> {
    let service = rag_service()?;
    let kbs = tokio::task::spawn_blocking(move || service.list_knowledge_bases())
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error listing knowledge bases: {}", e))?;

    if kbs.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "No knowledge bases found. Create a knowledge base first and upload documents to it, or use write_to_knowledge_base to create new content.".to_string(),
            ui_data: Some(json!({ "length": 0 })),
        });
    }

    let mut lines = vec![format!("📚 Available Knowledge Bases ({} total):", kbs.len()), String::new()];
    let mut ui_kbs: Vec<Value> = Vec::new();

    for (i, kb) in kbs.iter().enumerate() {
        // 每个知识库列出最多 20 个文档标题
        let docs = service.list_documents(&kb.id).unwrap_or_default();
        let doc_titles: Vec<String> = docs.iter().take(20).map(|d| d.file_name.clone()).collect();

        lines.push(format!("[{}] {}", i + 1, kb.name));
        lines.push(format!("    ID: {}", kb.id));
        lines.push(format!("    Description: {}", if kb.description.is_empty() { "No description".to_string() } else { kb.description.clone() }));
        lines.push(format!("    Documents: {}", kb.document_count));
        lines.push(format!("    Chunks: {}", kb.chunk_count));
        if !doc_titles.is_empty() {
            lines.push(format!("    Document titles (showing {} of {}):", doc_titles.len(), kb.document_count));
            for (idx, title) in doc_titles.iter().enumerate() {
                lines.push(format!("      {}. {}", idx + 1, title));
            }
        }
        lines.push(String::new());

        ui_kbs.push(json!({
            "id": kb.id,
            "name": kb.name,
            "description": kb.description,
            "documentCount": kb.document_count,
        }));
    }

    lines.push("---".to_string());
    lines.push("Use list_knowledge_base_documents with the knowledge_base_id to see all documents and their IDs.".to_string());
    lines.push("Use search_knowledge_base with the knowledge_base_id to search within a specific knowledge base.".to_string());
    lines.push("Use write_to_knowledge_base with the knowledge_base_id to save new content.".to_string());

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n"),
        ui_data: Some(json!({ "length": kbs.len(), "knowledgeBases": ui_kbs })),
    })
}
