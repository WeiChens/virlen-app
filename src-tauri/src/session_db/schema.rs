//! 表结构（DDL）与 schema 初始化 / 历史数据迁移
//!
//! - 建表 / 补列 / FTS 虚表等元数据级操作走快速路径（`init_schema`）；
//! - 大批量回填（`text_plain`、用量账本）由 `migrate()` 在后台执行，避免超大库首次启动卡顿。

use crate::session_db::row::content_plain_text;
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};

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
  image_vision_analyze_result TEXT,
  -- 纯文本正文（由 content JSON 提取；供 LIKE 回退 / 命中片段 / FTS5 索引使用）
  -- NOT NULL DEFAULT ''：任何未显式提供该列的写入都落 ''，不会留下 NULL
  text_plain TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
-- 锚点列表的「用户消息轻量索引」查询：先按 (session_id, role) 定位，避免读取全部正文行
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);
"#;

/// FTS5 全文索引（外部内容表）：索引 `messages.text_plain`，rowid 与 messages.rowid 对齐，
/// 正文本身仍存于 messages，索引不重复存储内容。
/// 使用 trigram 分词器 —— 支持中文等无空格语言的字串匹配（≥3 字符子串；
/// 更短的查询无法走索引，搜索时回退到 `LIKE text_plain`，见 `search_messages`）。
const FTS_DDL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text_plain,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);
"#;

/// FTS 同步触发器（SQLite 官方推荐的外部内容表维护方式）：
/// 随 messages 增删改自动维护索引，无需在每个写路径手动同步。
pub(crate) const FTS_TRIGGERS_DDL: &str = r#"
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, COALESCE(new.text_plain, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain) VALUES('delete', old.rowid, COALESCE(old.text_plain, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain) VALUES('delete', old.rowid, COALESCE(old.text_plain, ''));
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, COALESCE(new.text_plain, ''));
END;
"#;

/// 检索的 keyset 排序 / 游标定位索引：(timestamp ASC, rowid ASC) 反向扫描即
/// (timestamp DESC, rowid DESC)，与检索的 ORDER BY 完全一致，避免大库全表排序。
///
/// ⚠️ 不放进静态 `DDL`：老库首次升级时建索引需扫描全表，若在 `open()` 同步执行会阻塞启动。
/// 因此它随「迁移」在后台完成；新建空库 / 已迁移库走 `init_schema` 快速路径
/// （表为空或已有索引，`IF NOT EXISTS` 立即返回，开销可忽略）。
pub(crate) const SEARCH_INDEX_DDL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
"#;

/// 用量账本（token 统计）DDL
///
/// 与 `messages.usage` 的关系：`messages.usage` 是「消息自带的用量」，只覆盖
/// 产生消息的 LLM 调用；账本是**每次 LLM 调用一条流水**，因此
/// （1）能覆盖标题生成 / 迭代校验等不产生消息的调用；
/// （2）独立于会话生命周期 —— 删除会话不清账，历史总量不会缩水。
/// 详见 `docs/token-usage-stats.md`。
const USAGE_LEDGER_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS usage_ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  session_id         TEXT,
  message_id         TEXT,
  model              TEXT NOT NULL DEFAULT '',
  provider_type      TEXT,
  provider_config_id TEXT,
  kind               TEXT NOT NULL,
  round              INTEGER,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  -- 缓存读/写：= total - prompt - completion（Anthropic 把 cache 计入 total；OpenAI 口径恒为 0）
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  -- 1 = 本地估算值（非 API 返回），如上下文压缩的 DeepSeek BPE 估算
  estimated          INTEGER NOT NULL DEFAULT 0,
  trace_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_ledger(session_id, ts);
-- chat_round 以 assistant 消息 id 作幂等键：流式重试 / 重放不会重复记账
-- （compress/title/verify 无 message_id，每次都是新调用，不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_message ON usage_ledger(message_id)
  WHERE message_id IS NOT NULL;
"#;

/// 当前 schema 版本（存于 `PRAGMA user_version`）。递增后由 `migrate()` 执行迁移
/// （`open()` 只做快速初始化，耗时迁移在后台完成）。
///
/// v2：新增 `usage_ledger` 表，并从 `messages.usage` 一次性回填历史用量。
/// v3：修补历史流水的 `model`（回填时 `messages.model` 其实是空的，导致历史用量费用恒为 0）。
pub(crate) const SCHEMA_VERSION: i64 = 3;

/// 快速的 schema 初始化（幂等）。返回「迁移是否已完成」。
///
/// - 建表 / 补 `text_plain` 列 / 建 FTS 虚表都是元数据级操作，开销可忽略；
/// - 是否需要大规模迁移，取决于 `PRAGMA user_version` 与表内是否已有历史数据：
///   * 已是当前版本 → 建检索索引 + 触发器，返回 true；
///   * 空表（全新库）→ 无历史数据可迁，落版本号 + 建索引 + 触发器，返回 true；
///   * 存在 `text_plain IS NULL` 的历史行（旧构建漏写）→ 返回 false，由 `migrate()` 自愈回填；
///   * 否则 → 返回 false（回填 / 建索引 / 重建 FTS / 建触发器由 `migrate()` 完成）。
pub(crate) fn init_schema(conn: &Connection) -> Result<bool, String> {
    conn.execute_batch(DDL)
        .map_err(|e| format!("初始化表结构失败: {}", e))?;
    ensure_text_plain_column(conn)?;
    conn.execute_batch(FTS_DDL)
        .map_err(|e| format!("初始化 FTS 索引失败: {}", e))?;
    // 用量账本：纯建表 + 建索引，元数据级开销，可放在快速路径
    conn.execute_batch(USAGE_LEDGER_DDL)
        .map_err(|e| format!("初始化用量账本失败: {}", e))?;

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    let has_rows: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM messages)", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        != 0;
    // 是否还有未回填的行（`text_plain IS NULL`）：历史旧构建可能漏写 `text_plain`
    // 而把值留成 NULL，且 `user_version` 已是当前版本时不会再自动触发迁移 ——
    // 这里显式检测，保证能自愈回填（否则这些行既搜不全、又可能以空正文漏出）。
    let has_null_text_plain: bool = has_rows
        && conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE text_plain IS NULL)",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0;

    if (version >= SCHEMA_VERSION || !has_rows) && !has_null_text_plain {
        // 无需迁移：建检索索引 + 触发器（保证后续写入即索引），并补齐版本号
        conn.execute_batch(SEARCH_INDEX_DDL)
            .map_err(|e| format!("初始化检索索引失败: {}", e))?;
        conn.execute_batch(FTS_TRIGGERS_DDL)
            .map_err(|e| format!("初始化 FTS 触发器失败: {}", e))?;
        if version < SCHEMA_VERSION {
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| format!("更新 schema 版本失败: {}", e))?;
        }
        return Ok(true);
    }
    Ok(false)
}

/// 老库补 `text_plain` 列（新库由 DDL 直接建出，这里检测后跳过）
fn ensure_text_plain_column(conn: &Connection) -> Result<(), String> {
    let exists = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(messages)")
            .map_err(|e| format!("读取 messages 表结构失败: {}", e))?;
        let mut has = false;
        {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            for name in rows {
                if let Ok(n) = name {
                    if n == "text_plain" {
                        has = true;
                        break;
                    }
                }
            }
        }
        has
    };
    if !exists {
        conn.execute("ALTER TABLE messages ADD COLUMN text_plain TEXT", [])
            .map_err(|e| format!("添加 text_plain 列失败: {}", e))?;
    }
    Ok(())
}

/// 回填 `text_plain`（仅处理 NULL 行；按批处理并在批间释放连接锁，避免长时间占用）。
pub(crate) fn backfill_text_plain(conn: &Arc<Mutex<Connection>>) -> Result<(), String> {
    const BATCH: i64 = 500;
    loop {
        let guard = conn.lock().unwrap();
        let tx = guard
            .unchecked_transaction()
            .map_err(|e| format!("开启迁移事务失败: {}", e))?;
        let batch: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, content FROM messages \
                     WHERE text_plain IS NULL ORDER BY rowid LIMIT ?1",
                )
                .map_err(|e| format!("准备回填查询失败: {}", e))?;
            let rows = stmt
                .query_map(params![BATCH], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if batch.is_empty() {
            break;
        }
        {
            let mut upd = tx
                .prepare("UPDATE messages SET text_plain=?1 WHERE id=?2")
                .map_err(|e| format!("准备回填写入失败: {}", e))?;
            for (id, content_json) in &batch {
                let content: serde_json::Value =
                    serde_json::from_str(content_json).unwrap_or(serde_json::Value::Null);
                upd.execute(params![content_plain_text(&content), id])
                    .map_err(|e| format!("回填 text_plain 失败: {}", e))?;
            }
        }
        tx.commit().map_err(|e| format!("提交迁移事务失败: {}", e))?;
        // guard 在此迭代结束时释放 → 批间归还连接锁，其它 DB 操作可穿插执行
        if (batch.len() as i64) < BATCH {
            break;
        }
    }
    Ok(())
}
