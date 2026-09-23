//! `session_db` 单元测试（按职责分文件）
//!
//! 从原 `session_db.rs` 尾部的 `mod tests` 拆出；公共造数 / 临时库辅助留在本文件，
//! 各分组文件用 `use super::{...}` 复用。

use crate::agent::types::{Message, Session, SessionParams};
use crate::session_db::sqlite::SqliteSessionRepo;
use serde_json::json;

mod message_query;
mod migration;
mod search;
mod sessions;
mod usage;

pub(crate) fn test_session(id: &str, title: &str, updated_at: i64) -> Session {
    Session {
        id: id.to_string(),
        title: title.to_string(),
        messages: vec![],
        provider_config_id: "p1".into(),
        model_id: "gpt-4o".into(),
        system_prompt: "sys".into(),
        params: SessionParams {
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: 1000,
            stream: true,
            reasoning_effort: None,
        },
        created_at: 1,
        updated_at,
        pinned: false,
        tags: vec!["tag1".into()],
        workspace: Some("/ws".into()),
        agent_id: None,
        allowed_tools: Some(vec!["read_file".into()]),
        skills: None,
        system_prompt_manually_edited: Some(true),
    }
}

pub(crate) fn test_message(id: &str, role: &str) -> Message {
    Message {
        id: id.to_string(),
        role: role.to_string(),
        content: json!("hello"),
        tool_calls: None,
        reasoning_content: None,
        tool_call_id: None,
        is_error: None,
        elapsed_ms: None,
        reasoning_elapsed_ms: None,
        ui_data: None,
        timestamp: 10,
        streaming: None,
        model: None,
        usage: None,
        image_vision_analyze_optimize: None,
        image_vision_analyze_result: None,
    }
}

pub(crate) fn open_tmp_with_path() -> (SqliteSessionRepo, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("virlen_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("test.db");
    let repo = SqliteSessionRepo::open(&db).unwrap();
    (repo, db)
}

fn open_tmp() -> SqliteSessionRepo {
    open_tmp_with_path().0
}
