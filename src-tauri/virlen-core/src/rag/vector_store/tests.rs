use super::*;
use crate::rag::embedding::NgramEmbeddingProvider;
use crate::rag::document::DocumentChunk;

fn create_test_manager() -> VectorStoreManager {
    let test_id = uuid::Uuid::new_v4();
    let dir = std::env::temp_dir().join(format!("virlen_rag_test_turbovec_{}", test_id));
    let provider = Arc::new(NgramEmbeddingProvider::new(512));
    let mut manager = VectorStoreManager::new(dir, provider);
    manager.init().unwrap();
    manager
}

fn make_test_chunks(doc_id: &str, doc_name: &str, texts: &[&str]) -> Vec<DocumentChunk> {
    texts.iter().enumerate().map(|(i, text)| {
        let mut metadata = std::collections::HashMap::new();
        metadata.insert("file_type".into(), "md".into());
        metadata.insert("file_size".into(), "100".into());
        DocumentChunk {
            id: format!("{}_{}", doc_id, i),
            document_id: doc_id.to_string(),
            document_name: doc_name.to_string(),
            content: text.to_string(),
            chunk_index: i,
            metadata,
        }
    }).collect()
}

#[test]
fn test_kb_crud() {
    let mut mgr = create_test_manager();

    // 创建
    let kb = mgr.create_knowledge_base("测试知识库", "测试用").unwrap();
    assert_eq!(kb.name, "测试知识库");

    // 列出
    let list = mgr.list_knowledge_bases().unwrap();
    assert!(!list.is_empty());

    // 获取
    let fetched = mgr.get_knowledge_base(&kb.id).unwrap();
    assert_eq!(fetched.id, kb.id);

    // 删除
    mgr.delete_knowledge_base(&kb.id).unwrap();
    let list = mgr.list_knowledge_bases().unwrap();
    assert!(list.is_empty());
}

#[test]
fn test_add_and_query_document() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("测试", "").unwrap();

    let chunks = make_test_chunks("doc1", "test.md", &[
        "Rust 是一种系统编程语言，注重安全和性能。",
        "Python 是一种解释型高级编程语言。",
        "机器学习是人工智能的一个重要分支。",
    ]);

    let doc_info = mgr.add_document(&kb.id, chunks).unwrap();
    assert_eq!(doc_info.file_name, "test.md");
    assert_eq!(doc_info.chunk_count, 3);

    // 查询
    let results = mgr.query(&kb.id, "编程语言", 2).unwrap();
    assert!(!results.is_empty());
    assert!(results.len() <= 2);
    // 结果应该包含 Rust 或 Python
    let all_content: String = results.iter().map(|r| r.content.clone()).collect();
    assert!(all_content.contains("Rust") || all_content.contains("Python"));
}

#[test]
fn test_remove_document() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("测试", "").unwrap();

    let chunks = make_test_chunks("doc1", "doc1.md", &["内容 A", "内容 B"]);
    let doc_info = mgr.add_document(&kb.id, chunks).unwrap();

    // 删除
    mgr.remove_document(&kb.id, &doc_info.id).unwrap();

    // 验证文档列表为空
    let docs = mgr.list_documents(&kb.id).unwrap();
    assert!(docs.is_empty());

    // 验证查询为空
    let results = mgr.query(&kb.id, "内容", 5).unwrap();
    assert!(results.is_empty());
}

#[test]
fn test_multiple_documents() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("测试", "").unwrap();

    // 添加第一个文档
    let chunks1 = make_test_chunks("doc1", "rust.md", &["Rust 编程语言", "Rust 的所有权系统"]);
    mgr.add_document(&kb.id, chunks1).unwrap();

    // 添加第二个文档
    let chunks2 = make_test_chunks("doc2", "python.md", &["Python 编程", "Python 的列表推导"]);
    mgr.add_document(&kb.id, chunks2).unwrap();

    // 列出文档
    let docs = mgr.list_documents(&kb.id).unwrap();
    assert_eq!(docs.len(), 2);

    // 跨文档搜索（两个文档都包含"编程"，但 n-gram 可能最多返回所有 4 个块）
    let results = mgr.query(&kb.id, "编程", 10).unwrap();
    assert!(results.len() >= 2, "搜索应该返回至少2个结果，实际返回 {}", results.len());
}

#[test]
fn test_persistence() {
    let test_id = uuid::Uuid::new_v4();
    let dir = std::env::temp_dir().join(format!("virlen_rag_test_persist_{}", test_id));

    let provider = Arc::new(NgramEmbeddingProvider::new(512));
    let kb_id;

    // 第一阶段：创建知识库并添加文档
    {
        let mut mgr = VectorStoreManager::new(dir.clone(), provider.clone());
        mgr.init().unwrap();
        let kb = mgr.create_knowledge_base("持久化测试", "").unwrap();
        kb_id = kb.id.clone();

        let chunks = make_test_chunks("doc1", "test.md", &["Hello World", "Rust is great"]);
        mgr.add_document(&kb_id, chunks).unwrap();
    } // mgr 析构，数据落盘

    // 第二阶段：重新加载并验证
    {
        let mut mgr = VectorStoreManager::new(dir.clone(), provider);
        mgr.init().unwrap();

        let kbs = mgr.list_knowledge_bases().unwrap();
        assert!(!kbs.is_empty());

        let results = mgr.query(&kb_id, "Hello", 5).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].content.contains("Hello"));
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_edit_document() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("编辑测试", "").unwrap();

    // 添加初始文档
    let chunks1 = make_test_chunks("doc1", "original.md", &["原始内容第一块", "原始内容第二块"]);
    let doc1 = mgr.add_document(&kb.id, chunks1).unwrap();
    assert_eq!(doc1.file_name, "original.md");
    assert_eq!(doc1.chunk_count, 2);

    // 验证元数据
    let meta = mgr.get_knowledge_base(&kb.id).unwrap();
    assert_eq!(meta.document_count, 1);
    assert_eq!(meta.chunk_count, 2);

    // 编辑文档 — 用不同 chunk 数量替换
    let chunks_new = make_test_chunks("doc1_new", "updated.md", &[
        "更新后的内容第一块",
        "更新后的内容第二块",
        "新增的第三块内容",
    ]);
    let doc2 = mgr.edit_document(&kb.id, "doc1", chunks_new).unwrap();
    assert_eq!(doc2.file_name, "updated.md");
    assert_eq!(doc2.chunk_count, 3);

    // 验证文档索引已更新（旧文档被替换）
    let docs = mgr.list_documents(&kb.id).unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].file_name, "updated.md");

    // 验证元数据已更新（chunk_count 从 2 变为 3）
    let meta = mgr.get_knowledge_base(&kb.id).unwrap();
    assert_eq!(meta.document_count, 1, "document_count should still be 1");
    assert_eq!(meta.chunk_count, 3, "chunk_count should be 3 (replaced 2 with 3)");

    // 验证搜索新内容能找到
    let results = mgr.query(&kb.id, "更新后的内容", 5).unwrap();
    assert!(!results.is_empty(), "should find updated content");

    // 验证旧文档 doc_id 的 chunk 已被删除（文档列表只剩新文档）
    assert!(!docs.iter().any(|d| d.id == "doc1"), "old doc should be gone from index");
}

#[test]
fn test_remove_document_updates_metadata() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("元数据测试", "").unwrap();

    // 添加两个文档
    let docs1 = make_test_chunks("d1", "doc1.md", &["第一个文档的内容"]);
    let docs2 = make_test_chunks("d2", "doc2.md", &["第二个文档的内容", "第二文档的第二段"]);
    mgr.add_document(&kb.id, docs1).unwrap();
    mgr.add_document(&kb.id, docs2).unwrap();

    // 验证元数据
    let meta = mgr.get_knowledge_base(&kb.id).unwrap();
    assert_eq!(meta.document_count, 2);
    assert_eq!(meta.chunk_count, 3);

    // 删除一个文档后验证元数据更新
    mgr.remove_document(&kb.id, "d1").unwrap();
    let meta = mgr.get_knowledge_base(&kb.id).unwrap();
    assert_eq!(meta.document_count, 1, "after removing 1 doc, count should be 1");
    assert_eq!(meta.chunk_count, 2, "after removing 1 chunk, count should be 2");

    // 再删除最后一个文档
    mgr.remove_document(&kb.id, "d2").unwrap();
    let meta = mgr.get_knowledge_base(&kb.id).unwrap();
    assert_eq!(meta.document_count, 0, "after removing all docs, count should be 0");
    assert_eq!(meta.chunk_count, 0, "after removing all chunks, count should be 0");
}
