//! 表结构（DDL）与 schema 初始化 / 历史数据迁移
//!
//! - 建表 / 补列 / FTS 虚表等元数据级操作走快速路径（`init_schema`）；
//! - 大批量回填（`text_plain`、用量账本）由 `migrate()` 在后台执行，避免超大库首次启动卡顿。

use crate::session_db::memory::MEMORY_DDL;
use crate::session_db::row::content_plain_text;
use crate::attachment::AttachmentStore;
use crate::agent::types::Message;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
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
///
/// ⚠️ `messages_fts_au` **必须带 `WHEN`**：没有它，任何一条 UPDATE（含流式节流落库
/// `persist_streaming_text`，700ms 一次、每次写当前全量正文）都会把整段 `text_plain` 的
/// trigram 全删重建 —— 长回复因此是近似平方级的索引写入，还会把流式循环卡在这条同步
/// UPDATE 上。外部内容表的正文取自 `messages`，只改别的列不会让索引变脏。
/// 老库上这条触发器的旧定义没有 `WHEN`，由 [`ensure_fts_update_trigger`] 在打开时替换。
pub(crate) const FTS_TRIGGERS_DDL: &str = r#"
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, COALESCE(new.text_plain, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain) VALUES('delete', old.rowid, COALESCE(old.text_plain, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages
WHEN new.text_plain IS NOT old.text_plain
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain) VALUES('delete', old.rowid, COALESCE(old.text_plain, ''));
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, COALESCE(new.text_plain, ''));
END;
"#;

/// `messages_fts_au` 的**升级版**定义（带 `WHEN`，见 [`FTS_TRIGGERS_DDL`] 的说明）。
///
/// 单独抽一份是因为 `CREATE TRIGGER IF NOT EXISTS` 换不掉老库上的旧定义 —— 必须
/// `DROP` 后重建。[`ensure_fts_update_trigger`] 只在旧定义确实缺 `WHEN` 时执行这条。
///
/// `old.text_plain IS NOT new.text_plain`：用 `IS NOT` 而不是 `<>`，任一侧为 NULL 时
/// 也能正确判定（列是 `NOT NULL DEFAULT ''`，但历史库可能残留 NULL）。
const FTS_UPDATE_TRIGGER_DDL: &str = r#"
DROP TRIGGER IF EXISTS messages_fts_au;
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages
WHEN new.text_plain IS NOT old.text_plain
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text_plain) VALUES('delete', old.rowid, COALESCE(old.text_plain, ''));
  INSERT INTO messages_fts(rowid, text_plain) VALUES (new.rowid, COALESCE(new.text_plain, ''));
END;
"#;

/// 检索的 keyset 排序 / 游标定位索引：(timestamp ASC, rowid ASC) 反向扫描即
/// (timestamp DESC, rowid DESC)，与检索的 ORDER BY 完全一致，避免大库全表排序。
///
pub(crate) const SEARCH_INDEX_DDL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
"#;

/// 用量账本（token 统计）DDL
///
/// 与 `messages.usage` 的关系：`messages.usage` 是「消息自带的用量」，只覆盖
/// 产生消息的 LLM 调用；账本是**每次 LLM 调用一条流水**，因此
/// （1）能覆盖标题生成 / 迭代校验等不产生消息的调用；
/// （2）独立于会话生命周期 —— 删除会话不清账，历史总量不会缩水。
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
  -- 缓存**命中（读取）**量：Anthropic = cache_read_input_tokens；OpenAI 兼容 / Gemini = prompt_tokens_details
  -- 口径：cached_tokens + cache_write_tokens + prompt_tokens + completion_tokens = total_tokens
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  -- 缓存**写入**量：目前只有 Anthropic 有（cache_creation_input_tokens，按 1.25x 输入价计费）；
  -- 其余 provider 恒 0。⚠️ 与 cached_tokens 必须分列：两者计价差 12.5 倍（0.1x ↔ 1.25x）
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  -- 1 = 本地估算值（非 API 返回），如上下文压缩的 DeepSeek BPE 估算
  estimated          INTEGER NOT NULL DEFAULT 0,
  -- LLM 请求耗时（ms）：0 = 未测量（历史流水 / 旧版本写的），UI 显示 '-'。
  -- 存原始耗时而不存 tok/s：单位换算与口径（是否含首字延迟）改一次不用回填历史数据
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  -- 传输侧事实（轨迹检查器「请求」页）：请求体实际字节数 / 等响应头耗时 / 等首字节耗时。
  -- 0 = 未采集（旧流水 / 桥接协议 / 非流式拿不到首字节）—— UI 显示 `-`，不得当成 0。
  request_bytes      INTEGER NOT NULL DEFAULT 0,
  response_start_ms  INTEGER NOT NULL DEFAULT 0,
  first_byte_ms      INTEGER NOT NULL DEFAULT 0,
  trace_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_ledger(session_id, ts);
-- chat_round 以 assistant 消息 id 作幂等键：流式重试 / 重放不会重复记账
-- （compress/title/verify 无 message_id，每次都是新调用，不受影响）
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_message ON usage_ledger(message_id)
  WHERE message_id IS NOT NULL;
"#;

/// 上下文压缩的**遮罩记录**（P0-3）DDL。
///
/// 一行 = 一次压缩事实：「`[start_message_id, end_message_id]` 这段原始消息在模型上下文里
/// 由 `summary_message_id` 这条消息替代」。为什么不用「最后一条 summary 的位置」表达：
/// 位置约定无法表达「只压中间一段 / 保留最近几轮」，也会随着 summary 被删 / 挪而静默失效。
/// 语义与重建规则见 `virlen-core::agent::context`。
///
/// ⚠️ 纯新增表，无历史数据要回填，所以**不递增 `SCHEMA_VERSION`**（与 `memories` 同一取舍）：
/// 递增会让 `migrate()` 对全库重建一次 FTS，白付代价。老库没有记录 → 仍走旧的位置切片。
const COMPACTIONS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS compactions (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  start_message_id   TEXT NOT NULL,
  end_message_id     TEXT NOT NULL,
  summary_message_id TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id);
"#;

/// 应用设置（配置下沉 D3）DDL
///
/// 为什么放会话库里：与会话共用**同一个 SQLite 文件与同一把单写连接** ——
/// 不需要第二个写连接（不会 `SQLITE_BUSY`），迁移 / 维护（体积 / WAL 截断 / `VACUUM`）
/// 也天然覆盖到它；CLI 与 GUI 只要指向同一个 `virlen.db` 就共用同一份配置。
/// 一 key 一行（`value` 是 JSON 文本），详见 `settings.rs`。
const SETTINGS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
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
    // 老库补丁：`messages_fts_au` 曾经没有 `WHEN`，任何 UPDATE 都会重建整段 trigram
    //（流式节流落库被放大几十倍）。这里换成带 `WHEN` 的定义；已是最新则零写入。
    ensure_fts_update_trigger(conn)?;
    // 用量账本：纯建表 + 建索引，元数据级开销，可放在快速路径
    conn.execute_batch(USAGE_LEDGER_DDL)
        .map_err(|e| format!("初始化用量账本失败: {}", e))?;
    ensure_usage_duration_column(conn)?;
    ensure_usage_cache_write_column(conn)?;
    ensure_usage_transport_columns(conn)?;
    // 应用设置（配置下沉 D3）：纯建表，元数据级开销
    conn.execute_batch(SETTINGS_DDL)
        .map_err(|e| format!("初始化应用设置表失败: {}", e))?;
    // 压缩遮罩记录（P0-3）：纯建表 + 索引，元数据级开销（同 memories 的取舍，不动 SCHEMA_VERSION）
    conn.execute_batch(COMPACTIONS_DDL)
        .map_err(|e| format!("初始化压缩记录表失败: {}", e))?;
    // 长期记忆（记忆功能 P0）：纯建表 + 索引 + FTS 虚表 + 触发器，元数据级开销。
    // ⚠️ 有意**不递增 `SCHEMA_VERSION`**：本次是纯新增、无历史数据要回填，而递增版本会让
    // `migrate()` 对全库执行一次 `messages_fts` rebuild（大库分钟级），白付代价。
    conn.execute_batch(MEMORY_DDL)
        .map_err(|e| format!("初始化记忆表失败: {}", e))?;
    // 记忆补 `project_path` 列（项目作用域）：同样是元数据级 ALTER，不占 SCHEMA_VERSION
    ensure_memories_project_path_column(conn)?;
    // 记忆补 `superseded_by` 列（再蒸馏的软删标记）：同上，纯新增列
    ensure_memories_superseded_by_column(conn)?;

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

/**
 * 老库给 `usage_ledger` 补 `duration_ms` 列（新库由 DDL 直接建出，这里检测后跳过）。
 *
 * 与 `ensure_text_plain_column` 同策略：**只是元数据级 ALTER**（带默认值，不重写表），
 * 因此放在 `init_schema` 的快速路径里，不占 `SCHEMA_VERSION` 的迁移版本。
 * 旧流水补出来是 0（= 未测量），UI 必须显示 '-' 而不是 0 tok/s。
 */
fn ensure_usage_duration_column(conn: &Connection) -> Result<(), String> {
    let exists = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(usage_ledger)")
            .map_err(|e| format!("读取 usage_ledger 表结构失败: {}", e))?;
        let mut has = false;
        {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            for name in rows.flatten() {
                if name == "duration_ms" {
                    has = true;
                    break;
                }
            }
        }
        has
    };
    if !exists {
        conn.execute(
            "ALTER TABLE usage_ledger ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("添加 usage_ledger.duration_ms 列失败: {}", e))?;
    }
    Ok(())
}

/// 老库给 `memories` 补 `project_path` 列（项目作用域；新库由 DDL 直接建出，这里检测后跳过）。
///
/// 与 `ensure_usage_duration_column` 同一策略：元数据级 `ALTER`（可空、无默认值，不重写表），
/// 放在 `init_schema` 快速路径里，**不占 `SCHEMA_VERSION`**。
///
/// 旧记忆补出来是 **NULL = 不限定项目**：升级前它们对所有会话都注入，升级后保持这一行为 ——
/// 否则一次升级会把用户全部已有项目记忆静默“藏”起来（用户根本没给它们指过路径）。
///
/// ⚠️ 老库的列会追加在**表尾**、新库在 `summary` 之后：列顺序不同无害 ——
/// 读写都走列名（`row.get("project_path")` / INSERT 的显式列清单），不依赖位置。
fn ensure_memories_project_path_column(conn: &Connection) -> Result<(), String> {
    let exists = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(memories)")
            .map_err(|e| format!("读取 memories 表结构失败: {}", e))?;
        let mut has = false;
        {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            for name in rows.flatten() {
                if name == "project_path" {
                    has = true;
                    break;
                }
            }
        }
        has
    };
    if !exists {
        conn.execute("ALTER TABLE memories ADD COLUMN project_path TEXT", [])
            .map_err(|e| format!("添加 memories.project_path 列失败: {}", e))?;
    }
    Ok(())
}

/// 老库给 `memories` 补 `superseded_by` 列（再蒸馏的软删标记；新库由 DDL 直接建出，这里检测后跳过）。
///
/// 与 `ensure_memories_project_path_column` 同一策略：元数据级 `ALTER`（可空、无默认值，不重写表），
/// 放在 `init_schema` 快速路径里，**不占 `SCHEMA_VERSION`**。
///
/// 旧记忆补出来是 **NULL = 没被顶替** —— 这也正是归档清理（GC）的护栏之一：
/// 只有「我们顶替过的」（有 `superseded_by`）才可能被自动硬删，用户自己停用的永不清理。
fn ensure_memories_superseded_by_column(conn: &Connection) -> Result<(), String> {
    let exists = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(memories)")
            .map_err(|e| format!("读取 memories 表结构失败: {}", e))?;
        let mut has = false;
        {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            for name in rows.flatten() {
                if name == "superseded_by" {
                    has = true;
                    break;
                }
            }
        }
        has
    };
    if !exists {
        conn.execute("ALTER TABLE memories ADD COLUMN superseded_by TEXT", [])
            .map_err(|e| format!("添加 memories.superseded_by 列失败: {}", e))?;
    }
    Ok(())
}

/// 老库给 `usage_ledger` 补三个**传输侧**列（新库由 DDL 直接建出，这里检测后跳过）。
///
/// 与 `ensure_usage_duration_column` 同一策略：元数据级 `ALTER`（带默认值，不重写表），
/// 不占 `SCHEMA_VERSION`。旧流水补出来是 0 = 未采集 —— 那时根本没记录过这些事实，
/// 不能拿 0 字节 / 0 毫秒去冒充测量值。
fn ensure_usage_transport_columns(conn: &Connection) -> Result<(), String> {
    let existing: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(usage_ledger)")
            .map_err(|e| format!("读取 usage_ledger 表结构失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    for column in ["request_bytes", "response_start_ms", "first_byte_ms"] {
        if existing.contains(column) {
            continue;
        }
        conn.execute(
            &format!(
                "ALTER TABLE usage_ledger ADD COLUMN {} INTEGER NOT NULL DEFAULT 0",
                column
            ),
            [],
        )
        .map_err(|e| format!("添加 usage_ledger.{} 列失败: {}", column, e))?;
    }
    Ok(())
}

/// 老库给 `usage_ledger` 补 `cache_write_tokens` 列（新库由 DDL 直接建出，这里检测后跳过）。
///
/// 与 `ensure_usage_duration_column` 同一策略：元数据级 `ALTER`（带默认值，不重写表），
/// 放在 `init_schema` 快速路径里，不占 `SCHEMA_VERSION` 迁移版本。
/// ⚠️ 旧流水补出来恒为 0：历史数据**区分不出** Anthropic 的缓存写入量（`parse_response` 过去把
/// `cache_read + cache_creation` 合成了一个数），所以只能保持 0（= 不计写入费）而不是猜一个值
/// —— 旧流水会略偏低，但不会算错。
fn ensure_usage_cache_write_column(conn: &Connection) -> Result<(), String> {
    let exists = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(usage_ledger)")
            .map_err(|e| format!("读取 usage_ledger 表结构失败: {}", e))?;
        let mut has = false;
        {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            for name in rows.flatten() {
                if name == "cache_write_tokens" {
                    has = true;
                    break;
                }
            }
        }
        has
    };
    if !exists {
        conn.execute(
            "ALTER TABLE usage_ledger ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("添加 usage_ledger.cache_write_tokens 列失败: {}", e))?;
    }
    Ok(())
}

/// 老库补丁：把 `messages_fts_au` 换成带 `WHEN` 的版本（定义见 [`FTS_UPDATE_TRIGGER_DDL`]）。
///
/// 为什么必须在这里做：`CREATE TRIGGER IF NOT EXISTS` 换不掉已存在的旧定义，而旧的
/// `messages_fts_au` 没有 `WHEN` —— 流式节流落库（700ms 一次、每次写当前全量正文）会因此
/// 把整段 `text_plain` 的 trigram 全删重建，长回复是近似平方级的索引写入。
///
/// 为什么不递增 `SCHEMA_VERSION`：那会让 `migrate()` 对全库重建一次 FTS（大库分钟级），
/// 而这里换一条触发器定义是元数据级开销。
///
/// 幂等：先读 `sqlite_master.sql`，已带 `WHEN` 就什么都不做（正常启动零写入）。
///
/// ⚠️ **只替换已有的触发器，绝不在这里新建**：尚未迁移的老库里 FTS 索引还是空的，
/// 触发器会对未入索引的 rowid 发 FTS5 的 `'delete'` 指令 → 直接报
/// `database disk image is malformed`（回填 `text_plain` 时必踩）。新建的职责归
/// `FTS_TRIGGERS_DDL`（新库走 `init_schema`、老库走 `migrate()` 的链后重建）——那里
/// 的 `messages_fts_au` 已经带 `WHEN`，两边口径一致。
fn ensure_fts_update_trigger(conn: &Connection) -> Result<(), String> {
    let current: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_au'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取 FTS 更新触发器定义失败: {}", e))?;
    let Some(current) = current else {
        return Ok(()); // 还没有这条触发器：交给 `FTS_TRIGGERS_DDL`
    };
    if current.to_ascii_uppercase().contains("WHEN") {
        return Ok(());
    }
    conn.execute_batch(FTS_UPDATE_TRIGGER_DDL)
        .map_err(|e| format!("重建 FTS 更新触发器失败: {}", e))
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
            for n in rows.flatten() {
                if n == "text_plain" {
                    has = true;
                    break;
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

/// 把历史消息里的内联图片外置（P0-1）——让**老库**也能瘦下来。
///
/// 升级前写入的消息 `content` 里还躺着 `data:image/...;base64`，这里分批换成
/// `attachment://<sha256>.<ext>` 引用（见 `crate::attachment`）。
///
/// - **幂等可重入**：只挑还含 `data:image/` 的行；外置后该行自然不再匹配；
/// - **批间释放连接锁**：文件 IO 在锁外做，不会把聊天写入卡住（与 `backfill_text_plain` 同策略）；
/// - **失败只停不恢**：解码不了的坏数据会原地跳过；如果一整批都改不动就结束，避免无限重读同一批。
///
/// 返回实际改造的行数（0 = 没有待处理数据）。
pub(crate) fn backfill_attachments(
    conn: &Arc<Mutex<Connection>>,
    store: &AttachmentStore,
) -> Result<usize, String> {
    const BATCH: i64 = 200;
    /// 单轮最多处理多少行（防御：异常数据导致永远改不完时不至于无限循环）
    const MAX_ROWS: usize = 20_000;

    let mut total = 0usize;
    while total < MAX_ROWS {
        // ① 持锁读一批
        let batch: Vec<(String, String)> = {
            let guard = conn.lock().unwrap();
            let mut stmt = guard
                .prepare(
                    "SELECT id, content FROM messages \
                     WHERE content LIKE '%data:image/%' ORDER BY rowid LIMIT ?1",
                )
                .map_err(|e| format!("准备历史图片查询失败: {}", e))?;
            let rows = stmt
                .query_map(params![BATCH], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if batch.is_empty() {
            return Ok(total);
        }

        // ② 锁外外置（写附件文件）
        let mut updates: Vec<(String, String)> = Vec::new();
        for (id, content_json) in &batch {
            let Ok(content) = serde_json::from_str::<Value>(content_json) else {
                continue;
            };
            let mut message = Message {
                id: id.clone(),
                content,
                ..Default::default()
            };
            if store.externalize_message(&mut message) == 0 {
                continue;
            }
            match serde_json::to_string(&message.content) {
                Ok(updated) => updates.push((id.clone(), updated)),
                Err(e) => eprintln!("[session_db] 序列化外置后的消息失败（跳过）: {}", e),
            }
        }

        // 一整批都改不动 → 剩下的都是无法处理的脏数据，结束（否则会无限重读同一批）
        if updates.is_empty() {
            return Ok(total);
        }

        // ③ 持锁写回（单事务；`messages_fts_au` 触发器同步检索索引）
        {
            let guard = conn.lock().unwrap();
            let tx = guard
                .unchecked_transaction()
                .map_err(|e| format!("开启外置事务失败: {}", e))?;
            {
                let mut upd = tx
                    .prepare("UPDATE messages SET content=?1 WHERE id=?2")
                    .map_err(|e| format!("准备外置写回失败: {}", e))?;
                for (id, content) in &updates {
                    upd.execute(params![content, id])
                        .map_err(|e| format!("外置写回失败: {}", e))?;
                }
            }
            tx.commit().map_err(|e| format!("提交外置事务失败: {}", e))?;
        }
        total += updates.len();
        if (batch.len() as i64) < BATCH {
            return Ok(total);
        }
    }
    Ok(total)
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
