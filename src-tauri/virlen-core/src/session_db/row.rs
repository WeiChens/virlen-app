//! JSON 序列化辅助 + `Row -> 领域对象` 映射 + 写入参数序列化
//!
//! 从原 `session_db.rs` 拆出：所有「行 <-> 结构体」的胶水代码集中在此，
//! 供 `sqlite` / `schema` / `message_query` 复用。

use crate::agent::types::{Message, Session};
use rusqlite::Row;
use serde::{de::DeserializeOwned, Serialize};

// ==================== JSON 序列化辅助 ====================

fn to_json<T: Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| format!("序列化失败: {}", e))
}

fn opt_to_json<T: Serialize>(v: &Option<T>) -> Result<Option<String>, String> {
    v.as_ref().map(to_json).transpose()
}

fn from_json<T: DeserializeOwned>(s: &str) -> Result<T, String> {
    serde_json::from_str(s).map_err(|e| format!("反序列化失败: {}", e))
}

fn opt_from_json<T: DeserializeOwned>(s: Option<String>) -> Result<Option<T>, String> {
    s.map(|v| from_json(&v)).transpose()
}

// ==================== Row → 领域对象 ====================

/// 将领域层 String 错误包装为 rusqlite::Error（query_map 要求）
pub(crate) fn row_err(e: String) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnName(e)
}

pub(crate) fn session_from_row(row: &Row) -> Result<Session, String> {
    let params_json: String = row.get("params").map_err(|e| e.to_string())?;
    let tags_json: String = row.get("tags").map_err(|e| e.to_string())?;
    Ok(Session {
        id: row.get("id").map_err(|e| e.to_string())?,
        title: row.get("title").map_err(|e| e.to_string())?,
        messages: Vec::new(), // 拆表，消息单独加载
        provider_config_id: row.get("provider_config_id").map_err(|e| e.to_string())?,
        model_id: row.get("model_id").map_err(|e| e.to_string())?,
        system_prompt: row.get("system_prompt").map_err(|e| e.to_string())?,
        params: from_json(&params_json)?,
        created_at: row.get("created_at").map_err(|e| e.to_string())?,
        updated_at: row.get("updated_at").map_err(|e| e.to_string())?,
        pinned: row.get::<_, i64>("pinned").map_err(|e| e.to_string())? != 0,
        tags: from_json(&tags_json)?,
        workspace: row.get("workspace").map_err(|e| e.to_string())?,
        agent_id: row.get("agent_id").map_err(|e| e.to_string())?,
        allowed_tools: opt_from_json(row.get("allowed_tools").map_err(|e| e.to_string())?)?,
        skills: opt_from_json(row.get("skills").map_err(|e| e.to_string())?)?,
        system_prompt_manually_edited: row
            .get::<_, Option<i64>>("system_prompt_manually_edited")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
    })
}

pub(crate) fn message_from_row(row: &Row) -> Result<Message, String> {
    let content_json: String = row.get("content").map_err(|e| e.to_string())?;
    Ok(Message {
        id: row.get("id").map_err(|e| e.to_string())?,
        role: row.get("role").map_err(|e| e.to_string())?,
        content: from_json(&content_json)?,
        tool_calls: opt_from_json(row.get("tool_calls").map_err(|e| e.to_string())?)?,
        reasoning_content: row.get("reasoning_content").map_err(|e| e.to_string())?,
        tool_call_id: row.get("tool_call_id").map_err(|e| e.to_string())?,
        is_error: row
            .get::<_, Option<i64>>("is_error")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        elapsed_ms: row.get("elapsed_ms").map_err(|e| e.to_string())?,
        reasoning_elapsed_ms: row.get("reasoning_elapsed_ms").map_err(|e| e.to_string())?,
        ui_data: opt_from_json(row.get("ui_data").map_err(|e| e.to_string())?)?,
        timestamp: row.get("timestamp").map_err(|e| e.to_string())?,
        streaming: row
            .get::<_, Option<i64>>("streaming")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        model: row.get("model").map_err(|e| e.to_string())?,
        usage: opt_from_json(row.get("usage").map_err(|e| e.to_string())?)?,
        image_vision_analyze_optimize: row
            .get::<_, Option<i64>>("image_vision_analyze_optimize")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        image_vision_analyze_result: row
            .get("image_vision_analyze_result")
            .map_err(|e| e.to_string())?,
    })
}

/// 读取一行消息并附带其 rowid（分页游标）
pub(crate) fn message_from_row_with_id(row: &Row) -> Result<(i64, Message), String> {
    let rowid: i64 = row.get("message_rowid").map_err(|e| e.to_string())?;
    Ok((rowid, message_from_row(row)?))
}

/// 从消息 content 中提取纯文本（content 为字符串或 `[{type:"text",text}]` 块数组）。
/// 图片 / 文件 / 引用 / 技能块直接忽略：图片不含可检索文本，文件只有路径，
/// 引用正文来自另一条消息（重复进索引会让同一段落命中两次），
/// 技能块是整份 SKILL.md（体量大，进索引会把会话检索冲淡）。不截断。
pub(crate) fn content_plain_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        // 文本块之间用换行分隔：直接首尾相接会把相邻块拼成一个词，
        // 导致「跨块短语」被误命中（如 "你" + "好" 被拼成 "你好"）。
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    block.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 从消息 content 中提取纯文本，并截断到 `max_chars` 个字符
///（供锚点列表摘要用，避免把图片 base64 等大字段带出去）。
pub(crate) fn content_text_preview(content: &serde_json::Value, max_chars: usize) -> String {
    content_plain_text(content).chars().take(max_chars).collect()
}

/// 按字符数截断（超出追加省略号）
pub(crate) fn truncate_chars(chars: &[char], max: usize) -> String {
    if chars.len() <= max {
        chars.iter().collect()
    } else {
        let mut s: String = chars.iter().take(max).collect();
        s.push('…');
        s
    }
}

// ==================== 参数序列化 ====================

pub(crate) fn session_insert_params(session: &Session) -> Result<Vec<Box<dyn rusqlite::ToSql + Send>>, String> {
    Ok(vec![
        Box::new(session.id.clone()),
        Box::new(session.title.clone()),
        Box::new(session.provider_config_id.clone()),
        Box::new(session.model_id.clone()),
        Box::new(session.system_prompt.clone()),
        Box::new(to_json(&session.params)?),
        Box::new(session.created_at),
        Box::new(session.updated_at),
        Box::new(if session.pinned { 1 } else { 0 }),
        Box::new(to_json(&session.tags)?),
        Box::new(session.workspace.clone()),
        Box::new(session.agent_id.clone()),
        Box::new(opt_to_json(&session.allowed_tools)?),
        Box::new(opt_to_json(&session.skills)?),
        Box::new(
            session
                .system_prompt_manually_edited
                .map(|v| if v { 1 } else { 0 }),
        ),
    ])
}

pub(crate) fn message_insert_params(
    session_id: &str,
    message: &Message,
) -> Result<Vec<Box<dyn rusqlite::ToSql + Send>>, String> {
    Ok(vec![
        Box::new(message.id.clone()),
        Box::new(session_id.to_string()),
        Box::new(message.role.clone()),
        Box::new(to_json(&message.content)?),
        Box::new(opt_to_json(&message.tool_calls)?),
        Box::new(message.reasoning_content.clone()),
        Box::new(message.tool_call_id.clone()),
        Box::new(message.is_error.map(|v| if v { 1 } else { 0 })),
        Box::new(message.elapsed_ms),
        Box::new(message.reasoning_elapsed_ms),
        Box::new(opt_to_json(&message.ui_data)?),
        Box::new(message.timestamp),
        Box::new(message.streaming.map(|v| if v { 1 } else { 0 })),
        Box::new(message.model.clone()),
        Box::new(opt_to_json(&message.usage)?),
        Box::new(message.image_vision_analyze_optimize.map(|v| if v { 1 } else { 0 })),
        Box::new(message.image_vision_analyze_result.clone()),
        // 纯文本正文：供 FTS5 索引 / LIKE 回退 / 命中片段（避免扫描 JSON 键名）
        Box::new(content_plain_text(&message.content)),
    ])
}
