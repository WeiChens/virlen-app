//! 长期记忆（记忆功能 P0）——`memories` / `memory_runs` 两张表 + `MemoryRepo`
//!
//! 与会话 / 配置**共用同一个 `virlen.db` 与同一把连接锁**（不引入第二个写连接 → 不会 `SQLITE_BUSY`），
//! 因此 GUI 与 CLI 只要 `HostEnv::data_dir()` 指向同一目录，读写的就是同一份记忆。
//!
//! 两条硬约束（改这里时别丢）：
//! - **建表放 `init_schema` 快速路径，不占 `SCHEMA_VERSION`**：纯新增表、无历史数据要回填；
//!   递增版本会让 `migrate()` 对全库跑一次 `messages_fts` rebuild（大库分钟级），白付代价。
//! - **表里只存提炼后的短句**（`summary` ≤ `MEMORY_SUMMARY_MAX_CHARS`）：详情正文在专用知识库里，
//!   这里只留 `detail_kb_id` / `detail_doc_id` 两个链接字段 —— 记忆表要能整体塞进系统提示词。
//!
//! `memory_runs`（按天幂等 / 可观测）：表结构在 P0 建好，**P2 开始写入** —— 编排逻辑在
//! `agent::memory::consolidate`，这里只提供「取 / 列表 / 上次完成的日 / 抢锁 / 落终态 / 按天清理」。
//!
//! 检索（`search`，P1）与 `messages_fts` 同口径：trigram 分词 → 中文子串可命中；
//! 查询短于 3 字符时回退 `LIKE`（trigram 无法命中短查询）。

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// 记忆表结构（幂等）。由 `schema::init_schema` 在快速路径执行。
pub(crate) const MEMORY_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  level             TEXT NOT NULL,
  kind              TEXT NOT NULL,
  summary           TEXT NOT NULL,
  project_path      TEXT,
  detail_kb_id      TEXT,
  detail_doc_id     TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  source_day        TEXT NOT NULL DEFAULT '',
  source_session_id TEXT,
  origin            TEXT NOT NULL DEFAULT 'user',
  hits              INTEGER NOT NULL DEFAULT 0,
  last_used_at      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  disabled          INTEGER NOT NULL DEFAULT 0
);

-- 注入选取：先按级别 + 未禁用定位，再按热度 / 时间倒序（与 agent::memory::select_for_inject 口径一致）
CREATE INDEX IF NOT EXISTS idx_memories_pick
  ON memories(level, disabled, last_used_at DESC, created_at DESC);

-- 召回检索（P1 起用）：与 messages_fts 同款 trigram，支持中文子串（≥3 字符）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  summary,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

-- 与 messages_fts_* 同构：随 memories 增删改自动维护外部内容表
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary) VALUES (new.rowid, COALESCE(new.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary) VALUES('delete', old.rowid, COALESCE(old.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary) VALUES('delete', old.rowid, COALESCE(old.summary, ''));
  INSERT INTO memories_fts(rowid, summary) VALUES (new.rowid, COALESCE(new.summary, ''));
END;

-- 整理流水：以「天」为主键（幂等）。P2 起写入，P0 只建表。
-- `merged`（P3）：被近重复合并掉、没有新增的条数（老库由 schema.rs 的 ensure_* 补列）
CREATE TABLE IF NOT EXISTS memory_runs (
  day            TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  items          INTEGER NOT NULL DEFAULT 0,
  details        INTEGER NOT NULL DEFAULT 0,
  merged         INTEGER NOT NULL DEFAULT 0,
  source_sessions INTEGER NOT NULL DEFAULT 0,
  model          TEXT,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER
);
"#;

/// 记忆级别（与 TS `MEMORY_LEVELS` 一致）
pub const MEMORY_LEVEL_NORMAL: &str = "normal";
/// 永久记忆：**全量注入**，不参与 top-k 淘汰
pub const MEMORY_LEVEL_PERMANENT: &str = "permanent";

/// 项目记忆的分类值（与 TS `MEMORY_KINDS` 里的 `project` 同值）。
///
/// 只有它才允许带 `project_path`：别的分类是「跨项目通用的事实」，带上路径会让该记忆
/// 凭空只在某一个目录下可见（用户也不会想到去别的项目找它）。
pub const MEMORY_KIND_PROJECT: &str = "project";

/// `memories.origin`：由 P2 蒸馏产出（「重新整理某天」只删这一类，用户手写的永不动）
pub const MEMORY_ORIGIN_DISTILL: &str = "distill";

// ==================== 整理流水（`memory_runs`，P2） ====================

/// 正在跑（抢到锁；超过 `stale_ms` 视为崩溃残留，可被抢占）
pub const MEMORY_RUN_RUNNING: &str = "running";
/// 跑完且有产出
pub const MEMORY_RUN_DONE: &str = "done";
/// 当天无素材：不调模型、不花钱（也算「这一天处理过了」，不该无限重试）
pub const MEMORY_RUN_SKIPPED: &str = "skipped";
/// 跑完但有降级（典型：详情写不进知识库，只存了摘要）
pub const MEMORY_RUN_PARTIAL: &str = "partial";
/// 模型调用 / 解析失败：`attempts` 未耗尽前可重试
pub const MEMORY_RUN_FAILED: &str = "failed";

/// 一天整理的结果（`memory_runs` 一行的镜像；GUI 面板 / CLI 都看它）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct MemoryRun {
    /// 被整理的那一天（`YYYY-MM-DD`，本地日）—— 也是幂等键（主键）
    pub day: String,
    /// `running` | `done` | `skipped` | `partial` | `failed`
    pub status: String,
    /// 产出条数
    pub items: i64,
    /// 其中落了详情（知识库）的条数
    pub details: i64,
    /// 被**近重复合并**掉、没有新增的条数（P3；>0 说明「记忆长长了」而不是又写了一条）
    pub merged: i64,
    /// 素材来源会话数
    pub source_sessions: i64,
    /// 实际使用的模型（`providerConfigId/modelId`）—— 便于回答「这条记忆是哪次、用哪个模型提炼的」
    pub model: Option<String>,
    /// 失败原因（最后一次尝试）
    pub error: Option<String>,
    /// 已尝试次数（每次抢锁 +1）
    pub attempts: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
}

/// 抢锁结论（纯逻辑，单测逐个分支断言；DB 只负责执行它）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimDecision {
    /// 可以跑
    Claimed,
    /// 已经处理过（`done` / `skipped` / `partial`，或未知状态）—— 幂等键的语义
    AlreadyDone,
    /// 失败过且尝试次数已耗尽（等人工重试）
    Exhausted,
    /// 另一个进程 / 窗口正在跑（或崩溃残留但还没到老化阈值）
    Busy,
}

impl ClaimDecision {
    /// 给日志 / 报告用的短原因
    pub fn reason(&self) -> &'static str {
        match self {
            ClaimDecision::Claimed => "claimed",
            ClaimDecision::AlreadyDone => "already-done",
            ClaimDecision::Exhausted => "attempts-exhausted",
            ClaimDecision::Busy => "busy",
        }
    }
}

/// 抢锁参数（把五个参数收成一个结构体：调用点只关心「现在 / 老化阈值 / 上限 / 是否强制」）
#[derive(Debug, Clone, Copy)]
pub struct ClaimOptions {
    pub now_ms: i64,
    /// `running` 超过它就视为崩溃残留，可被抢占
    pub stale_ms: i64,
    /// 失败后最多尝试几次
    pub max_attempts: i64,
    /// `true` = 忽略已有状态（面板的「重新整理」）；只由显式的用户动作传，自动触发永远为 `false`
    pub force: bool,
}

/// 能否抢下这一天的整理锁（**纯函数**）。
///
/// - `force` → 直接抢（用户的「重新整理」：覆盖昨天 / 任意一天）；
/// - 没有记录 → 抢；
/// - `running` 且未超 `stale_ms` → 让给别人（多窗口 / GUI + CLI 同时开着只跑一次）；
///   超过阈值（进程被杀留下的残留）→ 抢占，否则那一天永远卡在 `running`；
/// - `failed` 且 `attempts < max_attempts` → 允许重试；
/// - 其余（含未知状态）→ 视为已处理：宁可少跑一次，也不要让「重复整理」把记忆写两遍。
pub fn decide_claim(
    existing: Option<&MemoryRun>,
    now_ms: i64,
    stale_ms: i64,
    max_attempts: i64,
    force: bool,
) -> ClaimDecision {
    if force {
        return ClaimDecision::Claimed;
    }
    let Some(run) = existing else {
        return ClaimDecision::Claimed;
    };
    match run.status.as_str() {
        MEMORY_RUN_RUNNING => {
            if now_ms.saturating_sub(run.started_at) >= stale_ms.max(0) {
                ClaimDecision::Claimed
            } else {
                ClaimDecision::Busy
            }
        }
        MEMORY_RUN_FAILED => {
            if run.attempts < max_attempts.max(1) {
                ClaimDecision::Claimed
            } else {
                ClaimDecision::Exhausted
            }
        }
        _ => ClaimDecision::AlreadyDone,
    }
}

/// 一条记忆（IPC DTO；字段名与前端一致）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct MemoryRecord {
    pub id: String,
    /// `normal` | `permanent`
    pub level: String,
    /// `user` | `project` | `decision` | `fact`
    pub kind: String,
    /// 记忆正文（硬上限见 `agent::memory::MEMORY_SUMMARY_MAX_CHARS`；写入前由命令层钳制）
    pub summary: String,
    /// 项目路径（仅 `kind = project` 才有）：该记忆只在「工作目录 = 它 或 它之下的子目录」
    /// 的会话里注入与召回。`None` / 空 = 不限定项目（跨项目通用）。
    ///
    /// 老库的列由 `schema.rs` 的 `ensure_memories_project_path_column` 补出（补为 NULL = 通用），
    /// **升级后行为不变**：原来怎么注入的，升级后还是怎么注入（不静默丢记忆）。
    pub project_path: Option<String>,
    pub detail_kb_id: Option<String>,
    pub detail_doc_id: Option<String>,
    pub tags: Vec<String>,
    /// 来源日（`YYYY-MM-DD`，本地日）；手动新增时为空串
    pub source_day: String,
    pub source_session_id: Option<String>,
    /// `distill` | `model` | `user`
    pub origin: String,
    pub hits: i64,
    pub last_used_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub disabled: bool,
}

/// 记忆仓储端口。
///
/// 与 `SettingsRepo` 同款：GUI / CLI 各拿一个实现，库打不开时退化为 [`NoopMemoryRepo`]。
#[async_trait]
pub trait MemoryRepo: Send + Sync {
    /// 列记忆（`level` 为 `None` 表示全部）。排序：永久在前 → 新建在前 → id 升序（全序，便于测试）
    async fn list(&self, level: Option<&str>, include_disabled: bool)
        -> Result<Vec<MemoryRecord>, String>;

    /// 取单条（`memory_recall` 的底层）；不存在 → `None`
    async fn get(&self, id: &str) -> Result<Option<MemoryRecord>, String>;

    /// 新增 / 覆盖一条（同 id 即更新；`created_at` 保持首次写入值）
    async fn upsert(&self, record: &MemoryRecord) -> Result<(), String>;

    /// 删除；返回是否真的删到
    async fn delete(&self, id: &str) -> Result<bool, String>;

    /// 改级别（面板里的升级 / 降级）；返回是否命中
    async fn set_level(&self, id: &str, level: &str) -> Result<bool, String>;

    /// 启用 / 禁用（禁用 = 不注入、不参与召回）；返回是否命中
    async fn set_disabled(&self, id: &str, disabled: bool) -> Result<bool, String>;

    /// 注入后记一次使用（`hits += 1` / `last_used_at = now`）——top-k 排序的输入
    async fn touch(&self, ids: &[String], now_ms: i64) -> Result<(), String>;

    /// 关键词检索（`memory_search` 工具的底层）：查询 ≥3 字符走 FTS5（trigram），更短的回退 `LIKE`。
    /// **禁用项永不返回**（禁用语义 = 不注入、不参与召回）；`level` / `kind` 为 `None` 表示不过滤。
    /// 排序：命中降序 → 新建在前 → id 升序（全序，便于断言与稳定输出）。
    async fn search(
        &self,
        query: &str,
        level: Option<&str>,
        kind: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryRecord>, String>;

    // ===== 整理流水（P2 蒸馏：按天幂等 + 可观测） =====

    /// 取某天的整理流水
    async fn get_run(&self, day: &str) -> Result<Option<MemoryRun>, String>;

    /// 最近的整理流水（新 → 旧）—— 设置页面板的状态行
    async fn list_runs(&self, limit: usize) -> Result<Vec<MemoryRun>, String>;

    /// 最后一个「已处理」的日期（`done` / `skipped` / `partial`）—— 补跑的起点
    async fn last_done_day(&self) -> Result<Option<String>, String>;

    /// 抢锁：同一次加锁内完成「读现状 → [`decide_claim`] → 置 `running`」。
    /// 返回 `None` = 这次不该跑（已处理 / 尝试耗尽 / 别人在跑）。
    async fn claim_run(
        &self,
        day: &str,
        opts: ClaimOptions,
    ) -> Result<Option<MemoryRun>, String>;

    /// 落终态（把抢锁时拿到的 [`MemoryRun`] 填好结果再写回）
    async fn finish_run(&self, run: &MemoryRun) -> Result<(), String>;

    /// 删掉某天**蒸馏产出**的条目（「重新整理某天」用），返回被删的条目
    /// —— 调用方据此把它们的详情文档也从知识库里删掉（否则会留下孤儿文档）。
    /// 用户手写的（`origin = 'user'` / `'model'`）与别的日期的条目**一律不动**。
    async fn delete_distilled_day(&self, day: &str) -> Result<Vec<MemoryRecord>, String>;

    /// 是否存在**真实的持久化后端**（`NoopMemoryRepo` 覆写为 `false`）
    fn is_available(&self) -> bool {
        true
    }
}

// ==================== SQLite 实现 ====================

pub struct SqliteMemoryRepo {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteMemoryRepo {
    /// 复用会话库的连接（**同一把锁** → 与会话写入天然互斥）
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }
}

fn tags_to_json(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

fn tags_from_json(raw: &str) -> Vec<String> {
    // 坏行不报错：tags 只是辅助信息，不值得让整次列表失败
    serde_json::from_str(raw).unwrap_or_default()
}

fn run_from_row(row: &rusqlite::Row) -> rusqlite::Result<MemoryRun> {
    Ok(MemoryRun {
        day: row.get("day")?,
        status: row.get("status")?,
        items: row.get("items")?,
        details: row.get("details")?,
        merged: row.get("merged")?,
        source_sessions: row.get("source_sessions")?,
        model: row.get("model")?,
        error: row.get("error")?,
        attempts: row.get("attempts")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        prompt_tokens: row.get("prompt_tokens")?,
        completion_tokens: row.get("completion_tokens")?,
    })
}

/// 取某天的整理流水（纯函数）
fn get_run_in_conn(conn: &Connection, day: &str) -> Result<Option<MemoryRun>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM memory_runs WHERE day = ?1")
        .map_err(|e| format!("准备整理流水查询失败: {}", e))?;
    let mut rows = stmt
        .query_map(params![day], run_from_row)
        .map_err(|e| format!("查询整理流水失败: {}", e))?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// 写入 / 覆盖一天的整理流水（纯函数，`day` 是主键）
fn upsert_run_in_conn(conn: &Connection, run: &MemoryRun) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memory_runs (
            day, status, items, details, merged, source_sessions, model, error, attempts,
            started_at, finished_at, prompt_tokens, completion_tokens
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(day) DO UPDATE SET
            status = excluded.status,
            items = excluded.items,
            details = excluded.details,
            merged = excluded.merged,
            source_sessions = excluded.source_sessions,
            model = excluded.model,
            error = excluded.error,
            attempts = excluded.attempts,
            started_at = excluded.started_at,
            finished_at = excluded.finished_at,
            prompt_tokens = excluded.prompt_tokens,
            completion_tokens = excluded.completion_tokens",
        params![
            run.day,
            run.status,
            run.items,
            run.details,
            run.merged,
            run.source_sessions,
            run.model,
            run.error,
            run.attempts,
            run.started_at,
            run.finished_at,
            run.prompt_tokens,
            run.completion_tokens,
        ],
    )
    .map_err(|e| format!("写入整理流水失败: {}", e))?;
    Ok(())
}

fn memory_from_row(row: &rusqlite::Row) -> rusqlite::Result<MemoryRecord> {
    let tags_json: String = row.get("tags")?;
    Ok(MemoryRecord {
        id: row.get("id")?,
        level: row.get("level")?,
        kind: row.get("kind")?,
        summary: row.get("summary")?,
        // 空串 / NULL 一律收敛为 None：库里不该出现「有路径但是空串」这种半状态
        project_path: row
            .get::<_, Option<String>>("project_path")?
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        detail_kb_id: row.get("detail_kb_id")?,
        detail_doc_id: row.get("detail_doc_id")?,
        tags: tags_from_json(&tags_json),
        source_day: row.get("source_day")?,
        source_session_id: row.get("source_session_id")?,
        origin: row.get("origin")?,
        hits: row.get("hits")?,
        last_used_at: row.get("last_used_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        disabled: row.get::<_, i64>("disabled")? != 0,
    })
}

/// 列表查询（纯函数，便于单测）
fn list_in_conn(
    conn: &Connection,
    level: Option<&str>,
    include_disabled: bool,
) -> Result<Vec<MemoryRecord>, String> {
    let mut sql = String::from("SELECT * FROM memories WHERE 1 = 1");
    if level.is_some() {
        sql.push_str(" AND level = ?1");
    }
    if !include_disabled {
        sql.push_str(" AND disabled = 0");
    }
    // 永久在前 → 新建在前 → id 升序：三级键保证全序（增量显示不会抖动）
    sql.push_str(" ORDER BY (level = 'permanent') DESC, created_at DESC, id ASC");

    // 动态拼参数：`level` 有无决定占位符个数（用 `?1` 参数化，不把值拼进 SQL）
    let mut bound: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(l) = level {
        bound.push(Box::new(l.to_string()));
    }
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备记忆查询失败: {}", e))?;
    let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), memory_from_row)
        .map_err(|e| format!("查询记忆失败: {}", e))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// trigram 分词的最小可用长度 —— 与 `message_query.rs` 的 `search_messages` 同口径。
///
/// trigram 索引按 3 字符切分，查询短于 3 字符时 `MATCH` 必然空结果（不是「没有匹配」而是「索引用不上」），
/// 所以必须回退 `LIKE`，否则「查两个字的中文词」会永远返回空。
const MEMORY_FTS_MIN_CHARS: usize = 3;

/// 检索（纯函数，便于单测）。
///
/// 两条路径都**先按 `disabled = 0` 过滤**：禁用的记忆不该被模型通过检索重新捞回来。
fn search_in_conn(
    conn: &Connection,
    query: &str,
    level: Option<&str>,
    kind: Option<&str>,
    limit: usize,
) -> Result<Vec<MemoryRecord>, String> {
    if query.is_empty() {
        // 空查询不做「全表返回」：调用方（工具 / 命令）应当先拒掉，这里只兜底
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 50) as i64;

    let mut sql = String::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if query.chars().count() >= MEMORY_FTS_MIN_CHARS {
        // 整体加引号作为短语查询；内部双引号翻倍转义，避免 FTS5 语法注入
        let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
        sql.push_str(
            "SELECT m.* FROM memories_fts \
             JOIN memories m ON m.rowid = memories_fts.rowid \
             WHERE memories_fts MATCH ?",
        );
        args.push(Box::new(fts_query));
    } else {
        // LIKE 模式：转义 % _ \\ ，避免用户输入里的通配符改变语义
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        sql.push_str(
            "SELECT m.* FROM memories m \
             WHERE COALESCE(m.summary, '') LIKE ? ESCAPE '\\'",
        );
        args.push(Box::new(format!("%{}%", escaped)));
    }

    sql.push_str(" AND m.disabled = 0");
    if let Some(l) = level {
        sql.push_str(" AND m.level = ?");
        args.push(Box::new(l.to_string()));
    }
    if let Some(k) = kind {
        sql.push_str(" AND m.kind = ?");
        args.push(Box::new(k.to_string()));
    }
    // 全序（命中多 → 新建 → id）：同一份库永远得到同一份输出，测试与 UI 都不会抖动
    sql.push_str(" ORDER BY m.hits DESC, m.created_at DESC, m.id ASC LIMIT ?");
    args.push(Box::new(limit));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备记忆检索失败: {}", e))?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), memory_from_row)
        .map_err(|e| format!("检索记忆失败: {}", e))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 取单条（纯函数）
fn get_in_conn(conn: &Connection, id: &str) -> Result<Option<MemoryRecord>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM memories WHERE id = ?1")
        .map_err(|e| format!("准备记忆查询失败: {}", e))?;
    let mut rows = stmt
        .query_map(params![id], memory_from_row)
        .map_err(|e| format!("查询记忆失败: {}", e))?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// 写入（纯函数）：同 id 覆盖，但 `created_at` 与 `hits` / `last_used_at` 保持库中现值 ——
/// 它们是「历史统计」，不能被编辑摘要这种动作清掉。
fn upsert_in_conn(conn: &Connection, r: &MemoryRecord, now_ms: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memories (
            id, level, kind, summary, project_path, detail_kb_id, detail_doc_id, tags, source_day,
            source_session_id, origin, hits, last_used_at, created_at, updated_at, disabled
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
            level = excluded.level,
            kind = excluded.kind,
            summary = excluded.summary,
            project_path = excluded.project_path,
            detail_kb_id = excluded.detail_kb_id,
            detail_doc_id = excluded.detail_doc_id,
            tags = excluded.tags,
            origin = excluded.origin,
            disabled = excluded.disabled,
            updated_at = excluded.updated_at",
        params![
            r.id,
            r.level,
            r.kind,
            r.summary,
            r.project_path,
            r.detail_kb_id,
            r.detail_doc_id,
            tags_to_json(&r.tags),
            r.source_day,
            r.source_session_id,
            r.origin,
            r.hits,
            r.last_used_at,
            if r.created_at > 0 { r.created_at } else { now_ms },
            if r.disabled { 1 } else { 0 },
        ],
    )
    .map_err(|e| format!("写入记忆失败: {}", e))?;
    Ok(())
}

#[async_trait]
impl MemoryRepo for SqliteMemoryRepo {
    async fn list(
        &self,
        level: Option<&str>,
        include_disabled: bool,
    ) -> Result<Vec<MemoryRecord>, String> {
        let conn = self.conn.clone();
        let level = level.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            list_in_conn(&conn, level.as_deref(), include_disabled)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get(&self, id: &str) -> Result<Option<MemoryRecord>, String> {
        let conn = self.conn.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            get_in_conn(&conn, &id)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn upsert(&self, record: &MemoryRecord) -> Result<(), String> {
        let conn = self.conn.clone();
        let record = record.clone();
        let now = crate::telemetry::now_ms();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            upsert_in_conn(&conn, &record, now)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let n = conn
                .execute("DELETE FROM memories WHERE id = ?1", params![id])
                .map_err(|e| format!("删除记忆失败: {}", e))?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn set_level(&self, id: &str, level: &str) -> Result<bool, String> {
        let conn = self.conn.clone();
        let (id, level) = (id.to_string(), level.to_string());
        let now = crate::telemetry::now_ms();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let n = conn
                .execute(
                    "UPDATE memories SET level = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, level, now],
                )
                .map_err(|e| format!("更新记忆级别失败: {}", e))?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn set_disabled(&self, id: &str, disabled: bool) -> Result<bool, String> {
        let conn = self.conn.clone();
        let id = id.to_string();
        let now = crate::telemetry::now_ms();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let n = conn
                .execute(
                    "UPDATE memories SET disabled = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, if disabled { 1 } else { 0 }, now],
                )
                .map_err(|e| format!("更新记忆开关失败: {}", e))?;
            Ok(n > 0)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn touch(&self, ids: &[String], now_ms: i64) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.clone();
        let ids = ids.to_vec();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启记忆使用记录事务失败: {}", e))?;
            {
                let mut stmt = tx
                    .prepare("UPDATE memories SET hits = hits + 1, last_used_at = ?2 WHERE id = ?1")
                    .map_err(|e| format!("准备记忆使用记录失败: {}", e))?;
                for id in &ids {
                    stmt.execute(params![id, now_ms])
                        .map_err(|e| format!("记录记忆使用失败: {}", e))?;
                }
            }
            tx.commit()
                .map_err(|e| format!("提交记忆使用记录失败: {}", e))
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn search(
        &self,
        query: &str,
        level: Option<&str>,
        kind: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryRecord>, String> {
        let conn = self.conn.clone();
        let query = query.trim().to_string();
        let level = level.map(|s| s.to_string());
        let kind = kind.map(|s| s.to_string());
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            search_in_conn(&conn, &query, level.as_deref(), kind.as_deref(), limit)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    // ===== 整理流水（P2） =====

    async fn get_run(&self, day: &str) -> Result<Option<MemoryRun>, String> {
        let conn = self.conn.clone();
        let day = day.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            get_run_in_conn(&conn, &day)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn list_runs(&self, limit: usize) -> Result<Vec<MemoryRun>, String> {
        let conn = self.conn.clone();
        let limit = limit.clamp(1, 200) as i64;
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM memory_runs ORDER BY day DESC LIMIT ?1")
                .map_err(|e| format!("准备整理流水查询失败: {}", e))?;
            let rows = stmt
                .query_map(params![limit], run_from_row)
                .map_err(|e| format!("查询整理流水失败: {}", e))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| e.to_string())?);
            }
            Ok(out)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn last_done_day(&self) -> Result<Option<String>, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.query_row(
                "SELECT day FROM memory_runs \
                 WHERE status IN (?1, ?2, ?3) ORDER BY day DESC LIMIT 1",
                params![MEMORY_RUN_DONE, MEMORY_RUN_SKIPPED, MEMORY_RUN_PARTIAL],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("查询上次整理日期失败: {}", e))
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn claim_run(
        &self,
        day: &str,
        opts: ClaimOptions,
    ) -> Result<Option<MemoryRun>, String> {
        let conn = self.conn.clone();
        let day = day.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let existing = get_run_in_conn(&conn, &day)?;
            if decide_claim(
                existing.as_ref(),
                opts.now_ms,
                opts.stale_ms,
                opts.max_attempts,
                opts.force,
            ) != ClaimDecision::Claimed
            {
                return Ok(None);
            }
            // 抢到：置 running、attempts +1（items / details 等由 finish_run 覆盖）；
            // 强制重跑时 attempts 归零（新的一次用户意图，不该背负之前用掉的次数）
            let mut run = existing.unwrap_or_default();
            run.day = day.clone();
            run.status = MEMORY_RUN_RUNNING.to_string();
            run.attempts = if opts.force { 1 } else { run.attempts + 1 };
            run.started_at = opts.now_ms;
            run.finished_at = None;
            upsert_run_in_conn(&conn, &run)?;
            Ok(Some(run))
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn finish_run(&self, run: &MemoryRun) -> Result<(), String> {
        let conn = self.conn.clone();
        let run = run.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            upsert_run_in_conn(&conn, &run)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn delete_distilled_day(&self, day: &str) -> Result<Vec<MemoryRecord>, String> {
        let conn = self.conn.clone();
        let day = day.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启记忆清理事务失败: {}", e))?;
            let removed: Vec<MemoryRecord> = {
                let mut stmt = tx
                    .prepare("SELECT * FROM memories WHERE source_day = ?1 AND origin = ?2")
                    .map_err(|e| format!("准备记忆清理查询失败: {}", e))?;
                let rows = stmt
                    .query_map(params![day, MEMORY_ORIGIN_DISTILL], memory_from_row)
                    .map_err(|e| format!("查询待清理记忆失败: {}", e))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(|e| e.to_string())?);
                }
                out
            };
            tx.execute(
                "DELETE FROM memories WHERE source_day = ?1 AND origin = ?2",
                params![day, MEMORY_ORIGIN_DISTILL],
            )
            .map_err(|e| format!("清理记忆失败: {}", e))?;
            tx.commit()
                .map_err(|e| format!("提交记忆清理事务失败: {}", e))?;
            Ok(removed)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
}

// ==================== Noop 实现（库打不开的兜底） ====================

/// 无库环境（浏览器 dev / 库打不开）：读回空、写入静默丢弃。
///
/// 必须存在：库打不开时若连状态都没注册，`cmd_memory_*` 会以「状态未注册」失败，
/// 表现为面板整页报错 —— 而「没有记忆」才是那时的正确语义（与 `NoopSettingsRepo` 同一理由）。
#[derive(Default)]
pub struct NoopMemoryRepo;

#[async_trait]
impl MemoryRepo for NoopMemoryRepo {
    fn is_available(&self) -> bool {
        false
    }

    async fn list(
        &self,
        _level: Option<&str>,
        _include_disabled: bool,
    ) -> Result<Vec<MemoryRecord>, String> {
        Ok(Vec::new())
    }
    async fn get(&self, _id: &str) -> Result<Option<MemoryRecord>, String> {
        Ok(None)
    }
    async fn upsert(&self, _record: &MemoryRecord) -> Result<(), String> {
        Ok(())
    }
    async fn delete(&self, _id: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn set_level(&self, _id: &str, _level: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn set_disabled(&self, _id: &str, _disabled: bool) -> Result<bool, String> {
        Ok(false)
    }
    async fn touch(&self, _ids: &[String], _now_ms: i64) -> Result<(), String> {
        Ok(())
    }
    async fn search(
        &self,
        _query: &str,
        _level: Option<&str>,
        _kind: Option<&str>,
        _limit: usize,
    ) -> Result<Vec<MemoryRecord>, String> {
        Ok(Vec::new())
    }
    async fn get_run(&self, _day: &str) -> Result<Option<MemoryRun>, String> {
        Ok(None)
    }
    async fn list_runs(&self, _limit: usize) -> Result<Vec<MemoryRun>, String> {
        Ok(Vec::new())
    }
    async fn last_done_day(&self) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn claim_run(
        &self,
        _day: &str,
        _opts: ClaimOptions,
    ) -> Result<Option<MemoryRun>, String> {
        Ok(None)
    }
    async fn finish_run(&self, _run: &MemoryRun) -> Result<(), String> {
        Ok(())
    }
    async fn delete_distilled_day(&self, _day: &str) -> Result<Vec<MemoryRecord>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo() -> (SqliteMemoryRepo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("virlen_memory_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let session =
            crate::session_db::sqlite::SqliteSessionRepo::open(&dir.join("virlen.db")).unwrap();
        (SqliteMemoryRepo::new(session.conn.clone()), dir)
    }

    fn record(id: &str, level: &str, summary: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            level: level.into(),
            kind: "project".into(),
            summary: summary.into(),
            tags: vec!["virlen-app".into()],
            source_day: "2026-10-05".into(),
            origin: "user".into(),
            created_at: 1_700_000_000_000,
            ..Default::default()
        }
    }

    /// 建表随开库自动完成，且可重复执行（快速路径幂等）
    #[tokio::test]
    async fn schema_is_created_and_idempotent() {        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "第一条")).await.unwrap();
        // 再开一次（模拟第二次启动）：表已存在 → 不报错、数据还在
        let session =
            crate::session_db::sqlite::SqliteSessionRepo::open(&dir.join("virlen.db")).unwrap();
        let repo2 = SqliteMemoryRepo::new(session.conn.clone());
        assert_eq!(repo2.list(None, false).await.unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 老库（`memories` 表建于 `project_path` 之前）→ 开库自动补列，
    /// 且升级前就存在的记忆读出来是**不限定项目**（行为与升级前一致，不静默丢记忆）
    #[tokio::test]
    async fn legacy_memories_table_gets_project_path_column() {
        let dir =
            std::env::temp_dir().join(format!("virlen_memory_legacy_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("virlen.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            // 「上一个版本」的表结构 = 当前 DDL 删掉 project_path 那一行（**不手抄 DDL**：
            // 抄一遍迟早与真 DDL 分叉，而这种测试一旦分叉就再也测不出真实迁移路径）
            let legacy_ddl = MEMORY_DDL.replace("  project_path      TEXT,\n", "");
            assert_ne!(
                legacy_ddl, MEMORY_DDL,
                "DDL 里找不到 project_path 那一行 —— 改列名/缩进时记得同步本用例"
            );
            conn.execute_batch(&legacy_ddl).unwrap();
            conn.execute_batch(
                "INSERT INTO memories (id, level, kind, summary, tags, source_day, origin, created_at, updated_at)\n\
                 VALUES ('m_old', 'normal', 'project', '升级前就存在的项目记忆', '[]', '', 'user', 1, 1);\n\
                 INSERT INTO memories_fts(memories_fts) VALUES('rebuild');",
            )
            .unwrap();
        }

        let session = crate::session_db::sqlite::SqliteSessionRepo::open(&db).unwrap();
        let repo = SqliteMemoryRepo::new(session.conn.clone());
        let all = repo.list(None, true).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].summary, "升级前就存在的项目记忆");
        assert_eq!(all[0].project_path, None, "补出来的列是 NULL = 不限定项目");

        // 补出来的列可正常写入（不是只能读的遗留列；FTS 也会跟着新值维护）
        let mut scoped = all[0].clone();
        scoped.project_path = Some("C:/code/app".into());
        repo.upsert(&scoped).await.unwrap();
        assert_eq!(
            repo.get("m_old").await.unwrap().unwrap().project_path.as_deref(),
            Some("C:/code/app")
        );
        assert_eq!(repo.search("升级前", None, None, 5).await.unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 读写回环：tags / 可空字段 / 布尔都能原样回来
    #[tokio::test]
    async fn upsert_then_list_roundtrip() {
        let (repo, dir) = tmp_repo();
        let mut r = record("m1", MEMORY_LEVEL_PERMANENT, "用户偏好中文回复");
        r.detail_kb_id = Some("kb_1".into());
        r.detail_doc_id = Some("doc_1".into());
        r.disabled = true;
        repo.upsert(&r).await.unwrap();

        let all = repo.list(None, true).await.unwrap();
        assert_eq!(all.len(), 1);
        let got = &all[0];
        assert_eq!(got.level, MEMORY_LEVEL_PERMANENT);
        assert_eq!(got.summary, "用户偏好中文回复");
        assert_eq!(got.tags, vec!["virlen-app".to_string()]);
        assert_eq!(got.detail_kb_id.as_deref(), Some("kb_1"));
        assert!(got.disabled);
        // 默认查询排除禁用条目
        assert!(repo.list(None, false).await.unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 项目作用域的回环：写进去 / 读回来 / 覆盖写可清除（面板把路径删空就是回到「不限定项目」）
    #[tokio::test]
    async fn project_path_roundtrips_and_can_be_cleared() {
        let (repo, dir) = tmp_repo();
        let mut scoped = record("m1", MEMORY_LEVEL_NORMAL, "项目约定");
        scoped.project_path = Some("C:/work/app".into());
        repo.upsert(&scoped).await.unwrap();
        assert_eq!(
            repo.get("m1").await.unwrap().unwrap().project_path.as_deref(),
            Some("C:/work/app")
        );

        // 用户把路径清空（= 不限定项目）→ 库里真的变回 NULL，而不是留个空串
        let mut cleared = scoped.clone();
        cleared.project_path = None;
        repo.upsert(&cleared).await.unwrap();
        assert_eq!(repo.get("m1").await.unwrap().unwrap().project_path, None);

        // 空串读回来也是 None（库里理论上不该有，但不该把空串当项目路径参与比较）
        let mut blank = scoped.clone();
        blank.id = "m2".into();
        blank.project_path = Some("   ".into());
        repo.upsert(&blank).await.unwrap();
        assert_eq!(repo.get("m2").await.unwrap().unwrap().project_path, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 覆盖写不能清掉历史统计（created_at / hits / last_used_at 是数据，不是本次输入）
    #[tokio::test]
    async fn upsert_keeps_history_fields() {        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "旧摘要")).await.unwrap();
        repo.touch(&["m1".to_string()], 1_700_000_000_500).await.unwrap();

        let mut edited = record("m1", MEMORY_LEVEL_NORMAL, "新摘要");
        edited.created_at = 0; // 面板编辑不会带原始创建时间
        repo.upsert(&edited).await.unwrap();

        let got = &repo.list(None, true).await.unwrap()[0];
        assert_eq!(got.summary, "新摘要");
        assert_eq!(got.hits, 1, "编辑摘要不应清空命中次数");
        assert_eq!(got.last_used_at, 1_700_000_000_500);
        assert_eq!(got.created_at, 1_700_000_000_000, "创建时间取首次写入值");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn level_and_disable_updates_report_miss() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "x")).await.unwrap();

        assert!(repo.set_level("m1", MEMORY_LEVEL_PERMANENT).await.unwrap());
        assert_eq!(repo.list(Some(MEMORY_LEVEL_PERMANENT), false).await.unwrap().len(), 1);
        assert!(repo.set_disabled("m1", true).await.unwrap());
        assert!(repo.list(Some(MEMORY_LEVEL_PERMANENT), false).await.unwrap().is_empty());

        // 不存在的 id：返回 false 而不是报错（面板双击后重复提交的正常情形）
        assert!(!repo.set_level("nope", MEMORY_LEVEL_NORMAL).await.unwrap());
        assert!(!repo.set_disabled("nope", false).await.unwrap());
        assert!(!repo.delete("nope").await.unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn delete_removes_row_and_fts_entry() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "会被删掉")).await.unwrap();
        assert!(repo.delete("m1").await.unwrap());
        assert!(repo.list(None, true).await.unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 记忆表与会话/配置**同一个库、互不干扰**（P0 的关键回归：老库升级后消息不能动）
    #[tokio::test]
    async fn memories_coexist_with_sessions() {
        use crate::agent::types::Session;
        let dir = std::env::temp_dir().join(format!("virlen_memory_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("virlen.db");
        {
            let session = Arc::new(
                crate::session_db::sqlite::SqliteSessionRepo::open(&db_path).unwrap(),
            );
            let repo: Arc<dyn crate::session_db::SessionRepo> = session.clone();
            repo.upsert_session(&Session {
                id: "s1".into(),
                title: "会话".into(),
                messages: Vec::new(),
                provider_config_id: "p".into(),
                model_id: "m".into(),
                system_prompt: String::new(),
                params: crate::agent::types::SessionParams {
                    temperature: 0.0,
                    top_p: 0.0,
                    max_tokens: 0,
                    stream: false,
                    reasoning_effort: None,
                },
                created_at: 1,
                updated_at: 1,
                pinned: false,
                tags: Vec::new(),
                workspace: None,
                agent_id: None,
                allowed_tools: None,
                skills: None,
                system_prompt_manually_edited: None,
            })
            .await
            .unwrap();
        }
        // 重新打开（等价于「老库 + 新版本」）：记忆表出现，会话仍在
        let session = Arc::new(
            crate::session_db::sqlite::SqliteSessionRepo::open(&db_path).unwrap(),
        );
        let repo: Arc<dyn crate::session_db::SessionRepo> = session.clone();
        let memory = SqliteMemoryRepo::new(session.conn.clone());
        assert_eq!(repo.list_sessions().await.unwrap().len(), 1);
        memory.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "x")).await.unwrap();
        assert_eq!(memory.list(None, false).await.unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Noop：不报错、读回空、如实报「没有后端」
    #[tokio::test]
    async fn noop_repo_is_unavailable_and_harmless() {
        let repo = NoopMemoryRepo;
        assert!(!repo.is_available());
        assert!(repo.list(None, false).await.unwrap().is_empty());
        assert!(repo.search("任意", None, None, 5).await.unwrap().is_empty());
        assert!(repo.get("m1").await.unwrap().is_none());
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "x")).await.unwrap();
        repo.touch(&["m1".to_string()], 0).await.unwrap();
        assert!(!repo.delete("m1").await.unwrap());
    }

    // ==================== 检索（P1） ====================

    /// 中文子串命中（trigram 的价值所在）：查询是正文的真子串，且不需要整词边界
    #[tokio::test]
    async fn search_matches_chinese_substring() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "在 virlen-app 实现记忆功能"))
            .await
            .unwrap();
        repo.upsert(&record("m2", MEMORY_LEVEL_NORMAL, "用户偏好中文回复"))
            .await
            .unwrap();

        let hits = repo.search("记忆功能", None, None, 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "m1");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 短查询（< 3 字符）回退 LIKE —— 走 FTS 的话必然空结果
    #[tokio::test]
    async fn search_falls_back_to_like_for_short_query() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "记忆功能 P1")).await.unwrap();

        let hits = repo.search("记忆", None, None, 10).await.unwrap();
        assert_eq!(hits.len(), 1, "2 字符查询必须回退 LIKE，否则永远搜不到");
        assert_eq!(hits[0].id, "m1");

        // LIKE 通配符不得被当语法（`%` 应被转义成字面量）
        assert!(repo.search("%", None, None, 10).await.unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// level / kind 过滤 + 禁用项不参与召回 + limit 收敛
    #[tokio::test]
    async fn search_filters_and_excludes_disabled() {
        let (repo, dir) = tmp_repo();
        let mut p = record("p1", MEMORY_LEVEL_PERMANENT, "记忆功能上线计划");
        p.kind = "decision".into();
        repo.upsert(&p).await.unwrap();
        repo.upsert(&record("n1", MEMORY_LEVEL_NORMAL, "记忆功能实现细节"))
            .await
            .unwrap();
        let mut off = record("n2", MEMORY_LEVEL_NORMAL, "记忆功能已废弃方案");
        off.disabled = true;
        repo.upsert(&off).await.unwrap();

        assert_eq!(repo.search("记忆功能", None, None, 10).await.unwrap().len(), 2, "禁用项不召回");
        let perm = repo.search("记忆功能", Some(MEMORY_LEVEL_PERMANENT), None, 10).await.unwrap();
        assert_eq!(perm.len(), 1);
        assert_eq!(perm[0].id, "p1");
        let decisions = repo.search("记忆功能", None, Some("decision"), 10).await.unwrap();
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].id, "p1");
        assert_eq!(repo.search("记忆功能", None, None, 1).await.unwrap().len(), 1);
        // 空查询不做全表返回
        assert!(repo.search("   ", None, None, 10).await.unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 编辑 / 删除后 FTS 索引跟着变（外部内容表的触发器是否生效）
    #[tokio::test]
    async fn search_index_follows_updates_and_deletes() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "旧的说法")) .await.unwrap();
        assert_eq!(repo.search("旧的说法", None, None, 10).await.unwrap().len(), 1);

        let mut edited = record("m1", MEMORY_LEVEL_NORMAL, "新的说法");
        edited.created_at = 0;
        repo.upsert(&edited).await.unwrap();
        assert!(repo.search("旧的说法", None, None, 10).await.unwrap().is_empty());
        assert_eq!(repo.search("新的说法", None, None, 10).await.unwrap().len(), 1);

        repo.delete("m1").await.unwrap();
        assert!(repo.search("新的说法", None, None, 10).await.unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ==================== 整理流水（P2） ====================

    fn run(day: &str, status: &str, attempts: i64, started_at: i64) -> MemoryRun {
        MemoryRun {
            day: day.into(),
            status: status.into(),
            attempts,
            started_at,
            ..Default::default()
        }
    }

    /// 抢锁的四条分支（纯函数）：没有记录 → 抢；已处理 → 让；失败可重试；跑太久 → 抢占
    #[test]
    fn claim_decision_covers_all_branches() {
        let now = 1_700_000_000_000;
        assert_eq!(decide_claim(None, now, 600_000, 2, false), ClaimDecision::Claimed);

        assert_eq!(
            decide_claim(Some(&run("d", MEMORY_RUN_DONE, 1, now)), now, 600_000, 2, false),
            ClaimDecision::AlreadyDone,
            "同一天绝不跑第二次（幂等键的语义）"
        );
        assert_eq!(
            decide_claim(Some(&run("d", MEMORY_RUN_SKIPPED, 1, now)), now, 600_000, 2, false),
            ClaimDecision::AlreadyDone,
            "无素材也是「处理过了」，否则每天都会重跑一遍"
        );
        assert_eq!(
            decide_claim(Some(&run("d", "weird", 1, now)), now, 600_000, 2, false),
            ClaimDecision::AlreadyDone,
            "未知状态按已处理：宁可少跑一次，也不能重复写记忆"
        );

        // 失败：尝试未耗尽 → 可重试；耗尽 → 等人工
        assert_eq!(
            decide_claim(Some(&run("d", MEMORY_RUN_FAILED, 1, now)), now, 600_000, 2, false),
            ClaimDecision::Claimed
        );
        assert_eq!(
            decide_claim(Some(&run("d", MEMORY_RUN_FAILED, 2, now)), now, 600_000, 2, false),
            ClaimDecision::Exhausted
        );

        // running：未超时 → 让给别人；超时（崩溃残留）→ 抢占
        assert_eq!(
            decide_claim(
                Some(&run("d", MEMORY_RUN_RUNNING, 1, now - 1_000)),
                now,
                600_000,
                2,
                false
            ),
            ClaimDecision::Busy
        );
        assert_eq!(
            decide_claim(
                Some(&run("d", MEMORY_RUN_RUNNING, 1, now - 700_000)),
                now,
                600_000,
                2,
                false
            ),
            ClaimDecision::Claimed,
            "进程被杀会留下 running 残留，不抢回来那一天就永远卡住"
        );

        // force（面板的「重新整理」）：已有状态全部无视
        for status in [MEMORY_RUN_DONE, MEMORY_RUN_SKIPPED, MEMORY_RUN_RUNNING] {
            assert_eq!(
                decide_claim(Some(&run("d", status, 5, now)), now, 600_000, 2, true),
                ClaimDecision::Claimed,
                "{} 状态下的强制重跑必须能拿到锁",
                status
            );
        }
    }

    fn claim_opts(now: i64) -> ClaimOptions {
        ClaimOptions {
            now_ms: now,
            stale_ms: 600_000,
            max_attempts: 2,
            force: false,
        }
    }

    /// 抢锁 → 落终态 → 补跑起点：数据库侧的幂等闭环
    #[tokio::test]
    async fn run_lifecycle_is_idempotent_per_day() {
        let (repo, dir) = tmp_repo();
        let now = 1_700_000_000_000;

        let claimed = repo.claim_run("2026-10-05", claim_opts(now)).await.unwrap();
        let mut claimed = claimed.expect("首次必须抢到");
        assert_eq!(claimed.status, MEMORY_RUN_RUNNING);
        assert_eq!(claimed.attempts, 1);

        // 同一时刻再抢：别人在跑 → 让
        assert!(repo
            .claim_run("2026-10-05", claim_opts(now))
            .await
            .unwrap()
            .is_none());

        claimed.status = MEMORY_RUN_DONE.into();
        claimed.items = 3;
        claimed.details = 1;
        claimed.source_sessions = 2;
        claimed.model = Some("p1/m1".into());
        claimed.finished_at = Some(now + 10);
        claimed.prompt_tokens = Some(100);
        claimed.completion_tokens = Some(20);
        repo.finish_run(&claimed).await.unwrap();

        let got = repo.get_run("2026-10-05").await.unwrap().unwrap();
        assert_eq!(got.status, MEMORY_RUN_DONE);
        assert_eq!(got.items, 3);
        assert_eq!(got.model.as_deref(), Some("p1/m1"));
        assert_eq!(got.prompt_tokens, Some(100));
        assert_eq!(repo.last_done_day().await.unwrap().as_deref(), Some("2026-10-05"));

        // 已 done：再抢也不会跑（这是「重跑要显式 force」的那条约定）
        assert!(repo
            .claim_run("2026-10-05", claim_opts(now + 1))
            .await
            .unwrap()
            .is_none());
        // 更早的一天还没处理 → 不影响它
        assert!(repo
            .claim_run("2026-10-04", claim_opts(now))
            .await
            .unwrap()
            .is_some());
        // force：已完成的一天也能被强制重跑（attempts 重新从 1 开始）
        let forced = repo
            .claim_run(
                "2026-10-05",
                ClaimOptions {
                    force: true,
                    ..claim_opts(now + 2)
                },
            )
            .await
            .unwrap()
            .expect("force 必须能拿到锁");
        assert_eq!(forced.attempts, 1);
        assert_eq!(forced.status, MEMORY_RUN_RUNNING);

        let runs = repo.list_runs(10).await.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].day, "2026-10-05", "新 → 旧");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 失败重试的次数上限：耗尽后不再抢（避免每次启动都烧一次调用）
    #[tokio::test]
    async fn failed_runs_stop_after_max_attempts() {
        let (repo, dir) = tmp_repo();
        let now = 1_700_000_000_000;
        for attempt in 1..=2 {
            let mut r = repo
                .claim_run("2026-10-05", claim_opts(now))
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("第 {} 次应当抢到", attempt));
            assert_eq!(r.attempts, attempt);
            r.status = MEMORY_RUN_FAILED.into();
            r.error = Some("模型返回非 JSON".into());
            r.finished_at = Some(now);
            repo.finish_run(&r).await.unwrap();
        }
        assert!(repo
            .claim_run("2026-10-05", claim_opts(now))
            .await
            .unwrap()
            .is_none());
        // 失败的日不算「已处理」：补跑起点不会跳过它
        assert_eq!(repo.last_done_day().await.unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 「重新整理某天」只删蒸馏产出，不碰用户手写的与别的日期的条目
    #[tokio::test]
    async fn delete_distilled_day_keeps_user_entries() {
        let (repo, dir) = tmp_repo();
        let mut distilled = record("d1", MEMORY_LEVEL_NORMAL, "蒸馏出来的");
        distilled.origin = MEMORY_ORIGIN_DISTILL.into();
        distilled.source_day = "2026-10-05".into();
        repo.upsert(&distilled).await.unwrap();

        let mut manual = record("u1", MEMORY_LEVEL_PERMANENT, "用户手写的");
        manual.origin = "user".into();
        manual.source_day = "2026-10-05".into();
        repo.upsert(&manual).await.unwrap();

        let mut other_day = record("d2", MEMORY_LEVEL_NORMAL, "别的日子的蒸馏");
        other_day.origin = MEMORY_ORIGIN_DISTILL.into();
        other_day.source_day = "2026-10-04".into();
        repo.upsert(&other_day).await.unwrap();

        let removed = repo.delete_distilled_day("2026-10-05").await.unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "d1");
        let left: Vec<String> = repo
            .list(None, true)
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(left, vec!["u1".to_string(), "d2".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Noop：整理流水也一律读回空（无库环境下整条链按「不整理」处理）
    #[tokio::test]
    async fn noop_run_methods_are_harmless() {
        let repo = NoopMemoryRepo;
        assert!(repo.get_run("2026-10-05").await.unwrap().is_none());
        assert!(repo.list_runs(10).await.unwrap().is_empty());
        assert_eq!(repo.last_done_day().await.unwrap(), None);
        assert!(repo.claim_run("2026-10-05", claim_opts(0)).await.unwrap().is_none());
        repo.finish_run(&run("2026-10-05", MEMORY_RUN_DONE, 1, 0)).await.unwrap();
        assert!(repo.delete_distilled_day("2026-10-05").await.unwrap().is_empty());
    }
}
