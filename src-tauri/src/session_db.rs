//! 会话持久化 — SQLite 直落（不经过 JS/IndexedDB）
//!
//! 目标：即使前端 WebView JS 卡住/崩溃，会话与消息也能由 Rust 侧直接落库。
//!
//! - `SessionRepo` trait：引擎与 Tauri 命令共用的持久化接口
//! - `SqliteSessionRepo`：rusqlite 实现（WAL + Mutex 单写连接 + spawn_blocking）
//! - `NoopSessionRepo`：测试 / 无 SQLite 环境兜底（不持久化）
//!
//! 表结构：`sessions`（会话元数据）+ `messages`（消息，rowid 排序）拆表。
//! 复杂字段（params / tags / content / tool_calls / ui_data 等）以 JSON 列存储。

use crate::agent::types::{Message, Session};
use async_trait::async_trait;
use rusqlite::{params, Connection, Row};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::{Arc, Mutex};

// ==================== 分页结果 ====================

/// 会话消息分页结果（尾部窗口加载用）
///
/// 前端切换会话时只取「最近 limit 条」，向上滚动再用 `oldest_rowid` 回补更早的历史，
/// 避免一次性把数千条消息经 IPC 全部搬到前端造成的加载卡顿。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    /// 本页消息（按插入顺序升序）
    pub messages: Vec<Message>,
    /// 是否还有更早的消息可供回补
    pub has_more: bool,
    /// 本页最旧消息的 rowid（作为下一页的 before_rowid）
    pub oldest_rowid: Option<i64>,
}

/// 会话内「用户消息」的轻量索引项（右侧锚点列表用）
///
/// 只包含 id 与纯文本摘要，不含 assistant / tool 消息的大量正文，
/// 因此即使会话有数千条消息，也能一次性取回而不重新引入加载卡顿。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessageRef {
    pub id: String,
    /// 纯文本摘要（已截断）
    pub preview: String,
}

// ==================== Trait ====================

#[async_trait]
pub trait SessionRepo: Send + Sync {
    /// 写入/更新会话元数据（幂等，按 id）
    async fn upsert_session(&self, session: &Session) -> Result<(), String>;
    /// 追加消息并刷新会话 updated_at（事务；按消息 id 幂等，重复写入保留原 rowid，不改变读取顺序）
    async fn append_messages(
        &self,
        session_id: &str,
        messages: &[Message],
        updated_at: i64,
    ) -> Result<(), String>;
    /// 整批替换会话的全部消息（事务；用于前端上下文压缩等全量替换场景）
    async fn replace_messages(
        &self,
        session_id: &str,
        messages: &[Message],
        updated_at: i64,
    ) -> Result<(), String>;
    /// 列出所有会话（不含 messages，按 updated_at 降序）
    async fn list_sessions(&self) -> Result<Vec<Session>, String>;
    /// 获取单个会话元数据（不含 messages）
    async fn get_session(&self, session_id: &str) -> Result<Option<Session>, String>;
    /// 获取会话的全部消息（按插入顺序）
    async fn get_messages(&self, session_id: &str) -> Result<Vec<Message>, String>;
    /// 分页获取会话消息（默认取尾部窗口；`before_rowid` 用于向上回补更早的历史）
    async fn get_message_page(
        &self,
        session_id: &str,
        limit: usize,
        before_rowid: Option<i64>,
    ) -> Result<MessagePage, String>;
    /// 获取会话内全部「用户消息」的轻量索引（id + 纯文本摘要，按插入顺序升序）
    async fn get_user_message_refs(&self, session_id: &str) -> Result<Vec<UserMessageRef>, String>;
    /// 删除会话及其全部消息
    async fn delete_session(&self, session_id: &str) -> Result<(), String>;
}

// ==================== Noop 实现（测试 / 兜底） ====================

/// 不持久化的空实现 — AgentEngine::new 默认使用，保持现有测试行为
#[derive(Default)]
pub struct NoopSessionRepo;

#[async_trait]
impl SessionRepo for NoopSessionRepo {
    async fn upsert_session(&self, _session: &Session) -> Result<(), String> {
        Ok(())
    }
    async fn append_messages(
        &self,
        _session_id: &str,
        _messages: &[Message],
        _updated_at: i64,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn replace_messages(
        &self,
        _session_id: &str,
        _messages: &[Message],
        _updated_at: i64,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn list_sessions(&self) -> Result<Vec<Session>, String> {
        Ok(Vec::new())
    }
    async fn get_session(&self, _session_id: &str) -> Result<Option<Session>, String> {
        Ok(None)
    }
    async fn get_messages(&self, _session_id: &str) -> Result<Vec<Message>, String> {
        Ok(Vec::new())
    }
    async fn get_message_page(
        &self,
        _session_id: &str,
        _limit: usize,
        _before_rowid: Option<i64>,
    ) -> Result<MessagePage, String> {
        Ok(MessagePage {
            messages: Vec::new(),
            has_more: false,
            oldest_rowid: None,
        })
    }
    async fn get_user_message_refs(
        &self,
        _session_id: &str,
    ) -> Result<Vec<UserMessageRef>, String> {
        Ok(Vec::new())
    }
    async fn delete_session(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
}

// ==================== SQLite 实现 ====================

pub struct SqliteSessionRepo {
    conn: Arc<Mutex<Connection>>,
}

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  workspace TEXT,
  agent_id TEXT,
  allowed_tools TEXT,
  skills TEXT,
  system_prompt_manually_edited INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  reasoning_content TEXT,
  tool_call_id TEXT,
  is_error INTEGER,
  elapsed_ms INTEGER,
  reasoning_elapsed_ms INTEGER,
  ui_data TEXT,
  timestamp INTEGER NOT NULL,
  streaming INTEGER,
  model TEXT,
  usage TEXT,
  image_vision_analyze_optimize INTEGER,
  image_vision_analyze_result TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
-- 锚点列表的「用户消息轻量索引」查询：先按 (session_id, role) 定位，避免读取全部正文行
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);
"#;

impl SqliteSessionRepo {
    /// 打开（或创建）数据库并初始化表结构
    pub fn open(db_path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {}", e))?;
        }
        let conn = Connection::open(db_path).map_err(|e| format!("打开 SQLite 失败: {}", e))?;
        // WAL：读不阻塞写，适合「JS 只读 + Rust 写」并发场景
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
        conn.execute_batch(DDL)
            .map_err(|e| format!("初始化表结构失败: {}", e))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

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
fn row_err(e: String) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnName(e)
}

fn session_from_row(row: &Row) -> Result<Session, String> {
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

fn message_from_row(row: &Row) -> Result<Message, String> {
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
fn message_from_row_with_id(row: &Row) -> Result<(i64, Message), String> {
    let rowid: i64 = row.get("message_rowid").map_err(|e| e.to_string())?;
    Ok((rowid, message_from_row(row)?))
}

/// 从消息 content 中提取纯文本（content 为字符串或 `[{type:"text",text}]` 块数组），
/// 并截断到 `max_chars` 个字符（供锚点列表摘要用，避免把图片 base64 等大字段带出去）。
fn content_text_preview(content: &serde_json::Value, max_chars: usize) -> String {
    let mut text = String::new();
    match content {
        serde_json::Value::String(s) => text.push_str(s),
        serde_json::Value::Array(blocks) => {
            for block in blocks {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                }
            }
        }
        _ => {}
    }
    text.chars().take(max_chars).collect()
}

// ==================== 参数序列化 ====================

fn session_insert_params(session: &Session) -> Result<Vec<Box<dyn rusqlite::ToSql + Send>>, String> {
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

fn message_insert_params(
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
    ])
}

// ==================== SessionRepo 实现 ====================

#[async_trait]
impl SessionRepo for SqliteSessionRepo {
    async fn upsert_session(&self, session: &Session) -> Result<(), String> {
        let conn = self.conn.clone();
        let session = session.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let params = session_insert_params(&session)?;
            conn.execute(
                r#"
INSERT INTO sessions (
  id, title, provider_config_id, model_id, system_prompt, params,
  created_at, updated_at, pinned, tags, workspace, agent_id,
  allowed_tools, skills, system_prompt_manually_edited
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
ON CONFLICT(id) DO UPDATE SET
  title=excluded.title,
  provider_config_id=excluded.provider_config_id,
  model_id=excluded.model_id,
  system_prompt=excluded.system_prompt,
  params=excluded.params,
  updated_at=excluded.updated_at,
  pinned=excluded.pinned,
  tags=excluded.tags,
  workspace=excluded.workspace,
  agent_id=excluded.agent_id,
  allowed_tools=excluded.allowed_tools,
  skills=excluded.skills,
  system_prompt_manually_edited=excluded.system_prompt_manually_edited
"#,
                rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            )
            .map_err(|e| format!("写入会话失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn append_messages(
        &self,
        session_id: &str,
        messages: &[Message],
        updated_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            {
                let mut stmt = tx
                    .prepare(
                        r#"
INSERT INTO messages (
  id, session_id, role, content, tool_calls, reasoning_content, tool_call_id,
  is_error, elapsed_ms, reasoning_elapsed_ms, ui_data, timestamp, streaming,
  model, usage, image_vision_analyze_optimize, image_vision_analyze_result
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
ON CONFLICT(id) DO UPDATE SET
  role=excluded.role,
  content=excluded.content,
  tool_calls=excluded.tool_calls,
  reasoning_content=excluded.reasoning_content,
  tool_call_id=excluded.tool_call_id,
  is_error=excluded.is_error,
  elapsed_ms=excluded.elapsed_ms,
  reasoning_elapsed_ms=excluded.reasoning_elapsed_ms,
  ui_data=excluded.ui_data,
  timestamp=excluded.timestamp,
  streaming=excluded.streaming,
  model=excluded.model,
  usage=excluded.usage,
  image_vision_analyze_optimize=excluded.image_vision_analyze_optimize,
  image_vision_analyze_result=excluded.image_vision_analyze_result
"#,
                    )
                    .map_err(|e| format!("准备消息写入失败: {}", e))?;
                for m in &messages {
                    let params = message_insert_params(&session_id, m)?;
                    stmt.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
                        .map_err(|e| format!("写入消息失败: {}", e))?;
                }
            }
            tx.execute(
                "UPDATE sessions SET updated_at=?1 WHERE id=?2",
                params![updated_at, session_id],
            )
            .map_err(|e| format!("刷新会话时间失败: {}", e))?;
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn replace_messages(
        &self,
        session_id: &str,
        messages: &[Message],
        updated_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            tx.execute(
                "DELETE FROM messages WHERE session_id=?1",
                params![session_id],
            )
            .map_err(|e| format!("清空消息失败: {}", e))?;
            {
                let mut stmt = tx
                    .prepare(
                        r#"
INSERT INTO messages (
  id, session_id, role, content, tool_calls, reasoning_content, tool_call_id,
  is_error, elapsed_ms, reasoning_elapsed_ms, ui_data, timestamp, streaming,
  model, usage, image_vision_analyze_optimize, image_vision_analyze_result
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
"#,
                    )
                    .map_err(|e| format!("准备消息写入失败: {}", e))?;
                for m in &messages {
                    let params = message_insert_params(&session_id, m)?;
                    stmt.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
                        .map_err(|e| format!("写入消息失败: {}", e))?;
                }
            }
            tx.execute(
                "UPDATE sessions SET updated_at=?1 WHERE id=?2",
                params![updated_at, session_id],
            )
            .map_err(|e| format!("刷新会话时间失败: {}", e))?;
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<Session>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| session_from_row(row).map_err(row_err))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_session(&self, session_id: &str) -> Result<Option<Session>, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Option<Session>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM sessions WHERE id=?1")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt
                .query_map(params![session_id], |row| {
                    session_from_row(row).map_err(row_err)
                })
                .map_err(|e| e.to_string())?;
            rows.next().transpose().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_messages(&self, session_id: &str) -> Result<Vec<Message>, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<Message>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM messages WHERE session_id=?1 ORDER BY rowid ASC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![session_id], |row| {
                    message_from_row(row).map_err(row_err)
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_message_page(
        &self,
        session_id: &str,
        limit: usize,
        before_rowid: Option<i64>,
    ) -> Result<MessagePage, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let limit = limit.max(1);
        tokio::task::spawn_blocking(move || -> Result<MessagePage, String> {
            let conn = conn.lock().unwrap();
            // 多取 1 条用于判断「是否还有更早的消息」
            let probe = (limit + 1) as i64;
            let mut rows_buf: Vec<(i64, Message)> = Vec::new();
            match before_rowid {
                Some(before) => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT rowid AS message_rowid, * FROM messages \
                             WHERE session_id=?1 AND rowid < ?2 ORDER BY rowid DESC LIMIT ?3",
                        )
                        .map_err(|e| format!("准备分页查询失败: {}", e))?;
                    let rows = stmt
                        .query_map(params![session_id, before, probe], |row| {
                            message_from_row_with_id(row).map_err(row_err)
                        })
                        .map_err(|e| e.to_string())?;
                    for r in rows {
                        rows_buf.push(r.map_err(|e| e.to_string())?);
                    }
                }
                None => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT rowid AS message_rowid, * FROM messages \
                             WHERE session_id=?1 ORDER BY rowid DESC LIMIT ?2",
                        )
                        .map_err(|e| format!("准备分页查询失败: {}", e))?;
                    let rows = stmt
                        .query_map(params![session_id, probe], |row| {
                            message_from_row_with_id(row).map_err(row_err)
                        })
                        .map_err(|e| e.to_string())?;
                    for r in rows {
                        rows_buf.push(r.map_err(|e| e.to_string())?);
                    }
                }
            }
            let has_more = rows_buf.len() > limit;
            if has_more {
                rows_buf.truncate(limit);
            }
            // 查询为 rowid DESC（新→旧），反转为升序（旧→新）
            rows_buf.reverse();
            let oldest_rowid = rows_buf.first().map(|(rid, _)| *rid);
            Ok(MessagePage {
                messages: rows_buf.into_iter().map(|(_, m)| m).collect(),
                has_more,
                oldest_rowid,
            })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_user_message_refs(
        &self,
        session_id: &str,
    ) -> Result<Vec<UserMessageRef>, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<UserMessageRef>, String> {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT id, content FROM messages \
                     WHERE session_id=?1 AND role='user' ORDER BY rowid ASC",
                )
                .map_err(|e| format!("准备用户消息索引查询失败: {}", e))?;
            let rows = stmt
                .query_map(params![session_id], |row| {
                    let id: String = row.get("id")?;
                    let content_json: String = row.get("content")?;
                    let content: serde_json::Value = serde_json::from_str(&content_json)
                        .map_err(|e| row_err(format!("反序列化消息内容失败: {}", e)))?;
                    Ok(UserMessageRef {
                        id,
                        preview: content_text_preview(&content, 420),
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            tx.execute(
                "DELETE FROM messages WHERE session_id=?1",
                params![session_id],
            )
            .map_err(|e| format!("删除消息失败: {}", e))?;
            tx.execute("DELETE FROM sessions WHERE id=?1", params![session_id])
                .map_err(|e| format!("删除会话失败: {}", e))?;
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
}

// ==================== 初始化 ====================

/// 初始化 SQLite 会话存储（应用启动时调用），返回可管理的 repo
pub fn init_session_db(
    app: &tauri::AppHandle,
) -> Result<Arc<dyn SessionRepo>, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let db_path = data_dir.join("virlen.db");
    let repo = SqliteSessionRepo::open(&db_path)?;
    Ok(Arc::new(repo))
}

// ==================== Tauri 命令 ====================

/// 记录一次 SQLite 操作（§12.13 rust.db.op / rust.db.error）
fn track_db(
    op: &str,
    session_id: Option<&str>,
    started: i64,
    rows: Option<usize>,
    error: Option<&str>,
) {
    let mut props = serde_json::json!({
        "op": op,
        "duration_ms": crate::telemetry::now_ms() - started,
        "status": if error.is_some() { "fail" } else { "success" },
    });
    if let Some(map) = props.as_object_mut() {
        if let Some(id) = session_id {
            map.insert(
                "session_id".into(),
                serde_json::json!(crate::telemetry::hash_id(id)),
            );
        }
        if let Some(r) = rows {
            map.insert("rows".into(), serde_json::json!(r));
        }
    }
    crate::telemetry::track("rust.db.op", props);
    if let Some(e) = error {
        crate::telemetry::track(
            "rust.db.error",
            serde_json::json!({ "op": op, "error": e }),
        );
    }
}

/// 列出所有会话（不含 messages）
#[tauri::command]
pub async fn cmd_list_sessions(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
) -> Result<Vec<Session>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.list_sessions().await;
    track_db(
        "list",
        None,
        started,
        result.as_ref().ok().map(|v| v.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 获取单个会话元数据
#[tauri::command]
pub async fn cmd_get_session(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<Option<Session>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.get_session(&session_id).await;
    track_db(
        "get_session",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|o| o.is_some() as usize),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 获取会话的全部消息
#[tauri::command]
pub async fn cmd_get_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<Vec<Message>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.get_messages(&session_id).await;
    track_db(
        "get_messages",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|v| v.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 分页获取会话消息（尾部窗口加载：只取最近 N 条，向上滚动时按 before_rowid 回补）
#[tauri::command]
pub async fn cmd_get_message_page(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    limit: Option<usize>,
    before_rowid: Option<i64>,
) -> Result<MessagePage, String> {
    let started = crate::telemetry::now_ms();
    let limit = limit.unwrap_or(60).clamp(1, 1000);
    let result = state.get_message_page(&session_id, limit, before_rowid).await;
    track_db(
        "get_messages_page",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|p| p.messages.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 获取会话内全部用户消息的轻量索引（右侧锚点列表用，不含 AI / 工具正文）
#[tauri::command]
pub async fn cmd_get_user_message_refs(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<Vec<UserMessageRef>, String> {
    let started = crate::telemetry::now_ms();
    let result = state.get_user_message_refs(&session_id).await;
    track_db(
        "get_user_message_refs",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|v| v.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 写入/更新会话元数据（前端创建/改名/pin 时调用）
#[tauri::command]
pub async fn cmd_upsert_session(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session: Session,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let result = state.upsert_session(&session).await;
    track_db(
        "upsert",
        Some(&session.id),
        started,
        None,
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 删除会话及其消息
#[tauri::command]
pub async fn cmd_delete_session(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let result = state.delete_session(&session_id).await;
    track_db(
        "delete",
        Some(&session_id),
        started,
        None,
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 整批替换会话的全部消息（前端上下文压缩等全量替换场景）
#[tauri::command]
pub async fn cmd_replace_session_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = messages.len();
    let result = state
        .replace_messages(
            &session_id,
            &messages,
            chrono::Utc::now().timestamp_millis(),
        )
        .await;
    track_db(
        "replace",
        Some(&session_id),
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 追加消息（前端 TS 引擎路径落库用；Rust 引擎路径由引擎内部直落）
#[tauri::command]
pub async fn cmd_append_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = messages.len();
    let result = state
        .append_messages(
            &session_id,
            &messages,
            chrono::Utc::now().timestamp_millis(),
        )
        .await;
    track_db(
        "append",
        Some(&session_id),
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::SessionParams;
    use serde_json::json;

    fn test_session(id: &str, title: &str, updated_at: i64) -> Session {
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

    fn test_message(id: &str, role: &str) -> Message {
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

    fn open_tmp() -> SqliteSessionRepo {
        let dir = std::env::temp_dir().join(format!("virlen_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        SqliteSessionRepo::open(&dir.join("test.db")).unwrap()
    }

    #[tokio::test]
    async fn upsert_and_read_roundtrip() {
        let repo = open_tmp();
        let s = test_session("s1", "title", 100);
        repo.upsert_session(&s).await.unwrap();

        let loaded = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(loaded.id, "s1");
        assert_eq!(loaded.title, "title");
        assert_eq!(loaded.model_id, "gpt-4o");
        assert_eq!(loaded.tags, vec!["tag1".to_string()]);
        assert_eq!(loaded.allowed_tools, Some(vec!["read_file".to_string()]));
        assert_eq!(loaded.system_prompt_manually_edited, Some(true));
        assert_eq!(loaded.params.max_tokens, 1000);
    }

    #[tokio::test]
    async fn upsert_is_idempotent() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "v1", 100)).await.unwrap();
        repo.upsert_session(&test_session("s1", "v2", 200)).await.unwrap();
        let loaded = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(loaded.title, "v2");
        assert_eq!(loaded.updated_at, 200);
    }

    #[tokio::test]
    async fn append_and_get_messages_ordered() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
            200,
        )
        .await
        .unwrap();

        let msgs = repo.get_messages("s1").await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[1].id, "m2");
        // updated_at 被刷新
        let s = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s.updated_at, 200);
    }

    #[tokio::test]
    async fn append_messages_idempotent() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")], 200).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")], 300).await.unwrap();
        let msgs = repo.get_messages("s1").await.unwrap();
        assert_eq!(msgs.len(), 1, "重复写入同一 id 应幂等");
    }

    #[tokio::test]
    async fn reappend_keeps_message_order() {
        // 回归：重复写入已存在的“中间消息”不得改变读取顺序（保留原 rowid）
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")], 200).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m2", "assistant"), test_message("m3", "tool")],
            300,
        )
        .await
        .unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")], 400).await.unwrap();
        let msgs = repo.get_messages("s1").await.unwrap();
        let ids: Vec<&str> = msgs.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m2", "m3"], "重复写入同 id 不应把消息挪到末尾");
    }

    #[tokio::test]
    async fn replace_messages_swaps_all() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
            200,
        )
        .await
        .unwrap();
        // 压缩后整体替换为新的消息列表
        repo.replace_messages(
            "s1",
            &[test_message("m9", "user"), test_message("m10", "assistant")],
            300,
        )
        .await
        .unwrap();
        let msgs = repo.get_messages("s1").await.unwrap();
        assert_eq!(msgs.len(), 2, "替换后不应残留旧消息");
        assert_eq!(msgs[0].id, "m9");
        assert_eq!(msgs[1].id, "m10");
        let s = repo.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s.updated_at, 300);
    }

    #[tokio::test]
    async fn delete_removes_session_and_messages() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages("s1", &[test_message("m1", "user")], 200).await.unwrap();
        repo.delete_session("s1").await.unwrap();
        assert!(repo.get_session("s1").await.unwrap().is_none());
        assert!(repo.get_messages("s1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_sessions_sorted_desc() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("a", "A", 100)).await.unwrap();
        repo.upsert_session(&test_session("b", "B", 300)).await.unwrap();
        repo.upsert_session(&test_session("c", "C", 200)).await.unwrap();
        let list = repo.list_sessions().await.unwrap();
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[tokio::test]
    async fn page_returns_tail_window_in_order() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let msgs: Vec<Message> = (1..=10)
            .map(|i| test_message(&format!("m{}", i), "user"))
            .collect();
        repo.append_messages("s1", &msgs, 200).await.unwrap();

        // 尾部窗口：最后 4 条（且为升序）
        let p1 = repo.get_message_page("s1", 4, None).await.unwrap();
        let ids1: Vec<&str> = p1.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids1, vec!["m7", "m8", "m9", "m10"]);
        assert!(p1.has_more);
        let cursor1 = p1.oldest_rowid.expect("尾部页应有 oldest_rowid");

        // 向上回补：再取 4 条
        let p2 = repo.get_message_page("s1", 4, Some(cursor1)).await.unwrap();
        let ids2: Vec<&str> = p2.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids2, vec!["m3", "m4", "m5", "m6"]);
        assert!(p2.has_more);
        let cursor2 = p2.oldest_rowid.unwrap();

        // 最后一页：只剩 2 条，无更多
        let p3 = repo.get_message_page("s1", 4, Some(cursor2)).await.unwrap();
        let ids3: Vec<&str> = p3.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids3, vec!["m1", "m2"]);
        assert!(!p3.has_more);
    }

    #[tokio::test]
    async fn page_marks_no_more_when_session_smaller_than_limit() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
            200,
        )
        .await
        .unwrap();
        let p = repo.get_message_page("s1", 60, None).await.unwrap();
        assert_eq!(p.messages.len(), 2);
        assert!(!p.has_more, "消息数少于 limit 时不应标记 has_more");
    }

    #[tokio::test]
    async fn page_is_empty_for_missing_session() {
        let repo = open_tmp();
        let p = repo.get_message_page("nope", 60, None).await.unwrap();
        assert!(p.messages.is_empty());
        assert!(!p.has_more);
        assert!(p.oldest_rowid.is_none());
    }

    #[tokio::test]
    async fn user_message_refs_only_returns_user_messages_in_order() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut assistant = test_message("m2", "assistant");
        assistant.content = json!("assistant reply");
        // 带图片块 + 文本块的 user 消息：摘要应只取 text 块
        let mut with_image = test_message("m3", "user");
        with_image.content = json!([
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
            { "type": "text", "text": "看看这张图" }
        ]);
        repo.append_messages(
            "s1",
            &[
                test_message("m1", "user"),
                assistant,
                with_image,
                test_message("m4", "tool"),
            ],
            200,
        )
        .await
        .unwrap();

        let refs = repo.get_user_message_refs("s1").await.unwrap();
        let ids: Vec<&str> = refs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "m3"], "只返回 user 消息且保持插入顺序");
        assert_eq!(refs[0].preview, "hello");
        assert_eq!(refs[1].preview, "看看这张图");
    }

    #[tokio::test]
    async fn user_message_refs_truncates_preview_to_420_chars() {
        let repo = open_tmp();
        repo.upsert_session(&test_session("s1", "t", 100)).await.unwrap();
        let mut long = test_message("m1", "user");
        long.content = json!("字".repeat(600));
        repo.append_messages("s1", &[long], 200).await.unwrap();

        let refs = repo.get_user_message_refs("s1").await.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].preview.chars().count(), 420);
    }
}
