//! 长期记忆 —— `memories` 表 + `MemoryRepo`。
//!
//! 与会话 / 配置共用同一个 `virlen.db` 与同一把连接锁（不引入第二个写连接 → 不会 `SQLITE_BUSY`），
//! GUI 与 CLI 只要 `HostEnv::data_dir()` 同目录即读写同一份记忆。
//!
//! 两条硬约束（改这里别丢）：
//! - **建表放 `init_schema` 快速路径，不占 `SCHEMA_VERSION`**：纯新增表无回填；递增版本会让 `migrate()`
//!   对全库跑一次 `messages_fts` rebuild（大库分钟级）。
//! - **表里只存提炼后的短句**（`summary` ≤ `MEMORY_SUMMARY_MAX_CHARS`）：详情正文在专用知识库里，这里只留
//!   `detail_kb_id` / `detail_doc_id` 两个链接字段 —— 记忆表要能整体塞进系统提示词。
//!
//! 检索与 `messages_fts` 同口径（trigram 分词，短于 3 字符回退 `LIKE`）。

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::agent::memory::new_memory_id;

/// 生成 id 的最大尝试次数（撞主键就重试）——
/// 10 位 base36（≈3.7e15）下第一次就中的概率是 1 - O(n/3.7e15)；8 次只是把「库坏了」这种
/// 非撞车情形也变成有界的，不会死循环。
const MEMORY_ID_MAX_ATTEMPTS: usize = 8;

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
  disabled          INTEGER NOT NULL DEFAULT 0,
  -- 被哪个新条目顶替的（再蒸馏的软删标记）：非空 + disabled = 1 = 已归档。
  -- ⚠️ 它同时是**归档清理（GC）的判定字段**：没有它 = 用户自己停用的，永不清理。
  -- 老库的列由 `schema.rs` 的 `ensure_memories_superseded_by_column` 补出（补为 NULL）。
  superseded_by     TEXT
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

-- 再蒸馏流水：主键 = **批次指纹**（幂等键），因此「GUI 多窗口 / GUI + CLI 同开 / 退出后重启」
-- 都自然收敛（同一批内容只整理一次）。
-- 清理任务用 `fingerprint = 'purge'` 的单行，它的 `finished_at` 就是「上次清理时间」。
CREATE TABLE IF NOT EXISTS memory_redistill_runs (
  fingerprint    TEXT PRIMARY KEY,
  status         TEXT NOT NULL,              -- running | done | partial | skipped | failed
  scope          TEXT NOT NULL DEFAULT '',   -- project_path，'' = 不限定项目
  items_in       INTEGER NOT NULL DEFAULT 0,
  items_out      INTEGER NOT NULL DEFAULT 0,
  details        INTEGER NOT NULL DEFAULT 0,  -- 成功落归档详情的条数
  drifted        INTEGER NOT NULL DEFAULT 0,  -- CAS 未命中的来源数（期间被改过）
  purged         INTEGER NOT NULL DEFAULT 0,  -- 本轮清理掉多少条归档超期的旧条目
  purged_failed  INTEGER NOT NULL DEFAULT 0,
  out_ids        TEXT NOT NULL DEFAULT '[]',  -- 本次产出的新条目 id（只存 id，不存正文）
  model          TEXT,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  prompt_tokens  INTEGER,
  completion_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_redistill_runs_recent
  ON memory_redistill_runs(started_at DESC);

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

/// `memories.origin`：创建方式（重蒸馏只动 AI 产出的条目，用户手写的一律不碰）
///
/// `user` = 面板新增 / 编辑（**不参与再蒸馏**，也不计入阈值：用户自己攒的 200 条不该让 AI 永远白跑）；
/// `model` = 工具 `memory_write` 写入；`distill` = 蒸馏 / 再蒸馏产出。
pub const MEMORY_ORIGIN_USER: &str = "user";
pub const MEMORY_ORIGIN_MODEL: &str = "model";
pub const MEMORY_ORIGIN_DISTILL: &str = "distill";

// ==================== 再蒸馏流水（`memory_redistill_runs`，P2′） ====================

/// 正在跑（抢到锁；超过 `stale_ms` 视为崩溃残留，可被抢占）
pub const MEMORY_REDISTILL_RUNNING: &str = "running";
/// 跑完且有产出
pub const MEMORY_REDISTILL_DONE: &str = "done";
/// 跑完但有降级（来源被改动 / 详情读不到 / 没收益）
pub const MEMORY_REDISTILL_PARTIAL: &str = "partial";
/// 没什么可做（无有效输出、知识库不可用……）：不写库，也算「这一批处理过了」
pub const MEMORY_REDISTILL_SKIPPED: &str = "skipped";
/// 模型调用 / 落库失败：`attempts` 未耗尽前可重试
pub const MEMORY_REDISTILL_FAILED: &str = "failed";

/// 清理任务的主键（它自己的幂等键：全局唯一的一行，`finished_at` = 上次清理时间）
pub const MEMORY_REDISTILL_PURGE_FINGERPRINT: &str = "purge";

/// 一次再蒸馏的流水（`memory_redistill_runs` 一行的镜像；CLI / 将来的面板看它）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct MemoryRedistillRun {
    /// 批次指纹（幂等键、主键）；清理任务是 [`MEMORY_REDISTILL_PURGE_FINGERPRINT`]
    pub fingerprint: String,
    /// `running` | `done` | `partial` | `skipped` | `failed`
    pub status: String,
    /// 项目作用域（`''` = 不限定项目）
    pub scope: String,
    pub items_in: i64,
    pub items_out: i64,
    /// 成功落归档详情的条数
    pub details: i64,
    /// CAS 未命中的来源数（期间被 AI / 用户改过 → 保持启用）
    pub drifted: i64,
    pub purged: i64,
    pub purged_failed: i64,
    /// 本次产出的新条目 id（只存 id，不存正文）
    pub out_ids: Vec<String>,
    /// 实际使用的模型（`providerConfigId/modelId`）
    pub model: Option<String>,
    /// 跳过原因 / 失败原因（不含记忆正文）
    pub error: Option<String>,
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
    /// 另一个窗口 / 进程正在跑（或崩溃残留但还没到老化阈值）
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

/// 抢锁参数（把参数收成一个结构体：调用点只关心「现在 / 老化阈值 / 上限 / 是否强制」）
#[derive(Debug, Clone, Copy)]
pub struct ClaimOptions {
    pub now_ms: i64,
    /// `running` 超过它就视为崩溃残留，可被抢占
    pub stale_ms: i64,
    /// 失败后最多尝试几次
    pub max_attempts: i64,
    /// `true` = 忽略已有状态（面板 / CLI 的 `--force`）；自动触发永远为 `false`
    pub force: bool,
}

/// 能否抢下这一批的整理锁（**纯函数**）。
///
/// - `force` → 直接抢（用户的显式动作：覆盖任何已有状态）；
/// - 没有记录 → 抢；
/// - `running` 且未超 `stale_ms` → 让给别人（多窗口 / GUI + CLI 同时开着只跑一次）；
///   超过阈值（进程被杀留下的残留）→ 抢占，否则那一批永远卡在 `running`；
/// - `failed` 且 `attempts < max_attempts` → 允许重试；
/// - 其余（含未知状态）→ 视为已处理：宁可少跑一次，也不要让「重复整理」把记忆写两遍。
pub fn decide_claim(
    existing: Option<&MemoryRedistillRun>,
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
        MEMORY_REDISTILL_RUNNING => {
            if now_ms.saturating_sub(run.started_at) >= stale_ms.max(0) {
                ClaimDecision::Claimed
            } else {
                ClaimDecision::Busy
            }
        }
        MEMORY_REDISTILL_FAILED => {
            if run.attempts < max_attempts.max(1) {
                ClaimDecision::Claimed
            } else {
                ClaimDecision::Exhausted
            }
        }
        _ => ClaimDecision::AlreadyDone,
    }
}

/// 闸门用的统计（**一次查询拿齐**：写路径上只允许几条本地快查，不能读全表）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RedistillStats {
    /// `disabled = 0 AND origin <> 'user'` 的条数（阈值判定）
    pub candidates: i64,
    /// 已归档且超期的条数（清理判定）
    pub purge_candidates: i64,
    /// 是否存在「组内条数 ≥ min_group_items」的作用域组（值不值得合并）
    pub has_group: bool,
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
    /// `model` | `user`（历史数据里还可能有产物标记 `distill`）
    pub origin: String,
    pub hits: i64,
    pub last_used_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub disabled: bool,
    /// 被哪个新条目顶替的（再蒸馏的软删标记）：非空 + `disabled` = 已归档。
    ///
    /// `None` = 没被顶替（用户手写的、或从未参与过合并）—— 这是 **GC 的判定字段**：
    /// 没有它 = 用户自己停用的，永不清理。老库的列由 `ensure_memories_superseded_by_column` 补出。
    pub superseded_by: Option<String>,
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

    /// 生成一个**当前库里不存在**的记忆 id（写入新条目时用，见 `agent::memory::new_memory_id`）。
    ///
    /// 为何不只靠随机：`upsert` 是 `ON CONFLICT(id) DO UPDATE` —— 撞主键会**静默覆盖**另一条
    /// 记忆。短 id（12 字符）把撞车概率压到可忽略，但「可忽略」在数据丢失面前不算保证，
    /// 所以生成后查一次主键（走 `memories` 的 PK 索引，**只在写入路径上**，不碰读取热路径）。
    ///
    /// 默认实现 = 纯随机（测试桩 / [`NoopMemoryRepo`] 用；它们本来就不真写库）。
    async fn new_id(&self) -> String {
        new_memory_id()
    }

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

    // ===== 再蒸馏（P2′）=====
    //
    // ⚠️ 这组方法带**安全默认实现**（一律返回「没有候选 / 未命中」）：因此只有 `SqliteMemoryRepo`
    // 需要覆写，已有的一堆测试桩（记忆工具 / 注入 / 删除）不必逐个跟着改。
    // 代价是「忘了覆写不会报错」，所以 `session_db` 自己的单测**直接测 `SqliteMemoryRepo`**（见文件尾）。

    /// 闸门用的三条统计（一次拿齐，写路径上不读全表）
    async fn redistill_stats(
        &self,
        _now_ms: i64,
        _retention_ms: i64,
        _min_group_items: usize,
    ) -> Result<RedistillStats, String> {
        Ok(RedistillStats::default())
    }

    /// CAS 批量停用（再蒸馏用）：一条记忆被合并进新条目后**停用而不删除**。
    ///
    /// `ids` = `(id, 期望的 updated_at, 新条目 id)`；只有 `updated_at` 与快照一致且仍未停用
    /// 的行才会命中（期间被 AI / 用户改过的就跳过，宁可下次再来），返回实际命中行数。
    ///
    /// ⚠️ `updated_at` 同时被写成 `now`：它是**归档保留期的起点**（GC 按它算 30 天）。
    async fn supersede(&self, _ids: &[(String, i64, String)], _now_ms: i64) -> Result<usize, String> {
        Ok(0)
    }

    /// 抢一批的整理锁（幂等键 = 指纹）。返回 `None` = 没抢到（已处理 / 在跑 / 尝试耗尽）
    async fn claim_redistill_run(
        &self,
        _fingerprint: &str,
        _scope: &str,
        _opts: ClaimOptions,
    ) -> Result<Option<MemoryRedistillRun>, String> {
        Ok(None)
    }

    /// 写入 / 覆盖一条整理流水（主键 = 指纹）
    async fn finish_redistill_run(&self, _run: &MemoryRedistillRun) -> Result<(), String> {
        Ok(())
    }

    /// 取某个指纹的流水
    async fn get_redistill_run(
        &self,
        _fingerprint: &str,
    ) -> Result<Option<MemoryRedistillRun>, String> {
        Ok(None)
    }

    /// 最近一条**合并**流水（**不含**清理行 —— 冷却判定只看合并）
    async fn last_redistill_run(&self) -> Result<Option<MemoryRedistillRun>, String> {
        Ok(None)
    }

    /// 整理历史（排障 / CLI）；按开始时间倒序
    async fn list_redistill_runs(&self, _limit: usize) -> Result<Vec<MemoryRedistillRun>, String> {
        Ok(Vec::new())
    }

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
        // 空串 / NULL 一律收敛为 None（与 project_path 同口径）：库里不该出现「有值但是空串」这种半状态
        superseded_by: row
            .get::<_, Option<String>>("superseded_by")?
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    })
}

/// 流水行的映射（纯函数）
fn run_from_row(row: &rusqlite::Row) -> rusqlite::Result<MemoryRedistillRun> {
    let out_ids_json: String = row.get("out_ids")?;
    Ok(MemoryRedistillRun {
        fingerprint: row.get("fingerprint")?,
        status: row.get("status")?,
        scope: row.get("scope")?,
        items_in: row.get("items_in")?,
        items_out: row.get("items_out")?,
        details: row.get("details")?,
        drifted: row.get("drifted")?,
        purged: row.get("purged")?,
        purged_failed: row.get("purged_failed")?,
        // 坏行不报错：`out_ids` 只是「将来能撤销」的线索，不值得让整条流水读不出来
        out_ids: serde_json::from_str(&out_ids_json).unwrap_or_default(),
        model: row.get("model")?,
        error: row.get("error")?,
        attempts: row.get("attempts")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        prompt_tokens: row.get("prompt_tokens")?,
        completion_tokens: row.get("completion_tokens")?,
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

/// 闸门统计（纯函数）：三条查询都是**计数级**的，在写路径上跑得起（不读全表、不取正文）
fn redistill_stats_in_conn(
    conn: &Connection,
    now_ms: i64,
    retention_ms: i64,
    min_group_items: usize,
) -> Result<RedistillStats, String> {
    let candidates = conn
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE disabled = 0 AND origin <> ?1",
            params![MEMORY_ORIGIN_USER],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("统计可整理记忆失败: {}", e))?;

    // 超期判定与 `plan::is_purge_candidate` **逐条等价**（这里只数数；真正的护栏在那里逐条查）
    let cutoff = now_ms.saturating_sub(retention_ms.max(0));
    let purge_candidates = conn
        .query_row(
            "SELECT COUNT(*) FROM memories \
             WHERE disabled = 1 AND superseded_by IS NOT NULL AND TRIM(superseded_by) <> '' \
               AND updated_at > 0 AND updated_at <= ?1",
            params![cutoff],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("统计归档超期记忆失败: {}", e))?;

    let has_group = conn
        .query_row(
            "SELECT 1 FROM memories WHERE disabled = 0 AND origin <> ?1 \
             GROUP BY COALESCE(TRIM(project_path), '') HAVING COUNT(*) >= ?2 LIMIT 1",
            params![MEMORY_ORIGIN_USER, min_group_items.max(2) as i64],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("统计可合并分组失败: {}", e))?
        .is_some();

    Ok(RedistillStats {
        candidates,
        purge_candidates,
        has_group,
    })
}

/// CAS 批量停用（纯函数，**单事务**）：`(id, 期望 updated_at, 新条目 id)` → 停用 + 记下被谁顶替。
///
/// `updated_at` 写成 `now_ms` 是**归档保留期的起点**（GC 按它算 30 天）—— 写不进去，
/// 「很久没动过的旧条目」一归档就会被马上删掉。
fn supersede_in_conn(
    conn: &Connection,
    pairs: &[(String, i64, String)],
    now_ms: i64,
) -> Result<usize, String> {
    if pairs.is_empty() {
        return Ok(0);
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启记忆停用事务失败: {}", e))?;
    let mut hit = 0usize;
    {
        let mut stmt = tx
            .prepare(
                "UPDATE memories SET disabled = 1, superseded_by = ?3, updated_at = ?4 \
                 WHERE id = ?1 AND updated_at = ?2 AND disabled = 0",
            )
            .map_err(|e| format!("准备记忆停用失败: {}", e))?;
        for (id, expected, new_id) in pairs {
            hit += stmt
                .execute(params![id, expected, new_id, now_ms])
                .map_err(|e| format!("停用记忆失败: {}", e))?;
        }
    }
    tx.commit()
        .map_err(|e| format!("提交记忆停用事务失败: {}", e))?;
    Ok(hit)
}

/// 取某个指纹的流水（纯函数）
fn get_run_in_conn(conn: &Connection, fingerprint: &str) -> Result<Option<MemoryRedistillRun>, String> {
    conn.query_row(
        "SELECT * FROM memory_redistill_runs WHERE fingerprint = ?1",
        params![fingerprint],
        run_from_row,
    )
    .optional()
    .map_err(|e| format!("查询整理流水失败: {}", e))
}

/// 写入 / 覆盖一条流水（纯函数，主键 = 指纹）
fn upsert_run_in_conn(conn: &Connection, run: &MemoryRedistillRun) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memory_redistill_runs (
            fingerprint, status, scope, items_in, items_out, details, drifted, purged,
            purged_failed, out_ids, model, error, attempts, started_at, finished_at,
            prompt_tokens, completion_tokens
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(fingerprint) DO UPDATE SET
            status = excluded.status,
            scope = excluded.scope,
            items_in = excluded.items_in,
            items_out = excluded.items_out,
            details = excluded.details,
            drifted = excluded.drifted,
            purged = excluded.purged,
            purged_failed = excluded.purged_failed,
            out_ids = excluded.out_ids,
            model = excluded.model,
            error = excluded.error,
            attempts = excluded.attempts,
            started_at = excluded.started_at,
            finished_at = excluded.finished_at,
            prompt_tokens = excluded.prompt_tokens,
            completion_tokens = excluded.completion_tokens",
        params![
            run.fingerprint,
            run.status,
            run.scope,
            run.items_in,
            run.items_out,
            run.details,
            run.drifted,
            run.purged,
            run.purged_failed,
            serde_json::to_string(&run.out_ids).unwrap_or_else(|_| "[]".to_string()),
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

/// id 是否已被占用（`memories` 主键点查；写入路径专用，不在读取热路径上）
fn id_taken_in_conn(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM memories WHERE id = ?1)",
        params![id],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .map_err(|e| format!("查询记忆 id 是否占用失败: {}", e))
}

/// 写入（纯函数）：同 id 覆盖，但 `created_at` 与 `hits` / `last_used_at` 保持库中现值 ——
/// 它们是「历史统计」，不能被编辑摘要这种动作清掉。
///
/// ⚠️ `superseded_by` **刻意不进写入列清单**：它是「被谁顶替」这个**历史事实**，同样不能被
/// 编辑摘要抹掉（否则一次编辑就能让归档清理的护栏失效）。新条目不写该列 → 自然为 NULL。
/// 唯一的写入点是 [`MemoryRepo::supersede`]。
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

    async fn new_id(&self) -> String {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            for _ in 0..MEMORY_ID_MAX_ATTEMPTS {
                let id = new_memory_id();
                // 查询失败按「已占用」处理：多试一次总比返回一个没确认过的 id 便宜
                if !id_taken_in_conn(&conn, &id).unwrap_or(true) {
                    return id;
                }
            }
            // 连撞 8 次 / 库读不了：退回长 id（uuid 只有 32 位十六进制，撞车概率可忽略）。
            // 它照样合法（id 一直是 TEXT，没长度约定），只是长一点 —— 总好过覆盖别人的记忆。
            format!("m_{}", uuid::Uuid::new_v4().simple())
        })
        .await
        .unwrap_or_else(|_| new_memory_id())
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

    // ===== 再蒸馏（P2′） =====

    async fn redistill_stats(
        &self,
        now_ms: i64,
        retention_ms: i64,
        min_group_items: usize,
    ) -> Result<RedistillStats, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            redistill_stats_in_conn(&conn, now_ms, retention_ms, min_group_items)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn supersede(&self, ids: &[(String, i64, String)], now_ms: i64) -> Result<usize, String> {
        let conn = self.conn.clone();
        let pairs = ids.to_vec();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            supersede_in_conn(&conn, &pairs, now_ms)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn claim_redistill_run(
        &self,
        fingerprint: &str,
        scope: &str,
        opts: ClaimOptions,
    ) -> Result<Option<MemoryRedistillRun>, String> {
        let conn = self.conn.clone();
        let fingerprint = fingerprint.to_string();
        let scope = scope.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let existing = get_run_in_conn(&conn, &fingerprint)?;
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
            // 抢到：置 running、attempts +1（计数由 finish 覆盖）；
            // 强制重跑时 attempts 归零（新的一次用户意图，不该背负之前用掉的次数）
            let mut run = existing.unwrap_or_default();
            run.fingerprint = fingerprint.clone();
            run.scope = scope.clone();
            run.status = MEMORY_REDISTILL_RUNNING.to_string();
            run.attempts = if opts.force { 1 } else { run.attempts + 1 };
            run.started_at = opts.now_ms;
            run.finished_at = None;
            upsert_run_in_conn(&conn, &run)?;
            Ok(Some(run))
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn finish_redistill_run(&self, run: &MemoryRedistillRun) -> Result<(), String> {
        let conn = self.conn.clone();
        let run = run.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            upsert_run_in_conn(&conn, &run)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn get_redistill_run(
        &self,
        fingerprint: &str,
    ) -> Result<Option<MemoryRedistillRun>, String> {
        let conn = self.conn.clone();
        let fingerprint = fingerprint.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            get_run_in_conn(&conn, &fingerprint)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn last_redistill_run(&self) -> Result<Option<MemoryRedistillRun>, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.query_row(
                "SELECT * FROM memory_redistill_runs WHERE fingerprint <> ?1 \
                 ORDER BY started_at DESC LIMIT 1",
                params![MEMORY_REDISTILL_PURGE_FINGERPRINT],
                run_from_row,
            )
            .optional()
            .map_err(|e| format!("查询最近整理流水失败: {}", e))
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn list_redistill_runs(&self, limit: usize) -> Result<Vec<MemoryRedistillRun>, String> {
        let conn = self.conn.clone();
        let limit = limit.clamp(1, 200) as i64;
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT * FROM memory_redistill_runs ORDER BY started_at DESC LIMIT ?1")
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
    async fn schema_is_created_and_idempotent() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "第一条")).await.unwrap();
        // 再开一次（模拟第二次启动）：表已存在 → 不报错、数据还在
        let session =
            crate::session_db::sqlite::SqliteSessionRepo::open(&dir.join("virlen.db")).unwrap();
        let repo2 = SqliteMemoryRepo::new(session.conn.clone());
        assert_eq!(repo2.list(None, false).await.unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 新 id 由仓储发：短、唯一，且能真的写进库
    #[tokio::test]
    async fn new_id_is_short_unique_and_writable() {
        let (repo, dir) = tmp_repo();
        let mut ids = std::collections::HashSet::new();
        for _ in 0..200 {
            let id = repo.new_id().await;
            assert!(id.starts_with("m_"), "前缀：{id}");
            assert_eq!(id.len(), 12, "`m_` + 10 位 base36：{id}");
            assert!(ids.insert(id.clone()), "重复发放：{id}");
        }
        // 发出来的 id 真的能落库（不是「看着唯一、写不进去」）
        let fresh = repo.new_id().await;
        repo.upsert(&record(&fresh, MEMORY_LEVEL_NORMAL, "新条目")).await.unwrap();
        assert!(repo.get(&fresh).await.unwrap().is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 查重机制的**直接**测试 —— 上面那个用例只能碰运气撞上重复，
    /// 这条把守卫本身钉住（撞主键的后果是 `upsert` 静默覆盖另一条记忆，不能只靠概率）。
    #[tokio::test]
    async fn id_taken_in_conn_detects_occupied_ids() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m_abc1234567", MEMORY_LEVEL_NORMAL, "占位"))
            .await
            .unwrap();
        let conn = repo.conn.clone();
        let conn = conn.lock().unwrap();
        assert!(id_taken_in_conn(&conn, "m_abc1234567").unwrap());
        assert!(!id_taken_in_conn(&conn, "m_zzzzzzzzzz").unwrap());
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
    async fn search_index_follows_updates_and_deletes() {        let (repo, dir) = tmp_repo();
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

    // ==================== 再蒸馏（P2′） ====================

    /// 老库补 `superseded_by` 列：幂等，且补出来是 NULL（= 没被顶替 → 永不被自动清理）
    #[tokio::test]
    async fn legacy_memories_table_gets_superseded_by_column() {
        let dir = std::env::temp_dir().join(format!(
            "virlen_memory_legacy_superseded_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("virlen.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            // 「上一个版本」的表结构 = 当前 DDL 删掉 superseded_by 那一列 —— **不手抄 DDL**，
            // 而且按行处理（源码里混有 CRLF / LF，直接匹配带换行的整行会依赖文件行尾）
            let legacy_ddl: String = MEMORY_DDL
                .lines()
                .filter(|l| !l.trim_start().starts_with("superseded_by"))
                .collect::<Vec<_>>()
                .join("\n")
                // 列删了，它前面的逗号也得去（否则 `DEFAULT 0, )` 是语法错）
                .replace(
                    "disabled          INTEGER NOT NULL DEFAULT 0,",
                    "disabled          INTEGER NOT NULL DEFAULT 0",
                );
            assert!(
                !legacy_ddl.contains("superseded_by     TEXT"),
                "DDL 里找不到 superseded_by 那一行 —— 改列名/缩进时记得同步本用例"
            );
            conn.execute_batch(&legacy_ddl).unwrap();
            conn.execute_batch(
                "INSERT INTO memories (id, level, kind, summary, tags, source_day, origin, created_at, updated_at)\n\
                 VALUES ('m_up', 'normal', 'project', '升级前就存在的', '[]', '', 'model', 1, 1);\n\
                 INSERT INTO memories_fts(memories_fts) VALUES('rebuild');",
            )
            .unwrap();
        }

        let session = crate::session_db::sqlite::SqliteSessionRepo::open(&db).unwrap();
        let repo = SqliteMemoryRepo::new(session.conn.clone());
        let all = repo.list(None, true).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].superseded_by, None, "补出来的列是 NULL");

        // 幂等：再开一次不报错（补列在快速路径里跑两次）
        let session2 = crate::session_db::sqlite::SqliteSessionRepo::open(&db).unwrap();
        let repo2 = SqliteMemoryRepo::new(session2.conn.clone());
        assert_eq!(repo2.list(None, true).await.unwrap().len(), 1);

        // 新列可写（走 supersede，不是只能读的遗留列）
        let stored = repo.get("m_up").await.unwrap().unwrap();
        assert_eq!(
            repo.supersede(&[("m_up".into(), stored.updated_at, "m_new".into())], 1_700_000_000_000)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            repo.get("m_up").await.unwrap().unwrap().superseded_by.as_deref(),
            Some("m_new")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `supersede`：CAS 停用 + 写「保留期起点」。任何不符都不动那一行。
    #[tokio::test]
    async fn supersede_is_cas_and_stamps_the_retention_clock() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "一")).await.unwrap();
        repo.upsert(&record("m2", MEMORY_LEVEL_NORMAL, "二")).await.unwrap();
        let m1 = repo.get("m1").await.unwrap().unwrap();
        let now = 1_700_000_500_000;

        // 命中：`updated_at` 与快照一致 → 停用 + 记下被谁顶替 + 刷新 updated_at
        let hit = repo
            .supersede(&[("m1".into(), m1.updated_at, "m_new".into())], now)
            .await
            .unwrap();
        assert_eq!(hit, 1);
        let after = repo.get("m1").await.unwrap().unwrap();
        assert!(after.disabled);
        assert_eq!(after.superseded_by.as_deref(), Some("m_new"));
        assert_eq!(after.updated_at, now, "updated_at = supersede 那一刻（GC 保留期的起点）");

        // 未命中：`updated_at` 不是快照值（期间被 AI / 用户改过）→ 保持启用
        let hit = repo
            .supersede(&[("m2".into(), 999, "m_new".into())], now)
            .await
            .unwrap();
        assert_eq!(hit, 0);
        let m2 = repo.get("m2").await.unwrap().unwrap();
        assert!(!m2.disabled);
        assert!(m2.superseded_by.is_none());

        // 未命中：已经停用了（不能把 `superseded_by` 改成另一个条目）
        let hit = repo
            .supersede(&[("m1".into(), now, "m_other".into())], now)
            .await
            .unwrap();
        assert_eq!(hit, 0);
        assert_eq!(
            repo.get("m1").await.unwrap().unwrap().superseded_by.as_deref(),
            Some("m_new")
        );

        // 空列表：什么都不做
        assert_eq!(repo.supersede(&[], now).await.unwrap(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 在面板上编辑一条被顶替的条目：`superseded_by` 保留（历史事实），
    /// `disabled` 按用户意图回到 0 —— 它又会被注入，且**不再**被自动清理。
    #[tokio::test]
    async fn editing_an_archived_entry_keeps_its_superseded_by() {
        let (repo, dir) = tmp_repo();
        repo.upsert(&record("m1", MEMORY_LEVEL_NORMAL, "旧")).await.unwrap();
        let stored = repo.get("m1").await.unwrap().unwrap();
        repo.supersede(&[("m1".into(), stored.updated_at, "m_new".into())], 1_700_000_000_000)
            .await
            .unwrap();

        // 面板保存（走 upsert）→ disabled 按本次输入回到 0
        let mut edited = record("m1", MEMORY_LEVEL_NORMAL, "改过的正文");
        edited.created_at = 0; // 面板编辑不带原始创建时间
        repo.upsert(&edited).await.unwrap();
        let got = repo.get("m1").await.unwrap().unwrap();
        assert_eq!(got.summary, "改过的正文");
        assert_eq!(got.superseded_by.as_deref(), Some("m_new"), "历史事实不被一次编辑抹掉");
        assert!(!got.disabled, "用户愿意它继续存在（他刚编辑过）");
        // 且 GC 不会碰它（护栏第①条就过不了）
        assert!(!crate::agent::memory::redistill::plan::is_purge_candidate(
            &got,
            1_700_000_000_000 + 2_592_000_000 * 2,
            2_592_000_000
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 抢锁四个分支（纯函数）—— DB 只负责执行它
    #[test]
    fn decide_claim_covers_the_four_branches() {
        let now = 1_700_000_000_000i64;
        let run = |status: &str, attempts: i64, started_at: i64| MemoryRedistillRun {
            status: status.into(),
            attempts,
            started_at,
            ..Default::default()
        };
        assert_eq!(
            decide_claim(None, now, 600_000, 3, false),
            ClaimDecision::Claimed,
            "没记录 → 抢"
        );
        assert_eq!(
            decide_claim(Some(&run(MEMORY_REDISTILL_DONE, 1, now)), now, 600_000, 3, false),
            ClaimDecision::AlreadyDone
        );
        assert_eq!(
            decide_claim(Some(&run(MEMORY_REDISTILL_SKIPPED, 1, now)), now, 600_000, 3, false),
            ClaimDecision::AlreadyDone,
            "跳过也算处理过了（否则无收益的批会无限重试）"
        );
        assert_eq!(
            decide_claim(Some(&run(MEMORY_REDISTILL_FAILED, 1, now)), now, 600_000, 3, false),
            ClaimDecision::Claimed,
            "失败但没耗尽 → 可重试"
        );
        assert_eq!(
            decide_claim(Some(&run(MEMORY_REDISTILL_FAILED, 3, now)), now, 600_000, 3, false),
            ClaimDecision::Exhausted,
            "尝试耗尽 → 等人工"
        );
        assert_eq!(
            decide_claim(Some(&run(MEMORY_REDISTILL_RUNNING, 1, now - 1_000)), now, 600_000, 3, false),
            ClaimDecision::Busy,
            "别人在跑 → 让开（多窗口只跑一次）"
        );
        assert_eq!(
            decide_claim(Some(&run(MEMORY_REDISTILL_RUNNING, 1, now - 700_000)), now, 600_000, 3, false),
            ClaimDecision::Claimed,
            "崩溃残留（超老化阈值）→ 抢占"
        );
        assert_eq!(
            decide_claim(Some(&run(MEMORY_REDISTILL_RUNNING, 1, now)), now, 600_000, 3, true),
            ClaimDecision::Claimed,
            "force（用户的显式动作）→ 直接抢"
        );
    }

    /// 流水读写：抢锁 → 老化抢占 → 终态 → `last_redistill_run` 不含清理行
    #[tokio::test]
    async fn redistill_runs_claim_finish_and_last() {
        let (repo, dir) = tmp_repo();
        let now = 1_700_000_000_000i64;
        let opts = ClaimOptions {
            now_ms: now,
            stale_ms: 600_000,
            max_attempts: 3,
            force: false,
        };

        let run = repo
            .claim_redistill_run("fp1", "C:/p", opts)
            .await
            .unwrap()
            .expect("首次应抢到");
        assert_eq!(run.status, MEMORY_REDISTILL_RUNNING);
        assert_eq!(run.attempts, 1);
        assert_eq!(run.scope, "C:/p");

        assert!(
            repo.claim_redistill_run("fp1", "C:/p", ClaimOptions { now_ms: now + 1_000, ..opts })
                .await
                .unwrap()
                .is_none(),
            "未老化时别人抢不到"
        );
        assert!(
            repo.claim_redistill_run("fp1", "C:/p", ClaimOptions { now_ms: now + 700_000, ..opts })
                .await
                .unwrap()
                .is_some(),
            "老化后可被抢占（否则永远卡在 running）"
        );

        let mut done = run.clone();
        done.status = MEMORY_REDISTILL_DONE.to_string();
        done.items_in = 6;
        done.items_out = 2;
        done.details = 2;
        done.out_ids = vec!["m_x".into(), "m_y".into()];
        done.model = Some("p1/m1".into());
        done.finished_at = Some(now + 1_000);
        done.prompt_tokens = Some(100);
        repo.finish_redistill_run(&done).await.unwrap();

        let stored = repo.get_redistill_run("fp1").await.unwrap().unwrap();
        assert_eq!(stored.status, MEMORY_REDISTILL_DONE);
        assert_eq!(stored.out_ids, vec!["m_x".to_string(), "m_y".to_string()]);
        assert_eq!(stored.items_out, 2);
        assert_eq!(stored.prompt_tokens, Some(100));
        assert!(
            repo.claim_redistill_run("fp1", "C:/p", opts).await.unwrap().is_none(),
            "已 done → 同一批不再跑（幂等键）"
        );
        assert!(
            repo.claim_redistill_run("fp1", "C:/p", ClaimOptions { force: true, ..opts })
                .await
                .unwrap()
                .is_some(),
            "force = 用户的显式覆盖"
        );

        // 清理行（fingerprint = purge）不进 `last_redistill_run`（冷却只看合并）
        let purge = MemoryRedistillRun {
            fingerprint: MEMORY_REDISTILL_PURGE_FINGERPRINT.to_string(),
            status: MEMORY_REDISTILL_DONE.to_string(),
            purged: 3,
            started_at: now + 10_000,
            finished_at: Some(now + 10_000),
            ..Default::default()
        };
        repo.finish_redistill_run(&purge).await.unwrap();
        let last = repo.last_redistill_run().await.unwrap().unwrap();
        assert_eq!(last.fingerprint, "fp1", "冷却判定必须忽略清理行");
        assert_eq!(repo.list_redistill_runs(10).await.unwrap().len(), 2);
        assert_eq!(
            repo.get_redistill_run(MEMORY_REDISTILL_PURGE_FINGERPRINT)
                .await
                .unwrap()
                .unwrap()
                .purged,
            3,
            "清理时间戳就靠这一行的 finished_at"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 闸门统计：只数 AI 产出且未停用的；分组判定与候选同口径
    #[tokio::test]
    async fn redistill_stats_matches_the_gate_rules() {
        let (repo, dir) = tmp_repo();
        for i in 0..6 {
            let mut r = record(&format!("m_a{i}"), MEMORY_LEVEL_NORMAL, "x");
            r.origin = MEMORY_ORIGIN_MODEL.into();
            repo.upsert(&r).await.unwrap();
        }
        // 用户手写的：不计入阈值（否则用户自己攒的 200 条会让 AI 永远白跑）
        repo.upsert(&record("m_user", MEMORY_LEVEL_NORMAL, "我写的"))
            .await
            .unwrap();
        // 停用的：不计入
        let mut off = record("m_off", MEMORY_LEVEL_NORMAL, "停了");
        off.origin = MEMORY_ORIGIN_MODEL.into();
        off.disabled = true;
        repo.upsert(&off).await.unwrap();

        let stats = repo.redistill_stats(1_700_000_000_000, 2_592_000_000, 5).await.unwrap();
        assert_eq!(stats.candidates, 6);
        assert!(stats.has_group, "6 条同一作用域（都不限定项目）");
        assert_eq!(stats.purge_candidates, 0, "没停用的条目 → 没有可清理的");
        assert!(
            !repo
                .redistill_stats(1_700_000_000_000, 2_592_000_000, 7)
                .await
                .unwrap()
                .has_group,
            "组内不够 7 条就不成组"
        );

        // 归档超期：只数「已停用 + 有 superseded_by + 超期」的
        let stored = repo.get("m_off").await.unwrap().unwrap();
        assert_eq!(
            repo.supersede(&[("m_off".into(), stored.updated_at, "m_new".into())], 1_000)
                .await
                .unwrap(),
            0,
            "已停用的行 CAS 不会命中（这是用户自己停的，不是我们顶替的）"
        );
        let stored = repo.get("m_a0").await.unwrap().unwrap();
        assert_eq!(
            repo.supersede(&[("m_a0".into(), stored.updated_at, "m_new".into())], 1_000)
                .await
                .unwrap(),
            1
        );
        let stats = repo.redistill_stats(1_700_000_000_000, 2_592_000_000, 5).await.unwrap();
        assert_eq!(stats.candidates, 5, "被停用的那条退出候选");
        assert_eq!(stats.purge_candidates, 1, "停用时刻 1_000 → 远超出保留期");
        std::fs::remove_dir_all(&dir).ok();
    }
}
