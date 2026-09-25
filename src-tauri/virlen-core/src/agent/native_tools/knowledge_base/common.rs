//! knowledge_base — 知识库分类公共函数（分类 id: knowledge_base）
//!
//! 供本分类下的 6 个工具复用。

/// 调用 RAG 服务的阻塞任务包装
pub(super) fn rag_service() -> Result<&'static crate::rag::rag_service::RagService, String> {
    crate::rag::get_service()
}

/// 检索结果 → 供模型阅读的上下文文本（含文档 ID，便于后续 delete/edit）
pub(super) fn build_search_context(
    results: &[crate::rag::vector_store::ChunkResult],
    query: &str,
    kb_id: &str,
) -> String {
    let mut lines = vec![
        format!("Search results from knowledge base \"{}\" for query: \"{}\"", kb_id, query),
        String::new(),
    ];
    for (i, r) in results.iter().enumerate() {
        lines.push(format!("[{}] Document: {}", i + 1, r.document_name));
        lines.push(format!("    Document ID: {}", r.document_id));
        lines.push(format!("    Similarity: {:.1}%", r.score * 100.0));
        lines.push(format!("    Content: {}", r.content));
        lines.push(String::new());
    }
    lines.push("---".to_string());
    lines.push("To delete or edit a document, use its Document ID above.".to_string());
    lines.join("\n")
}
