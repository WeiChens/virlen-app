//! knowledge_base — 知识库分类（分类 id: knowledge_base）
//!
//! 一个工具一个文件（6 个）：
//! `search_knowledge_base` / `list_knowledge_bases` / `list_knowledge_base_documents`
//! / `get_knowledge_base_document` / `delete_knowledge_base_document` / `write_to_knowledge_base`
//!
//! `common.rs` 为分类内公共：RAG 服务入口 `rag_service`、检索结果 → 上下文文本
//! `build_search_context`。

mod common;
mod delete_knowledge_base_document;
mod get_knowledge_base_document;
mod list_knowledge_base_documents;
mod list_knowledge_bases;
mod search_knowledge_base;
mod write_to_knowledge_base;

pub(crate) use delete_knowledge_base_document::delete_knowledge_base_document_tool;
pub(crate) use get_knowledge_base_document::get_knowledge_base_document_tool;
pub(crate) use list_knowledge_base_documents::list_knowledge_base_documents_tool;
pub(crate) use list_knowledge_bases::list_knowledge_bases_tool;
pub(crate) use search_knowledge_base::search_knowledge_base_tool;
pub(crate) use write_to_knowledge_base::write_to_knowledge_base_tool;
