//! `SqliteSessionRepo`：会话持久化的 rusqlite 实现
//!
//! WAL + Mutex 单写连接 + spawn_blocking：写路径全部在阻塞线程里跑，不占用 tokio 工作线程。
//! 会话 / 消息 / 检索的 trait 实现集中在此；消息查询与用量账本的具体实现分别见
//! `message_query.rs` 与 `usage.rs`，本文件只做转发。

use crate::agent::types::{Message, Session};
use crate::session_db::maintenance::WAL_SIZE_LIMIT;
use crate::session_db::message_query;
use crate::session_db::repo::SessionRepo;
use crate::session_db::row::{
    content_text_preview, message_from_row, message_from_row_with_id, message_insert_params,
    row_err, session_from_row, session_insert_params,
};
use crate::session_db::schema::{
    backfill_text_plain, init_schema, FTS_TRIGGERS_DDL, SCHEMA_VERSION, SEARCH_INDEX_DDL,
};
use crate::session_db::types::{
    MessagePage, MessageSearchPage, MessageTimelinePage, MessageWindow, SearchCursor,
    SessionStat, UserMessageRef,
};
use crate::session_db::usage::{
    self, backfill_usage_ledger, repair_usage_ledger_model, UsageEntry, UsageQuery,
    UsageRecordPage, UsageStats,
};
use async_trait::async_trait;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct SqliteSessionRepo {
    pub(crate) conn: Arc<Mutex<Connection>>,
    /// 历史数据迁移（回填 `text_plain` + 重建 FTS）是否已完成。
    /// 未完成时 `search_messages` 回退到旧的 `LIKE content` 路径，保证检索依然正确（略慢）。
    migration_done: Arc<AtomicBool>,
}

impl SqliteSessionRepo {
    /// 打开（或创建）数据库并初始化表结构（**不做耗时迁移**）
    ///
    /// 快速的 schema 初始化（建表 / 补列 / 建 FTS 表 / 空库建检索索引）同步完成；
    /// 历史数据的大批量回填与索引重建由 `migrate()` 在后台执行，
    /// 避免超大库首次启动时卡住。
    pub fn open(db_path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {}", e))?;
        }
        let conn = Connection::open(db_path).map_err(|e| format!("打开 SQLite 失败: {}", e))?;
        // WAL：读不阻塞写，适合「JS 只读 + Rust 写」并发场景
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
        // WAL 文件封顶（见 `maintenance::WAL_SIZE_LIMIT`）：不设上限时 `-wal` 会一直保持
        // 历史高水位（实测 99 MB），而它只是「还没并进主库的页」，本不该长期占盘。
        let _ = conn.pragma_update(None, "journal_size_limit", WAL_SIZE_LIMIT);
        let migration_done = init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            migration_done: Arc::new(AtomicBool::new(migration_done)),
        })
    }

    /// 后台迁移是否已完成（未完成时检索回退到旧的 `LIKE content` 路径）
    pub fn migration_done(&self) -> bool {
        self.migration_done.load(Ordering::Acquire)
    }

    /// 执行历史数据迁移：回填 `text_plain` 并重建 FTS 索引（幂等、可重入）。
    ///
    /// 由 `init_session_db` 在后台任务里调用。耗时的回填按批进行并在批间释放连接锁，
    /// 不会长时间阻塞其它 DB 操作；「建检索索引 + 重建 FTS + 建触发器 + 落版本号」放在
    /// 同一把锁内原子完成，避免新写入漏建索引。
    pub async fn migrate(&self) -> Result<(), String> {
        if self.migration_done() {
            return Ok(());
        }
        let conn = self.conn.clone();
        let done = self.migration_done.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            backfill_text_plain(&conn)?;
            // v1 → v2：从 messages.usage 回填历史用量（幂等；否则老用户升级后统计从 0 开始）
            backfill_usage_ledger(&conn)?;
            // v2 → v3：修补历史流水的 model（回填早于本修补的用户，历史用量费用会是 0）
            repair_usage_ledger_model(&conn)?;
            {
                let c = conn.lock().unwrap();
                c.execute_batch(SEARCH_INDEX_DDL)
                    .map_err(|e| format!("初始化检索索引失败: {}", e))?;
                c.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')", [])
                    .map_err(|e| format!("重建 FTS 索引失败: {}", e))?;
                c.execute_batch(FTS_TRIGGERS_DDL)
                    .map_err(|e| format!("初始化 FTS 触发器失败: {}", e))?;
                c.pragma_update(None, "user_version", SCHEMA_VERSION)
                    .map_err(|e| format!("更新 schema 版本失败: {}", e))?;
            }
            done.store(true, Ordering::Release);
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
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
    ) -> Result<(), String> {
        self.append_messages_inner(session_id, messages, false)
            .await
            .map(|_| ())
    }

    async fn append_messages_if_alive(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<bool, String> {
        self.append_messages_inner(session_id, messages, true).await
    }

    async fn replace_messages(
        &self,
        session_id: &str,
        messages: &[Message],
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
  model, usage, image_vision_analyze_optimize, image_vision_analyze_result, text_plain
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
"#,
                    )
                    .map_err(|e| format!("准备消息写入失败: {}", e))?;
                for m in &messages {
                    let params = message_insert_params(&session_id, m)?;
                    stmt.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
                        .map_err(|e| format!("写入消息失败: {}", e))?;
                }
            }
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn truncate_messages_from(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let message_id = message_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            // 删除目标消息及其之后（rowid >= 目标）的全部消息。
            // 目标不存在时子查询为 NULL → 条件不成立 → 不删除任何行（安全幂等）。
            conn.execute(
                "DELETE FROM messages \
                 WHERE session_id=?1 \
                   AND rowid >= (SELECT rowid FROM messages WHERE id=?2 AND session_id=?1)",
                params![session_id, message_id],
            )
            .map_err(|e| format!("删除消息失败: {}", e))?;
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

    /// 批量统计：消息条数（`GROUP BY`）+ 上下文占用（每会话**最新一条**带用量的消息）。
    ///
    /// 为什么不是「逐会话 `get_messages`」：大库上那会把每个会话的**全部正文**读进内存。
    /// 占用口径见 [`crate::agent::compress::context_tokens`] —— 这里只负责挑出候选行，
    /// 判定走同一份实现（口径不出现第二份）。
    async fn session_stats(&self) -> Result<Vec<SessionStat>, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<SessionStat>, String> {
            let conn = conn.lock().unwrap();

            // ① 消息条数
            let mut counts: HashMap<String, i64> = HashMap::new();
            {
                let mut stmt = conn
                    .prepare("SELECT session_id, COUNT(*) FROM messages GROUP BY session_id")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })
                    .map_err(|e| e.to_string())?;
                for r in rows {
                    let (id, n) = r.map_err(|e| e.to_string())?;
                    counts.insert(id, n);
                }
            }

            // ② 上下文占用：选择谓词 = 「TS `findContextTokens` 会在此行 return」的两个条件
            //    （`usage` 有值 / `contextTokens > 0`），再按会话取 rowid 最大的那一行。
            //    ⚠️ 只取候选行、口径交给 Rust 侧同一份实现：SQL 里不重复写「哪个字段优先」。
            let mut ctx: HashMap<String, i64> = HashMap::new();
            {
                let mut stmt = conn
                    .prepare(
                        "SELECT session_id AS stat_session_id, * FROM messages \
                         WHERE rowid IN ( \
                             SELECT MAX(rowid) FROM messages \
                             WHERE usage IS NOT NULL \
                                OR json_extract(ui_data, '$.contextTokens') > 0 \
                             GROUP BY session_id \
                         )",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| {
                        let id: String = row.get("stat_session_id")?;
                        let m = message_from_row(row).map_err(row_err)?;
                        Ok((id, m))
                    })
                    .map_err(|e| e.to_string())?;
                for r in rows {
                    let (id, m) = r.map_err(|e| e.to_string())?;
                    if let Some(v) =
                        crate::agent::compress::context_tokens(std::slice::from_ref(&m))
                    {
                        ctx.insert(id, v);
                    }
                }
            }

            let mut ids: Vec<String> = counts.keys().chain(ctx.keys()).cloned().collect();
            ids.sort();
            ids.dedup();
            Ok(ids
                .into_iter()
                .map(|session_id| SessionStat {
                    messages: counts.get(&session_id).copied().unwrap_or(0),
                    context_tokens: ctx.get(&session_id).copied(),
                    session_id,
                })
                .collect())
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


    // ==== 消息查询（query messages 工具）：实现见 message_query.rs ====

    async fn get_message_window(
        &self,
        session_id: &str,
        anchor_id: Option<&str>,
        anchor_seq: Option<i64>,
        before: usize,
        after: usize,
    ) -> Result<MessageWindow, String> {
        message_query::get_message_window(
            self.conn.clone(),
            session_id,
            anchor_id,
            anchor_seq,
            before,
            after,
        )
        .await
    }

    async fn get_message_timeline(
        &self,
        session_id: &str,
        keyword: Option<&str>,
        before_seq: Option<i64>,
        limit: usize,
    ) -> Result<MessageTimelinePage, String> {
        message_query::get_message_timeline(
            self.conn.clone(),
            session_id,
            keyword,
            before_seq,
            limit,
        )
        .await
    }

    async fn search_messages(
        &self,
        query: &str,
        session_id: Option<&str>,
        role: Option<&str>,
        limit: usize,
        cursor: Option<SearchCursor>,
    ) -> Result<MessageSearchPage, String> {
        // 迁移未完成时检索回退到旧的 content 路径（见 message_query::search_messages）
        message_query::search_messages(
            self.conn.clone(),
            self.migration_done.load(Ordering::Acquire),
            query,
            session_id,
            role,
            limit,
            cursor,
        )
        .await
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
            // ⚠️ 刻意**不**删除 usage_ledger 中该会话的流水：
            // 用量是「已发生过的消费」的事实记录，删会话只删对话内容。
            // 标题在明细里 JOIN 不到时显示为「已删除会话」，总量不会缩水（见 docs/token-usage-stats.md）。
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn purge_orphan_messages(&self) -> Result<usize, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<usize, String> {
            let conn = conn.lock().unwrap();
            // 反连接删除：sessions.id 是 NOT NULL 主键、messages.session_id 也是 NOT NULL，
            // 不存在 NULL 使 `NOT IN` 整体为 NULL 的陷阱。
            // 删除会触发 FTS 外部内容表的 AD 触发器，索引不会残留。
            let removed = conn
                .execute(
                    "DELETE FROM messages \
                     WHERE session_id NOT IN (SELECT id FROM sessions)",
                    [],
                )
                .map_err(|e| format!("清理孤儿消息失败: {}", e))?;
            Ok(removed)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    // ===== 用量账本（token 统计）：实现见 usage.rs =====

    async fn append_usage(&self, entries: &[UsageEntry]) -> Result<(), String> {
        usage::append(self.conn.clone(), entries).await
    }

    async fn usage_stats(&self, query: &UsageQuery) -> Result<UsageStats, String> {
        usage::stats(self.conn.clone(), query).await
    }

    async fn usage_records(&self, query: &UsageQuery) -> Result<UsageRecordPage, String> {
        usage::records(self.conn.clone(), query).await
    }

    async fn clear_usage(&self) -> Result<i64, String> {
        usage::clear(self.conn.clone()).await
    }
}

impl SqliteSessionRepo {
    /// `append_messages` / `append_messages_if_alive` 的共用实现
    ///
    /// 唯一差别是 `require_alive`：为 `true` 时会话不存在则不写任何行、返回 `Ok(false)`
    /// （引擎落库专用，见 `SessionRepo::append_messages_if_alive`）。
    async fn append_messages_inner(
        &self,
        session_id: &str,
        messages: &[Message],
        require_alive: bool,
    ) -> Result<bool, String> {
        let conn = self.conn.clone();
        let session_id = session_id.to_string();
        let messages = messages.to_vec();
        tokio::task::spawn_blocking(move || -> Result<bool, String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;
            // 会话存活校验必须与写入落在**同一把连接锁 + 同一事务内**：
            // 否则「校验通过 → 会话被删 → 写入」这个小窗口仍会漏出孤儿消息。
            if require_alive {
                let alive: i64 = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
                        params![session_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| format!("校验会话是否存在失败: {}", e))?;
                if alive == 0 {
                    // 会话已被删除：不写任何行（事务未提交，drop 即回滚），
                    // 否则会留下永远查不到也清不掉的孤儿消息（库文件只增不减）
                    return Ok(false);
                }
            }
            {
                let mut stmt = tx
                    .prepare(
                        r#"
INSERT INTO messages (
  id, session_id, role, content, tool_calls, reasoning_content, tool_call_id,
  is_error, elapsed_ms, reasoning_elapsed_ms, ui_data, timestamp, streaming,
  model, usage, image_vision_analyze_optimize, image_vision_analyze_result, text_plain
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
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
  image_vision_analyze_result=excluded.image_vision_analyze_result,
  text_plain=excluded.text_plain
"#,
                    )
                    .map_err(|e| format!("准备消息写入失败: {}", e))?;
                for m in &messages {
                    let params = message_insert_params(&session_id, m)?;
                    stmt.execute(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
                        .map_err(|e| format!("写入消息失败: {}", e))?;
                }
            }
            tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
            Ok(true)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
}
