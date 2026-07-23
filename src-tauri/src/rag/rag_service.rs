//! RAG 检索服务
//!
//! 协调文档解析、嵌入生成、向量存储和检索的完整流程。

use crate::rag::document::{self};
use crate::rag::embedding::EmbeddingProvider;
use crate::rag::vector_store::{ChunkResult, DocumentInfo, KnowledgeBaseMeta, VectorStoreManager};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::RwLock;

/// 最大单个文档大小（50MB），超过此大小则拒绝处理，防止嵌入过久导致超时
const MAX_DOC_SIZE_BYTES: u64 = 50 * 1024 * 1024;

/// RAG 服务
pub struct RagService {
    store_manager: RwLock<VectorStoreManager>,
}

impl RagService {
    /// 创建新的 RAG 服务
    pub fn new(data_dir: PathBuf, embedding_provider: Arc<dyn EmbeddingProvider>) -> Result<Self, String> {
        let mut manager = VectorStoreManager::new(data_dir, embedding_provider);
        manager.init()?;

        Ok(Self {
            store_manager: RwLock::new(manager),
        })
    }

    // ===== 知识库管理 =====

    /// 创建知识库（写操作）
    pub fn create_knowledge_base(
        &self,
        name: &str,
        description: &str,
    ) -> Result<KnowledgeBaseMeta, String> {
        let mgr = self.store_manager.write().map_err(|e| format!("获取写锁失败: {}", e))?;
        mgr.create_knowledge_base(name, description)
    }

    /// 列出所有知识库（读操作，可并发）
    pub fn list_knowledge_bases(&self) -> Result<Vec<KnowledgeBaseMeta>, String> {
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;
        mgr.list_knowledge_bases()
    }

    /// 获取单个知识库（读操作，可并发）
    /// 当前未被前端直接调用，保留供后续功能扩展使用
    #[allow(dead_code)]
    pub fn get_knowledge_base(&self, kb_id: &str) -> Result<KnowledgeBaseMeta, String> {
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;
        mgr.get_knowledge_base(kb_id)
    }

    /// 删除知识库（写操作）
    pub fn delete_knowledge_base(&self, kb_id: &str) -> Result<(), String> {
        let mut mgr = self.store_manager.write().map_err(|e| format!("获取写锁失败: {}", e))?;
        mgr.delete_knowledge_base(kb_id)
    }

    // ===== 文档管理 =====

    /// 添加文档到知识库
    ///
    /// 流程：解析文件 → 分块 → 嵌入 → 存储
    ///
    /// ⚠️ 单个文档超过 50MB 时会拒绝处理，防止嵌入耗时过长导致超时。
    pub fn add_document(&self, kb_id: &str, file_path: &str) -> Result<DocumentInfo, String> {
        // 1. 提前检查文件大小（避免解析大文件浪费资源）
        let metadata = std::fs::metadata(file_path)
            .map_err(|e| format!("读取文件元信息失败: {}", e))?;
        if metadata.len() > MAX_DOC_SIZE_BYTES {
            return Err(format!(
                "文档过大（{:.2} MB），超过最大限制（50 MB）。请拆分后分别导入。",
                metadata.len() as f64 / (1024.0 * 1024.0)
            ));
        }

        // 2. 解析文档
        let parsed = document::parse_document(file_path)?;
        let doc_id = parsed.meta.id.clone();

        // 3. 分块
        let chunks = document::chunk_document(&parsed, &doc_id, 512, 48);

        if chunks.is_empty() {
            return Err("文档解析后无有效文本内容".to_string());
        }

        // 4. 嵌入并存储
        let mut mgr = self.store_manager.write().map_err(|e| format!("获取写锁失败: {}", e))?;
        let doc_info = mgr.add_document(kb_id, chunks)?;

        Ok(doc_info)
    }

    /// 通过文本内容添加文档（无需文件路径）
    ///
    /// 用于 AI Tool 直接写入知识库的场景。
    /// 流程：分块 → 嵌入 → 存储
    ///
    /// ⚠️ 文本内容超过 50MB 时会拒绝处理，防止嵌入耗时过长导致超时。
    pub fn add_text_document(&self, kb_id: &str, doc_name: &str, content: &str) -> Result<DocumentInfo, String> {
        // 检查内容大小
        if content.len() as u64 > MAX_DOC_SIZE_BYTES {
            return Err(format!(
                "文本内容过大（{:.2} MB），超过最大限制（50 MB）。请拆分后分别导入。",
                content.len() as f64 / (1024.0 * 1024.0)
            ));
        }
        // 1. 从文本创建文档对象
        let parsed = document::parse_text(content, doc_name);
        let doc_id = parsed.meta.id.clone();

        // 2. 分块（使用较小的块大小，AI 生成的内容通常比较紧凑）
        let chunks = document::chunk_document(&parsed, &doc_id, 512, 48);

        if chunks.is_empty() {
            return Err("文本内容为空".to_string());
        }

        // 3. 嵌入并存储
        let mut mgr = self.store_manager.write().map_err(|e| format!("获取写锁失败: {}", e))?;
        let doc_info = mgr.add_document(kb_id, chunks)?;

        Ok(doc_info)
    }

    /// 从知识库删除文档
    pub fn remove_document(&self, kb_id: &str, doc_id: &str) -> Result<(), String> {
        let mut mgr = self.store_manager.write().map_err(|e| format!("获取写锁失败: {}", e))?;
        mgr.remove_document(kb_id, doc_id)
    }

    /// 编辑文档 — 用新文件替换知识库中的已有文档
    ///
    /// 流程：解析新文件 → 分块 → 替换原有 chunks → 更新元数据
    pub fn edit_document(&self, kb_id: &str, doc_id: &str, new_file_path: &str) -> Result<DocumentInfo, String> {
        // 1. 解析新文档
        let parsed = document::parse_document(new_file_path)?;
        let new_doc_id = parsed.meta.id.clone();

        // 2. 分块
        let chunks = document::chunk_document(&parsed, &new_doc_id, 512, 48);
        if chunks.is_empty() {
            return Err("文档解析后无有效文本内容".to_string());
        }

        // 3. 在 store 中替换
        let mut mgr = self.store_manager.write().map_err(|e| format!("获取写锁失败: {}", e))?;
        mgr.edit_document(kb_id, doc_id, chunks)
    }

    /// 编辑文本文档 — 用新文本内容替换知识库中的已有文档（AI Tool 使用）
    ///
    /// 不需要文件路径，AI 直接提供新内容替换旧文档。
    pub fn edit_text_document(&self, kb_id: &str, doc_id: &str, new_doc_name: &str, new_content: &str) -> Result<DocumentInfo, String> {
        // 1. 从文本创建文档对象
        let parsed = document::parse_text(new_content, new_doc_name);
        let new_doc_id = parsed.meta.id.clone();

        // 2. 分块
        let chunks = document::chunk_document(&parsed, &new_doc_id, 512, 48);
        if chunks.is_empty() {
            return Err("文本内容为空".to_string());
        }

        // 3. 在 store 中替换
        let mut mgr = self.store_manager.write().map_err(|e| format!("获取写锁失败: {}", e))?;
        mgr.edit_document(kb_id, doc_id, chunks)
    }

    /// 初始化知识库 — 如果没有任何知识库，自动创建一个默认知识库
    ///
    /// 返回默认知识库的 ID（已存在时返回第一个知识库的 ID）。
    pub fn init_default_knowledge_base(&self) -> Result<String, String> {
        let kbs = self.list_knowledge_bases()?;
        if kbs.is_empty() {
            let kb = self.create_knowledge_base("默认知识库", "自动创建的默认知识库，用于存储常用文档")?;
            Ok(kb.id)
        } else {
            Ok(kbs[0].id.clone())
        }
    }

    /// 列出知识库中的文档（读操作，可并发）
    pub fn list_documents(&self, kb_id: &str) -> Result<Vec<DocumentInfo>, String> {
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;
        mgr.list_documents(kb_id)
    }

    /// 获取知识库中某个文档的完整内容（读操作，可并发）
    pub fn get_document_content(&self, kb_id: &str, doc_id: &str) -> Result<String, String> {
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;
        mgr.get_document_content(kb_id, doc_id)
    }

    // ===== 检索 =====

    /// 模糊搜索文档内容（读操作，可并发）
    ///
    /// 不依赖向量嵌入，直接做文本包含匹配，返回匹配的文档 ID 列表
    pub fn search_documents_content(
        &self,
        kb_id: &str,
        keyword: &str,
    ) -> Result<Vec<String>, String> {
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;
        mgr.search_documents_content(kb_id, keyword)
    }

    /// 将知识库中的所有文档导出为 ZIP 文件（读操作，可并发）
    pub fn export_to_zip(&self, kb_id: &str, output_path: &str) -> Result<(), String> {
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;
        mgr.export_to_zip(kb_id, output_path)
    }

    /// 检索知识库（读操作，可并发）
    ///
    /// 将用户查询转为嵌入向量，在指定知识库中进行相似度搜索，
    /// 返回最相关的 top_k 个文本块。
    pub fn query(&self, kb_id: &str, query_text: &str, top_k: usize) -> Result<Vec<ChunkResult>, String> {
        let top_k = top_k.clamp(1, 50);
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;
        mgr.query(kb_id, query_text, top_k)
    }

    /// 同时在多个知识库中检索（读操作，可并发）
    /// 当前未被前端直接调用，保留供后续功能扩展使用
    #[allow(dead_code)]
    pub fn query_multi(
        &self,
        kb_ids: &[String],
        query_text: &str,
        top_k_per_kb: usize,
    ) -> Result<Vec<ChunkResult>, String> {
        let mut all_results = Vec::new();
        let mgr = self.store_manager.read().map_err(|e| format!("获取读锁失败: {}", e))?;

        for kb_id in kb_ids {
            if let Ok(results) = mgr.query(kb_id, query_text, top_k_per_kb) {
                all_results.extend(results);
            }
        }

        // 按分数降序排列
        all_results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        // 去重（按文档+块索引）
        let mut seen = std::collections::HashSet::new();
        all_results.retain(|r| seen.insert(format!("{}:{}", r.document_id, r.chunk_index)));

        Ok(all_results)
    }

    /// 将检索结果格式化为上下文文本（供 LLM 使用）
    ///
    /// ⚠️ 此逻辑与前端 `rag-service.ts` 中的 `buildContextText()` 方法重复。
    /// 修改时请同步更新两处。
    pub fn format_context(chunks: &[ChunkResult], max_chars: usize) -> String {
        let mut context = String::new();
        context.push_str("以下是从知识库中检索到的相关文档片段：\n\n");
        context.push_str("---\n");

        let mut total_chars = 0;
        for (i, chunk) in chunks.iter().enumerate() {
            let header = format!(
                "[片段 {}] 来自：{}（相似度：{:.2}）\n",
                i + 1,
                chunk.document_name,
                chunk.score
            );

            let entry = format!("{}{}\n\n---\n", header, chunk.content);

            if total_chars + entry.len() > max_chars {
                context.push_str(&format!(
                    "\n...（已截断，共 {} 个片段中的前 {} 个）\n",
                    chunks.len(),
                    i
                ));
                break;
            }

            context.push_str(&entry);
            total_chars += entry.len();
        }

        context
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rag::embedding::NgramEmbeddingProvider;
    use std::sync::Arc;

    fn create_test_service() -> RagService {
        let test_id = uuid::Uuid::new_v4();
        let dir = std::env::temp_dir().join(format!("virlen_rag_test_service_{}", test_id));
        let provider = Arc::new(NgramEmbeddingProvider::new(512));
        RagService::new(dir, provider).unwrap()
    }

    #[test]
    fn test_full_pipeline() {
        let service = create_test_service();

        // 1. 创建知识库
        let kb = service.create_knowledge_base("测试知识库", "集成测试").unwrap();
        assert_eq!(kb.name, "测试知识库");
        assert_eq!(kb.document_count, 0);
        assert_eq!(kb.chunk_count, 0);

        // 2. 列出知识库
        let kbs = service.list_knowledge_bases().unwrap();
        assert!(!kbs.is_empty());
        assert!(kbs.iter().any(|k| k.id == kb.id));

        // 3. 添加文本文档
        let doc = service
            .add_text_document(&kb.id, "test-doc.md", "Rust 是一种系统编程语言，注重安全和性能。Python 是一种解释型高级编程语言。机器学习是人工智能的重要分支。")
            .unwrap();
        assert_eq!(doc.file_name, "test-doc.md");
        assert_eq!(doc.status, "ready");
        assert!(doc.chunk_count > 0);

        // 4. 列出文档
        let docs = service.list_documents(&kb.id).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].id, doc.id);

        // 5. 检索（针对 "Rust" 查询）
        let results = service.query(&kb.id, "Rust 编程", 3).unwrap();
        assert!(!results.is_empty(), "should find Rust-related chunks");
        assert!(results[0].content.contains("Rust") || results[0].content.contains("编程"));

        // 6. 检索（针对 "Python" 查询）
        let results_py = service.query(&kb.id, "Python", 3).unwrap();
        assert!(!results_py.is_empty(), "should find Python-related chunks");
        assert!(results_py[0].content.contains("Python"));

        // 7. 删除文档
        service.remove_document(&kb.id, &doc.id).unwrap();
        let docs = service.list_documents(&kb.id).unwrap();
        assert!(docs.is_empty());

        // 8. 删除后检索应为空
        let results = service.query(&kb.id, "Rust", 3).unwrap();
        assert!(results.is_empty());

        // 9. 删除知识库
        service.delete_knowledge_base(&kb.id).unwrap();
        let kbs = service.list_knowledge_bases().unwrap();
        assert!(!kbs.iter().any(|k| k.id == kb.id));
    }

    #[test]
    fn test_multi_kb_query() {
        let service = create_test_service();

        let kb1 = service.create_knowledge_base("KB1", "Rust 知识库").unwrap();
        let kb2 = service.create_knowledge_base("KB2", "Python 知识库").unwrap();

        service
            .add_text_document(&kb1.id, "rust.md", "Rust 是系统编程语言，内存安全，零成本抽象。")
            .unwrap();
        service
            .add_text_document(&kb2.id, "python.md", "Python 是解释型语言，易于学习，生态丰富。")
            .unwrap();

        // 跨库检索
        let results = service
            .query_multi(&[kb1.id.clone(), kb2.id.clone()], "编程语言", 2)
            .unwrap();
        assert!(!results.is_empty(), "should find results across both KBs");

        // 验证结果来自两个知识库
        let kb1_results: Vec<_> = results.iter().filter(|r| r.document_name == "rust.md").collect();
        let kb2_results: Vec<_> = results.iter().filter(|r| r.document_name == "python.md").collect();
        assert!(!kb1_results.is_empty(), "should have results from KB1");
        assert!(!kb2_results.is_empty(), "should have results from KB2");

        service.delete_knowledge_base(&kb1.id).unwrap();
        service.delete_knowledge_base(&kb2.id).unwrap();
    }

    #[test]
    fn test_format_context() {
        let chunks = vec![
            ChunkResult {
                id: "chunk1".into(),
                content: "Rust 是一种系统编程语言。".into(),
                document_id: "doc1".into(),
                document_name: "rust.md".into(),
                chunk_index: 0,
                score: 0.95,
            },
            ChunkResult {
                id: "chunk2".into(),
                content: "它提供了零成本抽象和内存安全保证。".into(),
                document_id: "doc1".into(),
                document_name: "rust.md".into(),
                chunk_index: 1,
                score: 0.85,
            },
        ];

        let context = RagService::format_context(&chunks, 500);
        assert!(context.contains("rust.md"));
        assert!(context.contains("Rust 是一种系统编程语言"));
        assert!(context.contains("0.95"));
        assert!(context.contains("0.85"));
        assert!(context.contains("[片段 1]"));
        assert!(context.contains("[片段 2]"));
    }

    #[test]
    fn test_format_context_truncation() {
        let chunks: Vec<ChunkResult> = (0..10)
            .map(|i| ChunkResult {
                id: format!("chunk{}", i),
                content: "A".repeat(100),
                document_id: "doc1".into(),
                document_name: "big.txt".into(),
                chunk_index: i,
                score: 1.0 - (i as f32) * 0.1,
            })
            .collect();

        // 限制很短的上下文，应该截断
        let context = RagService::format_context(&chunks, 50);
        assert!(context.contains("已截断"), "should indicate truncation");
        assert!(context.len() < 500, "truncated context should be small");
    }

    #[test]
    fn test_empty_chunks_format() {
        let context = RagService::format_context(&[], 1000);
        assert!(!context.is_empty());
        assert!(context.contains("检索到的相关文档片段"));
    }

    #[test]
    fn test_add_text_document_empty_content() {
        let service = create_test_service();
        let kb = service.create_knowledge_base("test", "").unwrap();

        let result = service.add_text_document(&kb.id, "empty.md", "");
        assert!(result.is_err(), "empty content should return error");

        service.delete_knowledge_base(&kb.id).unwrap();
    }

    #[test]
    fn test_get_knowledge_base() {
        let service = create_test_service();
        let kb = service.create_knowledge_base("get-test", "测试获取").unwrap();

        let fetched = service.get_knowledge_base(&kb.id).unwrap();
        assert_eq!(fetched.id, kb.id);
        assert_eq!(fetched.name, "get-test");
        assert_eq!(fetched.description, "测试获取");

        let not_found = service.get_knowledge_base("nonexistent");
        assert!(not_found.is_err());

        service.delete_knowledge_base(&kb.id).unwrap();
    }

    #[test]
    fn test_multiple_documents_same_kb() {
        let service = create_test_service();
        let kb = service.create_knowledge_base("multi-doc", "").unwrap();

        // 添加 3 个文档
        for i in 0..3 {
            let content = format!("这是第 {} 个文档的内容，包含一些测试文本。", i + 1);
            let doc = service
                .add_text_document(&kb.id, &format!("doc-{}.md", i), &content)
                .unwrap();
            assert_eq!(doc.status, "ready");
        }

        let docs = service.list_documents(&kb.id).unwrap();
        assert_eq!(docs.len(), 3);

        // 检索应跨所有文档
        let results = service.query(&kb.id, "测试", 10).unwrap();
        assert!(results.len() >= 3, "should find chunks from all 3 docs");

        // 删除一个文档，检索结果应减少
        service.remove_document(&kb.id, &docs[0].id).unwrap();
        let docs = service.list_documents(&kb.id).unwrap();
        assert_eq!(docs.len(), 2);

        service.delete_knowledge_base(&kb.id).unwrap();
    }
}
