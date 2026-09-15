//! `list_knowledge_base_documents` 工具（原生）— 列出知识库内全部文档（ID/类型/分块数/状态）。

use crate::agent::native_tools::common::arg_str;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::rag_service;

pub(crate) async fn list_knowledge_base_documents_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let kb_id = arg_str(args, "knowledge_base_id").unwrap_or_default();
    if kb_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"knowledge_base_id\". Use list_knowledge_bases to discover available knowledge bases.".to_string(),
            ui_data: None,
        });
    }

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let docs = tokio::task::spawn_blocking(move || service.list_documents(&kb_id_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error listing documents: {}", e))?;

    if docs.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: format!("No documents found in knowledge base \"{}\". Use write_to_knowledge_base to create new content, or upload documents through the UI.", kb_id),
            ui_data: Some(json!({ "length": 0, "knowledge_base_id": kb_id })),
        });
    }

    let mut lines = vec![format!("📄 Documents in knowledge base \"{}\" ({} total):", kb_id, docs.len()), String::new()];
    let mut ui_docs: Vec<Value> = Vec::new();

    for (i, d) in docs.iter().enumerate() {
        lines.push(format!("[{}] {}", i + 1, d.file_name));
        lines.push(format!("    Document ID: {}", d.id));
        lines.push(format!("    Type: {}", d.file_type));
        lines.push(format!("    Chunks: {}", d.chunk_count));
        lines.push(format!("    Status: {}", d.status));
        lines.push(String::new());

        ui_docs.push(json!({
            "id": d.id,
            "file_name": d.file_name,
            "file_type": d.file_type,
            "chunk_count": d.chunk_count,
            "status": d.status,
        }));
    }

    lines.push("---".to_string());
    lines.push("Use search_knowledge_base to search within this knowledge base.".to_string());
    lines.push("Use delete_knowledge_base_document with a Document ID to remove it.".to_string());

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n"),
        ui_data: Some(json!({ "length": docs.len(), "knowledge_base_id": kb_id, "documents": ui_docs })),
    })
}
