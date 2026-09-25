//! `search_knowledge_base` 工具（原生）— 语义检索指定知识库，返回上下文文本 + 结果 uiData。

use crate::agent::native_tools::common::{arg_i64, arg_str};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{build_search_context, rag_service};

pub(crate) async fn search_knowledge_base_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let query = arg_str(args, "query").unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"query\". Please provide a search query.".to_string(),
            ui_data: None,
        });
    }
    let kb_id = arg_str(args, "knowledge_base_id").unwrap_or_default();
    if kb_id.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"knowledge_base_id\". Use list_knowledge_bases to discover available knowledge bases and their IDs.".to_string(),
            ui_data: None,
        });
    }
    let top_k = arg_i64(args, "top_k").unwrap_or(5).clamp(1, 20) as usize;

    let service = rag_service()?;
    let kb_id_c = kb_id.clone();
    let query_c = query.trim().to_string();
    let results = tokio::task::spawn_blocking(move || service.query(&kb_id_c, &query_c, top_k))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error searching knowledge base: {}", e))?;

    if results.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: format!("No relevant information found in knowledge base \"{}\" for query: \"{}\".", kb_id, query),
            ui_data: Some(json!({ "length": 0, "query": query })),
        });
    }

    let context = build_search_context(&results, &query, &kb_id);
    let ui_results: Vec<Value> = results
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "document_name": r.document_name,
                "document_id": r.document_id,
                "score": r.score,
                "snippet": r.content.chars().take(200).collect::<String>(),
            })
        })
        .collect();

    Ok(NativeToolOutcome::Value {
        content: context,
        ui_data: Some(json!({
            "length": results.len(),
            "results": ui_results,
            "query": query,
            "knowledge_base_id": kb_id,
        })),
    })
}
