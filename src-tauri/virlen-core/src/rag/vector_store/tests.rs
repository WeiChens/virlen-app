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

// ===== 系统自建库（默认知识库 / 记忆详情）不允许删除 =====

#[test]
fn test_builtin_kb_is_marked_and_cannot_be_deleted() {
    let mut mgr = create_test_manager();

    let system_kb = mgr
        .create_builtin_knowledge_base("默认知识库", "系统自建")
        .unwrap();
    assert!(system_kb.builtin, "系统自建库要带 builtin 标记");
    assert!(
        mgr.get_knowledge_base(&system_kb.id).unwrap().builtin,
        "标记要能落盘回读"
    );

    // 删除被拒绝，而且库必须**原样还在**（不能删一半）
    let err = mgr.delete_knowledge_base(&system_kb.id).unwrap_err();
    assert!(
        err.contains("不能删除"),
        "错误信息要说清原因，实际：{}",
        err
    );
    assert!(
        mgr.list_knowledge_bases()
            .unwrap()
            .iter()
            .any(|k| k.id == system_kb.id),
        "被拒绝后库应当还在"
    );

    // 手建的库不受影响：标记为 false，照常能删
    let my_kb = mgr.create_knowledge_base("我的资料", "").unwrap();
    assert!(!my_kb.builtin, "用户手建的库不带系统标记");
    mgr.delete_knowledge_base(&my_kb.id).unwrap();
    assert!(!mgr.list_knowledge_bases()
        .unwrap()
        .iter()
        .any(|k| k.id == my_kb.id));
}

#[test]
fn test_mark_builtin_migrates_legacy_kb() {
    let mut mgr = create_test_manager();

    // 老数据：名字是系统库的名字，但没有 builtin 标记（那时还删得掉）
    let legacy = mgr.create_knowledge_base("记忆详情", "老数据").unwrap();
    assert!(!legacy.builtin);

    assert!(
        mgr.mark_knowledge_base_builtin(&legacy.id).unwrap(),
        "第一次补标记应真的改动了数据"
    );
    assert!(mgr.get_knowledge_base(&legacy.id).unwrap().builtin);
    assert!(
        !mgr.mark_knowledge_base_builtin(&legacy.id).unwrap(),
        "已标记 = 空操作"
    );

    let err = mgr.delete_knowledge_base(&legacy.id).unwrap_err();
    assert!(err.contains("不能删除"), "实际：{}", err);
}

#[test]
fn test_legacy_metadata_without_builtin_field_still_loads() {
    let mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("老版本建的库", "升级前的数据").unwrap();

    // 老版本的 `_metadata.json` 里没有 builtin 字段（模拟：写回前手动去掉）
    let path = mgr.kb_meta_path(&kb.id);
    let json = std::fs::read_to_string(&path).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
    value.as_object_mut().unwrap().remove("builtin");
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();

    // 关键：缺字段不能让老库解析失败（否则升级后整个库都读不出来）
    let loaded = mgr.get_knowledge_base(&kb.id).unwrap();
    assert_eq!(loaded.name, "老版本建的库");
    assert!(!loaded.builtin, "缺字段 = false，需要靠归属模块按名字认领");
}

// ============ 读全文：裁掉分块重叠 ============

#[test]
fn test_get_document_content_restores_original_text() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("还原原文", "").unwrap();

    // 足够长 ⇒ 一定会切成多块（块大小 20 字符、重叠 5）
    let text: String = (0..60)
        .map(|i| format!("第{}句：用于验证全文还原的文本。\n", i))
        .collect();
    let parsed = crate::rag::document::parse_text(&text, "长文.md");
    let doc_id = parsed.meta.id.clone();
    let chunks = crate::rag::document::chunk_document(&parsed, &doc_id, 20, 5);
    assert!(chunks.len() > 3, "样本要能切出多块，实际 {}", chunks.len());

    mgr.add_document(&kb.id, chunks).unwrap();

    let content = mgr.get_document_content(&kb.id, &doc_id).unwrap();
    assert_eq!(content, text, "读全文必须等于原文（不带重复、不带多余分隔符）");
}

#[test]
fn test_get_document_content_dedups_legacy_chunks() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("老数据", "").unwrap();

    // 老数据的块：没有 overlap_prefix_chars 字段，但内容确实带 5 字符重叠
    let chunks = make_test_chunks("legacy", "legacy.md", &[
        "0123456789",
        "56789ABCDEF",
        "ABCDEFGHIJ",
    ]);
    mgr.add_document(&kb.id, chunks).unwrap();

    let content = mgr.get_document_content(&kb.id, "legacy").unwrap();
    assert_eq!(content, "0123456789ABCDEFGHIJ");
}

#[test]
fn test_get_document_content_legacy_does_not_over_trim() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("重复文本", "").unwrap();

    // 高度重复的文本：上一块结尾与下一块开头大面积相同。回推重叠时**卡在上限**（48）内，
    // 不能把正文里本来就该保留的重复整段吞掉。
    let line = "AAAA BBBB CCCC ";
    let first: String = line.repeat(4); // 60 字符
    let second: String = line.repeat(4);
    let overlap = 48;
    let overlapping_second = format!(
        "{}{}",
        first.chars().skip(first.chars().count() - overlap).collect::<String>(),
        second
    );
    let chunks = make_test_chunks("rep", "rep.txt", &[&first, &overlapping_second]);
    mgr.add_document(&kb.id, chunks).unwrap();

    let content = mgr.get_document_content(&kb.id, "rep").unwrap();
    assert_eq!(content, format!("{}{}", first, second),
        "只能裁掉上限（{overlap}）内真的重复的那一段，不能多裁");
}

#[test]
fn test_get_document_content_single_chunk_unchanged() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("单块", "").unwrap();
    let chunks = make_test_chunks("one", "one.md", &["只有一块"]);
    mgr.add_document(&kb.id, chunks).unwrap();
    assert_eq!(mgr.get_document_content(&kb.id, "one").unwrap(), "只有一块");
}

// ============ 改知识库名称 / 说明 ============

#[test]
fn test_update_knowledge_base_keeps_documents() {
    let mut mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("旧名字", "旧说明").unwrap();
    mgr.add_document(&kb.id, make_test_chunks("d1", "a.md", &["内容"])).unwrap();

    let updated = mgr.update_knowledge_base(&kb.id, Some("新名字"), None).unwrap();
    assert_eq!(updated.name, "新名字");
    assert_eq!(updated.description, "旧说明", "没传的字段不动");
    assert_eq!(updated.document_count, 1, "改名不能弄丢文档");

    // 只改说明
    let updated = mgr.update_knowledge_base(&kb.id, None, Some("  ")).unwrap();
    assert_eq!(updated.name, "新名字");
    assert_eq!(updated.description, "", "空白说明 = 清空");

    // 名称两端空白会被裁掉
    let updated = mgr.update_knowledge_base(&kb.id, Some("  两边有空格  "), None).unwrap();
    assert_eq!(updated.name, "两边有空格");

    // 落盘了（重新读出来是同一個）
    assert_eq!(mgr.get_knowledge_base(&kb.id).unwrap().name, "两边有空格");
}

#[test]
fn test_update_knowledge_base_rejects_empty_name_and_builtin() {
    let mgr = create_test_manager();
    let kb = mgr.create_knowledge_base("我这建的", "").unwrap();
    let err = mgr.update_knowledge_base(&kb.id, Some("   "), None).unwrap_err();
    assert!(err.contains("不能为空"), "实际：{}", err);

    let system = mgr.create_builtin_knowledge_base("记忆详情", "").unwrap();
    let err = mgr.update_knowledge_base(&system.id, Some("我的库"), None).unwrap_err();
    assert!(err.contains("不能改名"), "实际：{}", err);
    // 但改说明是允许的（名字才是锚点）
    assert!(mgr.update_knowledge_base(&system.id, None, Some("说明")).is_ok());

    let err = mgr.update_knowledge_base("kb_not_exist", Some("x"), None).unwrap_err();
    assert!(err.contains("不存在"), "实际：{}", err);
}

// ============ 压缩包（导出 → 预览 → 逐条读） ============
//
// 导入本身现在由命令层逐条驱动（读一条、存一条，界面才能报进度、随时取消），Rust 侧只留下
// 「导出能原样读回来」与「哪些条目该进名单」这两件事，本组用例守的就是它们。

fn temp_zip_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("virlen_kb_zip_{}.zip", uuid::Uuid::new_v4()))
}

/// 造一个压缩包：`entries` 是 (条目名, 内容字节)
fn write_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
    use std::io::Write as _; // ZipWriter 写条目要用 Write trait
    let file = std::fs::File::create(path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
    for (name, bytes) in entries {
        writer.start_file(*name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}

#[test]
fn test_zip_export_then_preview_and_read_each_entry() {
    let mut mgr = create_test_manager();
    let source = mgr.create_knowledge_base("源库", "").unwrap();
    mgr.add_document(&source.id, make_test_chunks("d1", "笔记.md", &["Rust 是系统编程语言。"]))
        .unwrap();
    // 带目录的文档名：导出会变成嵌套条目，读回来要能原名对应
    mgr.add_document(&source.id, make_test_chunks("d2", "子目录/规范.md", &["缩进用空格。"]))
        .unwrap();

    let zip_path = temp_zip_path();
    let zip_str = zip_path.to_string_lossy().to_string();
    mgr.export_to_zip(&source.id, &zip_str).unwrap();

    let mut preview = VectorStoreManager::zip_entry_names(&zip_str).unwrap();
    preview.names.sort();
    assert_eq!(
        preview.names,
        vec!["子目录/规范.md".to_string(), "笔记.md".to_string()],
        "预览名单就是前端循环的名单"
    );
    assert_eq!(preview.ignored, 0, "包里没有 .gitignore");
    assert_eq!(preview.too_large, 0);

    // 逐条读：读到的要是原始正文（不是分块拼接后的重叠文本）
    assert_eq!(
        VectorStoreManager::read_zip_entry(&zip_str, "笔记.md").unwrap(),
        "Rust 是系统编程语言。"
    );
    assert_eq!(
        VectorStoreManager::read_zip_entry(&zip_str, "子目录/规范.md").unwrap(),
        "缩进用空格。"
    );

    let _ = std::fs::remove_file(&zip_path);
}

#[test]
fn test_zip_preview_skips_system_junk() {
    let zip_path = temp_zip_path();
    write_zip(
        &zip_path,
        &[
            ("正常.md", "这是一份正常文档。".as_bytes()),
            // 系统垃圾（macOS / Windows 打包会带）
            ("__MACOSX/._正常.md", b"junk"),
            ("子目录/.DS_Store", b"junk"),
        ],
    );
    let zip_str = zip_path.to_string_lossy().to_string();

    let preview = VectorStoreManager::zip_entry_names(&zip_str).unwrap();
    assert_eq!(preview.names, vec!["正常.md".to_string()]);
    assert_eq!(preview.ignored, 0, "系统垃圾是静默略过，不算「被 .gitignore 排除」");
    assert_eq!(
        VectorStoreManager::read_zip_entry(&zip_str, "正常.md").unwrap(),
        "这是一份正常文档。"
    );

    let _ = std::fs::remove_file(&zip_path);
}

#[test]
fn test_zip_preview_applies_gitignore_from_inside_the_archive() {
    let zip_path = temp_zip_path();
    write_zip(
        &zip_path,
        &[
            (".gitignore", "build/\n*.log\n!keep.log\n".as_bytes()),
            ("docs/readme.md", "留下".as_bytes()),
            ("build/deep.md", "目录被排除".as_bytes()),
            ("run.log", "被 *.log 排除".as_bytes()),
            ("keep.log", "被 ! 取反救回来".as_bytes()),
        ],
    );
    let zip_str = zip_path.to_string_lossy().to_string();

    let mut preview = VectorStoreManager::zip_entry_names(&zip_str).unwrap();
    preview.names.sort();
    assert_eq!(
        preview.names,
        vec!["docs/readme.md".to_string(), "keep.log".to_string()],
        ".gitignore 自己也不该进名单"
    );
    assert_eq!(preview.ignored, 2, "build/deep.md 与 run.log");
    assert_eq!(preview.too_large, 0);

    let _ = std::fs::remove_file(&zip_path);
}

#[test]
fn test_zip_preview_drops_entries_over_the_text_limit() {
    use crate::rag::import_scan::MAX_TEXT_FILE_BYTES;

    let zip_path = temp_zip_path();
    let big = vec![b'a'; (MAX_TEXT_FILE_BYTES + 1) as usize];
    let big_but_ignored = vec![b'b'; (MAX_TEXT_FILE_BYTES + 1) as usize];
    write_zip(
        &zip_path,
        &[
            (".gitignore", "big.log\n".as_bytes()),
            ("小.md", "正文".as_bytes()),
            ("巨档.md", &big),
            ("big.log", &big_but_ignored),
        ],
    );
    let zip_str = zip_path.to_string_lossy().to_string();

    let mut preview = VectorStoreManager::zip_entry_names(&zip_str).unwrap();
    preview.names.sort();
    assert_eq!(preview.names, vec!["小.md".to_string()], "2 MB 以上的条目不收");
    assert_eq!(
        preview.ignored, 1,
        "既超限又被 .gitignore 排除：算「被排除」（用户明确说过不要的不该被别的理由改写）"
    );
    assert_eq!(preview.too_large, 1, "巨档.md");
    // 超限的条目压根不该被读（名单里没有它，读它也只会撞到上限错误）
    assert!(VectorStoreManager::read_zip_entry(&zip_str, "巨档.md").is_err());

    let _ = std::fs::remove_file(&zip_path);
}

#[test]
fn test_read_zip_entry_says_why_it_cannot_be_read() {
    let zip_path = temp_zip_path();
    write_zip(
        &zip_path,
        &[
            // 非 UTF-8（用户自己把 PDF 整包塞进来的情形）
            ("扫描件.pdf", &[0xFFu8, 0xFE, 0x00, 0x01, 0xFF]),
            ("空.md", b""),
        ],
    );
    let zip_str = zip_path.to_string_lossy().to_string();

    let err = VectorStoreManager::read_zip_entry(&zip_str, "扫描件.pdf").unwrap_err();
    assert!(err.contains("不是文本"), "实际：{}", err);
    // 空内容不当错误：交给上层（写库时会报「文本内容为空」），这里如实返回
    assert_eq!(VectorStoreManager::read_zip_entry(&zip_str, "空.md").unwrap(), "");

    let err = VectorStoreManager::read_zip_entry(&zip_str, "没有这份.md").unwrap_err();
    assert!(err.contains("找不到"), "实际：{}", err);

    let _ = std::fs::remove_file(&zip_path);
}

