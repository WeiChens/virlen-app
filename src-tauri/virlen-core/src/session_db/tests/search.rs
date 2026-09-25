//! 消息检索（FTS / LIKE 回退、游标分页、命中片段）的回归测试

use super::{open_tmp, test_message, test_session};
use crate::agent::types::Message;
use crate::session_db::repo::SessionRepo;
use crate::session_db::sqlite::SqliteSessionRepo;
use serde_json::json;

#[tokio::test]
async fn search_matches_across_sessions_and_snippets() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "会话一", 100)).await.unwrap();
    repo.upsert_session(&test_session("s2", "会话二", 200)).await.unwrap();

    let mut a = test_message("m1", "assistant");
    a.timestamp = 10;
    a.content = json!("请检查一下沙盒模式下的端口占用问题");
    let mut b = test_message("m2", "user");
    b.timestamp = 20;
    b.content = json!("沙盒里跑 vitest 报 EPERM");
    let mut c = test_message("m3", "tool");
    c.timestamp = 15;
    c.content = json!("沙盒工具结果不应被检索");
    let mut d = test_message("m4", "user");
    d.timestamp = 30;
    d.content = json!("确认图片文本块里的沙盒二字也能命中");
    repo.append_messages("s1", &[a, b]).await.unwrap();
    repo.append_messages("s2", &[c, d]).await.unwrap();

    // 跨会话：只命中 user/assistant（tool 排除），按时间倒序
    let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m4", "m2", "m1"]);
    assert!(!page.has_more);
    // 来源信息由 JOIN sessions 带出
    assert_eq!(page.items[0].session_title, "会话二");
    // 摘要围绕命中位置生成，命中词保留在片段内
    assert!(page.items[1].text.contains("沙盒"));

    // 限定会话
    let page = repo.search_messages("沙盒", Some("s1"), None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m2", "m1"]);

    // 角色过滤
    let page = repo.search_messages("沙盒", None, Some("user"), 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m4", "m2"]);

    // 空查询：不做关键词过滤，返回最新消息（排除 tool，按时间倒序）
    let page = repo.search_messages("   ", None, None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m4", "m2", "m1"]);
}

// 「工具调用」分类：`role='tool'` 只返回工具结果，并从宿主 assistant 的
// `tool_calls` 里反查出工具名（供前端展示「查看文件」等标签）。
#[tokio::test]
async fn search_tool_role_resolves_tool_name() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();

    // m1：assistant 一次发起两个并行工具调用
    let mut m1 = test_message("m1", "assistant");
    m1.timestamp = 10;
    m1.content = json!("");
    m1.tool_calls = Some(vec![
        crate::agent::types::ToolUseContent {
            type_: "tool_use".into(),
            id: "call_read".into(),
            name: "read_file".into(),
            input: json!({ "path": "a.ts" }),
        },
        crate::agent::types::ToolUseContent {
            type_: "tool_use".into(),
            id: "call_edit".into(),
            name: "edit_file".into(),
            input: json!({ "path": "a.ts" }),
        },
    ]);
    // m2 / m3：两个工具结果（正文含关键词「沙盒」）
    let mut m2 = test_message("m2", "tool");
    m2.timestamp = 11;
    m2.content = json!("沙盒结果一");
    m2.tool_call_id = Some("call_read".into());
    let mut m3 = test_message("m3", "tool");
    m3.timestamp = 12;
    m3.content = json!("沙盒结果二");
    m3.tool_call_id = Some("call_edit".into());
    repo.append_messages("s1", &[m1, m2, m3]).await.unwrap();

    // 默认（不限定角色）不含 tool
    let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
    assert!(page.items.is_empty(), "tool 结果不在默认检索范围内");

    // role='tool' → 只返回工具结果，且各自带上宿主工具名
    let page = repo
        .search_messages("沙盒", None, Some("tool"), 10, None)
        .await
        .unwrap();
    let got: Vec<(&str, Option<&str>)> = page
        .items
        .iter()
        .map(|i| (i.id.as_str(), i.tool_name.as_deref()))
        .collect();
    assert_eq!(
        got,
        vec![("m3", Some("edit_file")), ("m2", Some("read_file"))],
        "时间倒序，且能跨过工具结果行反查到宿主"
    );

    // 宿主缺失（tool_call_id 对不上）→ 工具名为 None，但结果照常返回
    let mut orphan = test_message("m4", "tool");
    orphan.timestamp = 20;
    orphan.content = json!("沙盒孤立结果");
    orphan.tool_call_id = Some("call_missing".into());
    repo.append_messages("s1", &[orphan]).await.unwrap();
    let page = repo
        .search_messages("沙盒", None, Some("tool"), 10, None)
        .await
        .unwrap();
    assert_eq!(page.items[0].id, "m4");
    assert_eq!(page.items[0].tool_name, None);
}

// 空查询（检索弹窗默认态）：不过滤关键词、返回最新消息，role / session / 游标仍生效。
#[tokio::test]
async fn empty_query_returns_latest_messages() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (0..5)
        .map(|i| {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            let mut m = test_message(&format!("m{}", i), role);
            m.timestamp = i as i64;
            m.content = json!(format!("消息 {}", i));
            m
        })
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();

    // 空串 / 纯空白 → 视为空查询，返回最新消息（时间倒序）
    for q in ["", "   "] {
        let page = repo.search_messages(q, None, None, 10, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m4", "m3", "m2", "m1", "m0"], "空查询返回最新消息");
    }

    // role 过滤仍生效
    let page = repo.search_messages("", None, Some("user"), 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m4", "m2", "m0"]);

    // keyset 游标分页仍生效
    let first = repo.search_messages("", None, None, 2, None).await.unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.items[0].id, "m4");
    let second = repo
        .search_messages("", None, None, 2, first.next_cursor)
        .await
        .unwrap();
    assert_eq!(second.items[0].id, "m2", "空查询下游标翻页仍正确");
}

// 正文为空的消息（仅做深度思考 / 工具调用）不进入检索结果。
#[tokio::test]
async fn search_excludes_empty_body_messages() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();

    // m1：空字符串正文（仅有工具调用 / 思考）
    let mut m1 = test_message("m1", "assistant");
    m1.timestamp = 10;
    m1.content = json!("");
    m1.reasoning_content = Some("只想不做".into());
    // m2：空文本块（正文仍为空）
    let mut m2 = test_message("m2", "assistant");
    m2.timestamp = 20;
    m2.content = json!([{ "type": "text", "text": "" }]);
    // m3：纯空白正文
    let mut m3 = test_message("m3", "assistant");
    m3.timestamp = 30;
    m3.content = json!("   ");
    // m4：多个空文本块（拼出 "\n"，仅空白）
    let mut m4 = test_message("m4", "assistant");
    m4.timestamp = 40;
    m4.content = json!([
        { "type": "text", "text": "" },
        { "type": "text", "text": "" }
    ]);
    // m5：真正的正文
    let mut m5 = test_message("m5", "assistant");
    m5.timestamp = 50;
    m5.content = json!("这是真正的回复正文");
    repo.append_messages("s1", &[m1, m2, m3, m4, m5]).await.unwrap();

    // 空查询默认视图：只保留有正文的消息
    let page = repo.search_messages("", None, None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m5"], "空正文消息不应出现在默认视图");

    // 有关键词时（4 字 → FTS 路径）也只命中真正有正文的消息
    let page = repo.search_messages("回复正文", None, None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m5"]);
}

// 回归：历史旧构建可能把 text_plain 写成 NULL（未回填），且 user_version 已是最新版本，
// 迁移不会自动重跑。此时：①检索不应显示这些 NULL 行里的空正文；
// ②启动时 init_schema 应检测到 NULL 行 → 返回「需迁移」以触发自愈回填。
#[tokio::test]
async fn search_excludes_null_text_plain_and_self_heals() {
    let dir = std::env::temp_dir().join(format!("virlen_null_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("null.db");

    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            r#"
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', workspace TEXT, agent_id TEXT, allowed_tools TEXT,
  skills TEXT, system_prompt_manually_edited INTEGER
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  tool_calls TEXT, reasoning_content TEXT, tool_call_id TEXT, is_error INTEGER,
  elapsed_ms INTEGER, reasoning_elapsed_ms INTEGER, ui_data TEXT, timestamp INTEGER NOT NULL,
  streaming INTEGER, model TEXT, usage TEXT, image_vision_analyze_optimize INTEGER,
  image_vision_analyze_result TEXT
);
INSERT INTO sessions (id, title, provider_config_id, model_id, system_prompt, params, created_at, updated_at)
  VALUES ('s1', 't', 'p1', 'gpt-4o', '', '{}', 1, 100);
-- 模拟旧构建漏写 text_plain：两行都是 NULL（一空正文、一有正文）
INSERT INTO messages (id, session_id, role, content, timestamp) VALUES
  ('m_blank', 's1', 'assistant', '""', 10),
  ('m_real',  's1', 'assistant', '"hello world"', 20);
PRAGMA user_version = 1;
"#,
        )
        .unwrap();
    }

    let repo = SqliteSessionRepo::open(&db).unwrap();
    // 存在 NULL 行 → 不能走快速路径，需迁移自愈
    assert!(
        !repo.migration_done(),
        "存在 text_plain IS NULL 行时应触发迁移"
    );
    // 迁移前：NULL 且空正文的行被 Rust 侧按实际正文过滤掉
    let page = repo.search_messages("", None, None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m_real"], "NULL 且空正文的行不应出现");

    // 自愈回填
    repo.migrate().await.unwrap();
    assert!(repo.migration_done());
    // 回填后：关键字检索（FTS 路径）能命中真实正文
    let page = repo.search_messages("hello", None, None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m_real"]);
    // 空正文行仍不出现
    let page = repo.search_messages("", None, None, 10, None).await.unwrap();
    let ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["m_real"]);
}

#[tokio::test]
async fn search_paginates_with_cursor() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let msgs: Vec<Message> = (0..5)
        .map(|i| {
            let mut m = test_message(&format!("m{}", i), "user");
            m.timestamp = i as i64;
            m.content = json!(format!("keyword {}", i));
            m
        })
        .collect();
    repo.append_messages("s1", &msgs).await.unwrap();

    let first = repo.search_messages("keyword", None, None, 2, None).await.unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.items[0].id, "m4", "按时间倒序（新→旧）");
    assert_eq!(first.items[1].id, "m3");
    assert!(first.next_cursor.is_some());

    let second = repo
        .search_messages("keyword", None, None, 2, first.next_cursor)
        .await
        .unwrap();
    assert_eq!(second.items[0].id, "m2");
    assert!(second.has_more);

    let third = repo
        .search_messages("keyword", None, None, 2, second.next_cursor)
        .await
        .unwrap();
    assert_eq!(third.items.len(), 1);
    assert!(!third.has_more);
    assert!(third.next_cursor.is_none(), "无更多时不应给出游标");

    // keyset 抗「检索期间新增」：取完首页后插入一条更新的消息，
    // 用旧游标翻下一页应仍从 m2 继续（不重复、不跳过）
    let mut extra = test_message("m9", "user");
    extra.timestamp = 99;
    extra.content = json!("keyword extra");
    repo.append_messages("s1", &[extra]).await.unwrap();
    let second_after = repo
        .search_messages("keyword", None, None, 2, first.next_cursor)
        .await
        .unwrap();
    assert_eq!(second_after.items[0].id, "m2", "新写入不影响旧游标定位");
}

// 新实现：检索基于 text_plain（而非 content JSON），不再误命中 JSON 键名；
// ≥3 字符走 FTS5，更短的走 LIKE 回退。
#[tokio::test]
async fn search_matches_plain_text_not_json_keys() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let mut m = test_message("m1", "user");
    m.content = json!([
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
        { "type": "text", "text": "登录失败请重试" }
    ]);
    repo.append_messages("s1", &[m]).await.unwrap();

    // 旧实现直接 LIKE content JSON，会误命中键名；改用 text_plain 后不应命中
    for key in ["image_url", "type", "url"] {
        let page = repo.search_messages(key, None, None, 10, None).await.unwrap();
        assert!(page.items.is_empty(), "不应命中 JSON 键名: {}", key);
    }
    // 正文可命中：2 字 → LIKE 回退路径
    let page = repo.search_messages("登录", None, None, 10, None).await.unwrap();
    assert_eq!(page.items.len(), 1);
    // 3 字以上 → FTS5（trigram）路径，命中片段保留关键词
    let page = repo.search_messages("登录失败", None, None, 10, None).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].text.contains("登录失败"));
}

// 回归（优化 2）：相邻文本块之间应以分隔符隔开，避免被拼成一个词导致跨块误命中。
#[tokio::test]
async fn search_does_not_match_across_text_blocks() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let mut m = test_message("m1", "user");
    m.content = json!([
        { "type": "text", "text": "你好" },
        { "type": "text", "text": "世界" }
    ]);
    repo.append_messages("s1", &[m]).await.unwrap();

    // "你好世界" 跨越两个独立文本块（中间有分隔符）→ 不应命中（4 字 → FTS 路径）
    let page = repo.search_messages("你好世界", None, None, 10, None).await.unwrap();
    assert!(page.items.is_empty(), "跨块短语不应命中");
    // 单块内仍可命中（2 字 → LIKE 路径）
    let page = repo.search_messages("你好", None, None, 10, None).await.unwrap();
    assert_eq!(page.items.len(), 1);
}

// 触发器应保证 FTS 索引随 messages 增/改/删自动同步。
#[tokio::test]
async fn search_index_in_sync_on_update_and_delete() {
    let repo = open_tmp();
    repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
    let mut m = test_message("m1", "user");
    m.content = json!("第一版内容 alpha");
    repo.append_messages("s1", &[m.clone()]).await.unwrap();
    assert_eq!(
        repo.search_messages("alpha", None, None, 10, None)
            .await
            .unwrap()
            .items
            .len(),
        1
    );

    // 同 id 更新正文 → 索引应刷新（旧文本消失、新文本命中）
    m.content = json!("第二版内容 beta");
    repo.append_messages("s1", &[m.clone()]).await.unwrap();
    assert!(
        repo.search_messages("alpha", None, None, 10, None)
            .await
            .unwrap()
            .items
            .is_empty(),
        "更新后旧文本不应命中"
    );
    assert_eq!(
        repo.search_messages("beta", None, None, 10, None)
            .await
            .unwrap()
            .items
            .len(),
        1
    );

    // 截断删除 → 索引应清理
    repo.truncate_messages_from("s1", "m1").await.unwrap();
    assert!(
        repo.search_messages("beta", None, None, 10, None)
            .await
            .unwrap()
            .items
            .is_empty(),
        "删除后不应命中"
    );
}
