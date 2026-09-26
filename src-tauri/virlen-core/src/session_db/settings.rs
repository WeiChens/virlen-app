//! 应用设置（配置下沉 D3）—— `app_settings` 表
//!
//! 放在 `session_db` 下的原因：配置与会话共用同一个 SQLite 文件与同一把单写连接 —— 不再需要第二个写
//! 连接（不会引入 `SQLITE_BUSY`），迁移 / 维护（体积统计、WAL 截断、`VACUUM`）天然覆盖配置，CLI 与
//! GUI 只要指向同一个 `virlen.db`（`HostEnv::data_dir()`）就共用同一份配置。
//!
//! 一 key 一行而不是整份 JSON 存一个 key：写入只改动过的那几个键 → 多窗口 / 并发场景不会因整份覆盖
//! 而丢更新，`updated_at` 可用于定位「最近改了什么」。
//!
//! ⚠️ 键名与 `src/ui/store/settingStore.ts` 的 `SettingsStore` 字段同名同层（如 `providers` /
//! `permissions` / `sandboxMode`），Rust 侧不建映射表 —— 这是避免「配置字段漂移」的关键（见
//! `docs/config-sink-plan.md` §6 R6）。保留键以 `__` 开头，业务键不得使用该前缀。

use async_trait::async_trait;
use rusqlite::{params, Connection};
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};

/// 配置结构版本键（独立于 `schema.rs` 的表结构版本 `PRAGMA user_version`）
///
/// 写入方是待办 #E-S2（前端首启从 localStorage 迁移时写一次）；在它落地前暂无 Rust 消费方。
#[allow(dead_code)]
pub const SETTINGS_SCHEMA_VERSION_KEY: &str = "__schemaVersion";
/// 迁移来源键（首启从 localStorage 导入时写一次，便于排查）
///
/// 同为待办 #E-S2 的消费点；此处先固定键名，避免两侧各写一套字面量（铁律 1 的同精神）。
#[allow(dead_code)]
pub const SETTINGS_MIGRATED_FROM_KEY: &str = "__migratedFrom";

// ==================== Trait ====================

#[async_trait]
pub trait SettingsRepo: Send + Sync {
    /// 读取全部配置（键 → JSON 值）。
    ///
    /// 单行 JSON 解析失败时**不让整次读取失败**：该行退化成原始字符串返回
    /// （宁可让上层看到一条坏值，也不要因为一行脏数据打不开设置页）。
    async fn get_all(&self) -> Result<Map<String, Value>, String>;

    /// 单事务写入/覆写若干键（只动传入的键，其它键保持不变）
    async fn upsert(&self, entries: Map<String, Value>) -> Result<(), String>;

    /// **仅当表为空**时导入（首启从 localStorage 迁移用）；返回是否真的写入。
    ///
    /// 幂等：表里已有任何一行就不会覆盖（避免把用户后来在 CLI 改过的配置顶掉）。
    async fn import_if_empty(&self, entries: Map<String, Value>) -> Result<bool, String>;

    /// 是否存在**真实的持久化后端**（`NoopSettingsRepo` 覆写为 `false`）。
    /// 与 `SessionRepo::is_available()` 同一套探针语义。
    ///
    /// 消费方：`cmd_settings_get_all` —— 无后端时如实报错，而不是返回空表
    /// （返回空表会让前端误判为「首启 → 该导入」，反复调用 `cmd_settings_import`）。
    fn is_available(&self) -> bool {
        true
    }
}

// ==================== SQLite 实现 ====================

pub struct SqliteSettingsRepo {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteSettingsRepo {
    /// 复用会话库的连接（**同一把锁** → 与会话写入天然互斥）
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }
}

/// 读取全部配置（纯函数，便于单测）
fn read_all(conn: &Connection) -> Result<Map<String, Value>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_settings")
        .map_err(|e| format!("读取配置失败: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取配置失败: {}", e))?;

    let mut out = Map::new();
    for row in rows {
        let (key, raw) = row.map_err(|e| format!("读取配置失败: {}", e))?;
        // 坏行退化：不是错误，按字符串返回
        let value = serde_json::from_str::<Value>(&raw).unwrap_or(Value::String(raw));
        out.insert(key, value);
    }
    Ok(out)
}

/// 在一个事务里 upsert 若干键（纯函数，便于单测）
fn upsert_in_tx(tx: &rusqlite::Transaction<'_>, entries: &Map<String, Value>) -> Result<(), String> {
    let now = crate::telemetry::now_ms();
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            )
            .map_err(|e| format!("写入配置失败: {}", e))?;
        for (key, value) in entries {
            let encoded =
                serde_json::to_string(value).map_err(|e| format!("序列化配置项 {} 失败: {}", key, e))?;
            stmt.execute(params![key, encoded, now])
                .map_err(|e| format!("写入配置项 {} 失败: {}", key, e))?;
        }
    }
    Ok(())
}

fn has_any_row(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM app_settings)", [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| n != 0)
    .map_err(|e| format!("读取配置失败: {}", e))
}

#[async_trait]
impl SettingsRepo for SqliteSettingsRepo {
    async fn get_all(&self) -> Result<Map<String, Value>, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            read_all(&conn)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn upsert(&self, entries: Map<String, Value>) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = conn.lock().unwrap();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启配置事务失败: {}", e))?;
            upsert_in_tx(&tx, &entries)?;
            tx.commit().map_err(|e| format!("提交配置事务失败: {}", e))
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    async fn import_if_empty(&self, entries: Map<String, Value>) -> Result<bool, String> {
        if entries.is_empty() {
            return Ok(false);
        }
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<bool, String> {
            let conn = conn.lock().unwrap();
            // 「查空 + 写入」在同一把锁内完成 → 不会出现两个导入交叠
            if has_any_row(&conn)? {
                return Ok(false);
            }
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("开启配置事务失败: {}", e))?;
            upsert_in_tx(&tx, &entries)?;
            tx.commit().map_err(|e| format!("提交配置事务失败: {}", e))?;
            Ok(true)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
}

// ==================== Noop 实现（测试 / 无库环境） ====================

#[derive(Default)]
pub struct NoopSettingsRepo;

#[async_trait]
impl SettingsRepo for NoopSettingsRepo {
    fn is_available(&self) -> bool {
        false
    }
    async fn get_all(&self) -> Result<Map<String, Value>, String> {
        Ok(Map::new())
    }
    /// 静默丢弃：无后端时写入不应把调用方（前端自动保存）打断
    async fn upsert(&self, _entries: Map<String, Value>) -> Result<(), String> {
        Ok(())
    }
    async fn import_if_empty(&self, _entries: Map<String, Value>) -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo() -> (crate::session_db::sqlite::SqliteSessionRepo, SqliteSettingsRepo, std::path::PathBuf)
    {
        let dir = std::env::temp_dir().join(format!("virlen_settings_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let session = crate::session_db::sqlite::SqliteSessionRepo::open(&dir.join("virlen.db")).unwrap();
        let settings = SqliteSettingsRepo::new(session.conn.clone());
        (session, settings, dir)
    }

    fn entry(v: Value) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("k".into(), v);
        m
    }

    #[tokio::test]
    async fn upsert_then_read_roundtrip_keeps_json_types() {
        let (_session, repo, dir) = tmp_repo();

        let mut entries = Map::new();
        entries.insert("language".into(), Value::String("en-US".into()));
        entries.insert("maxIterations".into(), Value::from(5));
        entries.insert(
            "permissions".into(),
            serde_json::json!({ "terminal.normal.execute": "ask" }),
        );
        repo.upsert(entries).await.unwrap();

        let all = repo.get_all().await.unwrap();
        assert_eq!(all["language"], Value::String("en-US".into()));
        assert_eq!(all["maxIterations"], Value::from(5));
        assert_eq!(all["permissions"]["terminal.normal.execute"], "ask");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upsert_is_per_key_and_does_not_drop_other_keys() {
        let (_session, repo, dir) = tmp_repo();

        repo.upsert(entry(Value::from(1))).await.unwrap();
        let mut second = Map::new();
        second.insert("other".into(), Value::from(2));
        repo.upsert(second).await.unwrap();

        let all = repo.get_all().await.unwrap();
        assert_eq!(all.len(), 2, "按 key 增量写入，不应清掉其它键: {all:?}");
        assert_eq!(all["k"], Value::from(1));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn import_if_empty_only_writes_once() {
        let (_session, repo, dir) = tmp_repo();

        let mut first = Map::new();
        first.insert("language".into(), Value::String("zh-CN".into()));
        assert!(repo.import_if_empty(first).await.unwrap(), "空表应导入");

        let mut second = Map::new();
        second.insert("language".into(), Value::String("en-US".into()));
        assert!(!repo.import_if_empty(second).await.unwrap(), "非空表不得覆盖");

        let all = repo.get_all().await.unwrap();
        assert_eq!(all["language"], Value::String("zh-CN".into()));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn empty_entries_are_no_ops() {
        let (_session, repo, dir) = tmp_repo();
        repo.upsert(Map::new()).await.unwrap();
        assert!(!repo.import_if_empty(Map::new()).await.unwrap());
        assert!(repo.get_all().await.unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 单行 JSON 坏掉时不能让整次读取失败（否则设置页打不开）
    #[tokio::test]
    async fn corrupt_row_degrades_to_raw_string() {
        let (session, repo, dir) = tmp_repo();
        {
            let conn = session.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES ('broken', '{not json', 0)",
                [],
            )
            .unwrap();
        }
        let all = repo.get_all().await.unwrap();
        assert_eq!(all["broken"], Value::String("{not json".into()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn noop_repo_reports_unavailable_and_keeps_writes_harmless() {
        let repo = NoopSettingsRepo;
        assert!(!repo.is_available());
        assert!(repo.get_all().await.unwrap().is_empty());
        repo.upsert(entry(Value::from(1))).await.unwrap();
        assert!(!repo.import_if_empty(entry(Value::from(1))).await.unwrap());
    }

    /// 保留键约定：以 `__` 开头，业务键（前端 `SettingsStore` 字段名）不得使用该前缀
    #[test]
    fn reserved_keys_are_double_underscore_prefixed() {
        assert!(SETTINGS_SCHEMA_VERSION_KEY.starts_with("__"));
        assert!(SETTINGS_MIGRATED_FROM_KEY.starts_with("__"));
        assert_ne!(SETTINGS_SCHEMA_VERSION_KEY, SETTINGS_MIGRATED_FROM_KEY);
    }
}
