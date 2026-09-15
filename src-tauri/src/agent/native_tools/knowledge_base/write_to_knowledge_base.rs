//! `write_to_knowledge_base` 工具（原生）— 写入文本内容到知识库（自动分块 + 索引）。

use crate::agent::native_tools::common::arg_str;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::rag_service;

pub(crate) async fn write_to_knowledge_base_tool(
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
    let doc_name = arg_str(args, "document_name").unwrap_or_default();
    if doc_name.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"document_name\". Please provide a descriptive name for the document.".to_string(),
            ui_data: None,
        });
    }
    let content = arg_str(args, "content").unwrap_or_default();
    if content.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"content\". Please provide the text content to save.".to_string(),
            ui_data: None,
        });
    }

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let doc_name_c = doc_name.trim().to_string();
    let content_c = content.trim().to_string();
    let doc = tokio::task::spawn_blocking(move || service.add_text_document(&kb_id_c, &doc_name_c, &content_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error writing to knowledge base: {}", e))?;

    Ok(NativeToolOutcome::Value {
        content: format!(
            "Successfully saved \"{}\" to knowledge base (ID: {}). Document ID: {}. The content has been chunked into {} segments and is now available for semantic search.",
            doc.file_name, kb_id, doc.id, doc.chunk_count
        ),
        ui_data: Some(json!({
            "document_id": doc.id,
            "document_name": doc.file_name,
            "knowledge_base_id": kb_id,
            "chunk_count": doc.chunk_count,
        })),
    })
}
