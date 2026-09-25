//! `get_knowledge_base_document` 工具（原生）— 取指定文档的完整正文。

use crate::agent::native_tools::common::arg_str;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::rag_service;

pub(crate) async fn get_knowledge_base_document_tool(
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
    let doc_id = arg_str(args, "document_id").unwrap_or_default();
    if doc_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"document_id\". Use list_knowledge_base_documents to find document IDs.".to_string(),
            ui_data: None,
        });
    }

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let doc_id_c = doc_id.clone();
    let content = tokio::task::spawn_blocking(move || service.get_document_content(&kb_id_c, &doc_id_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error retrieving document: {}", e))?;

    Ok(NativeToolOutcome::Value {
        content: format!("Full content of document \"{}\" from knowledge base (ID: {}):\n\n---\n{}\n---", doc_id, kb_id, content),
        ui_data: Some(json!({ "document_id": doc_id, "knowledge_base_id": kb_id })),
    })
}
