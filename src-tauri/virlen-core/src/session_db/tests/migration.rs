//! schema 初始化与历史数据迁移的回归测试
//!
//! 关注：`text_plain` 自愈回填、FTS 重建，以及「检索索引不得落在启动路径上」。

use super::open_tmp;
use crate::session_db::repo::SessionRepo;
use crate::session_db::sqlite::SqliteSessionRepo;
use rusqlite::params;

// 验证老库迁移：旧 schema 没有 text_plain 列，open() 应自动补列、回填并建 FTS 索引。
#[tokio::test]
async fn migrates_legacy_db_without_text_plain() {
    let dir = std::env::temp_dir().join(format!("virlen_legacy_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("legacy.db");

    // 构造「旧版」库：messages 表无 text_plain 列、无 FTS、user_version=0
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
  VALUES ('s1', '旧会话', 'p1', 'gpt-4o', '', '{}', 1, 100);
"#,
        )
        .unwrap();
        let content = serde_json::to_string("旧的沙盒消息内容").unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?1,?2,?3,?4,?5)",
            params!["m1", "s1", "user", content, 10i64],
        )
        .unwrap();
    }

    // open 只做快速初始化；有历史数据时迁移推迟到后台（此处显式触发）
    let repo = SqliteSessionRepo::open(&db).unwrap();
    assert!(!repo.migration_done(), "有历史数据时迁移应推迟到后台");

    // 迁移完成前：回退到旧的 content LIKE 路径，检索结果依然正确
    let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
    assert_eq!(page.items.len(), 1, "迁移前回退路径仍可检索");

    // 执行迁移（等价于生产环境的后台任务）
    repo.migrate().await.unwrap();
    assert!(repo.migration_done());

    // 迁移后：2 字走 LIKE text_plain、4 字走 FTS5
    let page = repo.search_messages("沙盒", None, None, 10, None).await.unwrap();
    assert_eq!(page.items.len(), 1, "迁移后应能检索到旧数据");
    let page = repo.search_messages("消息内容", None, None, 10, None).await.unwrap();
    assert_eq!(page.items.len(), 1, "FTS 索引应覆盖迁移回填的旧数据");
}

// 全新库无历史数据 → 无需迁移，直接可用
#[tokio::test]
async fn fresh_db_needs_no_migration() {
    let repo = open_tmp();
    assert!(repo.migration_done(), "全新库无需迁移");
    // 幂等：重复 migrate 无副作用
    repo.migrate().await.unwrap();
    assert!(repo.migration_done());
}

/// messages 表上是否存在指定索引
fn has_index(repo: &SqliteSessionRepo, name: &str) -> bool {
    let conn = repo.conn.lock().unwrap();
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
        params![name],
        |row| row.get::<_, i64>(0),
    )
    .unwrap()
        != 0
}

// 回归（优化 3）：检索排序索引不应落在 open() 同步路径上 ——
// 空库（无历史数据）open 即建好；老库推迟到后台 migrate() 后建好。
#[tokio::test]
async fn search_index_stays_off_startup_path_for_legacy_db() {
    // 新建库：空表快速路径，open 后索引即存在
    let fresh = open_tmp();
    assert!(has_index(&fresh, "idx_messages_ts"), "空库应建检索索引");

    // 构造「旧版」有数据的库
    let dir = std::env::temp_dir().join(format!("virlen_idx_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("legacy.db");
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
"#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?1,?2,?3,?4,?5)",
            params!["m1", "s1", "user", serde_json::to_string("x").unwrap(), 10i64],
        )
        .unwrap();
    }

    let repo = SqliteSessionRepo::open(&db).unwrap();
    assert!(!repo.migration_done(), "老库需迁移");
    assert!(
        !has_index(&repo, "idx_messages_ts"),
        "老库迁移前不应在启动路径同步建索引"
    );

    repo.migrate().await.unwrap();
    assert!(has_index(&repo, "idx_messages_ts"), "迁移后应建好检索索引");
}
