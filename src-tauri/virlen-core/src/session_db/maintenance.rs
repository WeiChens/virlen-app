//! 数据库维护 — 体积统计 / WAL 截断 / VACUUM（设置 → 存储「立即整理」）
//!
//! `virlen.db` 的膨胀有两个结构性来源，靠删数据解决不了：
//! 1. WAL 高水位：`-wal` 只在 checkpoint 能重置时才会缩回去，长跑进程里这个时机很难自然
//!    出现（实测堆积到 99 MB，比库本身的碎片量还大）；
//! 2. 空闲页不归还：`auto_vacuum=0` 时删除会话只是把页标记为空闲（freelist），文件只增不减
//!    （实测 403 MB 里有 5.5% 是空闲页）。
//!
//! 本模块的操作全部经同一把连接锁（与 `SqliteSessionRepo` 共享），因此与聊天写入天然互斥：
//! `stats`（文件大小 + PRAGMA + 行数，纯读、毫秒级）；`checkpoint_truncate`
//! （`wal_checkpoint(TRUNCATE)`，把 `-wal` 收回 0）；`vacuum`（`VACUUM` 重建整库、回收空闲页
//! 并把 `auto_vacuum` 切到 INCREMENTAL）。
//!
//! ⚠️ `VACUUM` 需约 2 倍库大小的临时空间且期间独占连接（数百 MB 库约 10–60 s），因此只在
//! 用户显式点击时执行，绝不自动跑；退出时只做廉价的 WAL 截断（`try_checkpoint_truncate`，
//! 拿不到锁就直接跳过）。

use rusqlite::Connection;
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// WAL 文件在 checkpoint 后的封顶大小（16 MB）。
///
/// `journal_size_limit` 只在 checkpoint 成功重置 WAL 时才会截断文件，所以它是「上限」
/// 而不是「保证」；但没有它时 `-wal` 会一直保持历史高水位（实测 99 MB）。
/// 注意：它**不影响** `wal_checkpoint(TRUNCATE)` 把文件截为 0（已实测）。
pub const WAL_SIZE_LIMIT: i64 = 16 * 1024 * 1024;

/// 数据库体积快照（字节；设置 → 存储 展示用）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStats {
    /// 主库文件 `virlen.db` 的物理大小。
    /// `VACUUM` 之后要等一次 checkpoint 才会真正变小，所以它可能滞后于 `page_bytes`。
    pub db_bytes: u64,
    /// `-wal` 的物理大小（>0 表示有尚未并入主库的写入）
    pub wal_bytes: u64,
    /// `-shm` 的物理大小（共享内存索引，固定 32 KB）
    pub shm_bytes: u64,
    /// `page_count * page_size`：SQLite 视角的逻辑大小（回收效果的准绳）
    pub page_bytes: u64,
    pub page_size: u64,
    pub page_count: u64,
    /// 空闲页数（`VACUUM` 能回收的量）
    pub freelist_pages: u64,
    /// auto_vacuum 模式：0=off 1=full 2=incremental
    pub auto_vacuum: i64,
    /// WAL checkpoint 后的封顶大小（-1 = 不限制）
    pub journal_size_limit: i64,
    pub session_count: u64,
    pub message_count: u64,
}

/// 一次 WAL checkpoint 的结果
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResult {
    /// 有其它连接占用 WAL 时 checkpoint 无法完成（此时 `-wal` 不会变小）
    pub busy: bool,
    pub before_bytes: u64,
    pub after_bytes: u64,
}

/// 「立即整理」的结果（before / after 供前端展示回收量）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintainResult {
    pub checkpoint: CheckpointResult,
    /// `VACUUM` 本身的耗时（不含前后的 checkpoint）
    pub vacuum_ms: u64,
    pub before: DbStats,
    pub after: DbStats,
}

/// 库占用的总字节（主库 + WAL + SHM）：UI 展示「共占用 / 回收量」用
pub fn total_bytes(stats: &DbStats) -> u64 {
    stats.db_bytes + stats.wal_bytes + stats.shm_bytes
}

/// 库维护句柄：与 `SqliteSessionRepo` **共享同一把连接锁**，因此维护与聊天写入互斥。
///
/// 单独成一个句柄（而不是加进 `SessionRepo` trait）的原因：维护是「运维动作」而非
/// 持久化语义，放进 trait 会迫使 `NoopSessionRepo` 也实现一遍无意义的空方法。
pub struct DbMaintenance {
    db_path: PathBuf,
    conn: Arc<Mutex<Connection>>,
}

impl DbMaintenance {
    pub fn new(db_path: PathBuf, conn: Arc<Mutex<Connection>>) -> Self {
        Self { db_path, conn }
    }

    /// 体积快照（纯读 + 两个 COUNT）
    pub fn stats(&self) -> Result<DbStats, String> {
        let conn = self.conn.lock().unwrap();
        stats_with(&conn, &self.db_path)
    }

    /// WAL 截断。
    ///
    /// async 版而非同步：`-wal` 上百 MB 时把页搬回主库要几秒，不能占着 runtime 线程。
    /// ⚠️ 可能等到连接锁（引擎正在写），退出路径请用 `try_checkpoint_truncate`。
    pub async fn checkpoint_truncate(&self) -> Result<CheckpointResult, String> {
        let conn = self.conn.clone();
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            checkpoint_on(&conn, &db_path, true)
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }

    /// 退出路径专用：**同步 + 不等待锁**（拿不到连接锁就跳过），保证绝不拖住退出流程。
    ///
    /// 返回 `None` 表示「这次没做」——引擎正在落库时跳过是正确行为，不是错误：
    /// 未 checkpoint 的写入仍在 WAL 里，下次启动照常恢复。
    pub fn try_checkpoint_truncate(&self) -> Option<CheckpointResult> {
        let conn = self.conn.try_lock().ok()?;
        checkpoint_on(&conn, &self.db_path, true).ok()
    }

    /// 立即整理：WAL 截断 → `VACUUM` 重建整库（回收空闲页 + 切 `auto_vacuum=INCREMENTAL`）
    /// → 再截断一次 WAL 并让主库文件真正缩小。
    pub async fn vacuum(&self) -> Result<MaintainResult, String> {
        let conn = self.conn.clone();
        let db_path = self.db_path.clone();
        tokio::task::spawn_blocking(move || -> Result<MaintainResult, String> {
            let conn = conn.lock().unwrap();
            let before = stats_with(&conn, &db_path)?;
            // 先把 WAL 里的页搬回主库：VACUUM 读的是主库文件
            let checkpoint = checkpoint_on(&conn, &db_path, true)?;
            let started = crate::telemetry::now_ms();
            // `auto_vacuum` 必须先设、再 VACUUM 才生效。切成 INCREMENTAL 后，以后删除会话
            // 留下的空闲页会被新数据复用（而不是把文件越撑越大）；代价是每 32768 页多一个
            // 指针映射页（几 KB），可忽略。
            conn.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; VACUUM;")
                .map_err(|e| {
                    format!(
                        "整理数据库失败（需要约 2 倍库大小的临时磁盘空间）: {}",
                        e
                    )
                })?;
            let vacuum_ms = (crate::telemetry::now_ms() - started).max(0) as u64;
            // VACUUM 自身把重建后的页写在 WAL 里 —— 再截断一次，`-wal` 才会归零、
            // 主库文件也才会真正缩小（实测：不补这一步，物理文件仍停在旧大小）。
            let _ = checkpoint_on(&conn, &db_path, true);
            let after = stats_with(&conn, &db_path)?;
            Ok(MaintainResult {
                checkpoint,
                vacuum_ms,
                before,
                after,
            })
        })
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
    }
}

// ==================== 内部实现 ====================

/// 读一个整数 pragma（读不到按 0 处理：`freelist_count` 等在不同 SQLite 版本上有差异，
/// 维护动作不该因为读不到统计值而失败）
fn pragma_i64(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {}", name), [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// `<db>-wal` / `<db>-shm` 这类同名前缀的伴随文件路径
fn sibling_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = db_path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn stats_with(conn: &Connection, db_path: &Path) -> Result<DbStats, String> {
    let page_size = pragma_i64(conn, "page_size").max(0) as u64;
    let page_count = pragma_i64(conn, "page_count").max(0) as u64;
    let count_rows = |sql: &str| -> u64 {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0)
            .max(0) as u64
    };
    Ok(DbStats {
        db_bytes: file_len(db_path),
        wal_bytes: file_len(&sibling_path(db_path, "-wal")),
        shm_bytes: file_len(&sibling_path(db_path, "-shm")),
        page_size,
        page_count,
        page_bytes: page_size.saturating_mul(page_count),
        freelist_pages: pragma_i64(conn, "freelist_count").max(0) as u64,
        auto_vacuum: pragma_i64(conn, "auto_vacuum"),
        journal_size_limit: pragma_i64(conn, "journal_size_limit"),
        session_count: count_rows("SELECT COUNT(*) FROM sessions"),
        message_count: count_rows("SELECT COUNT(*) FROM messages"),
    })
}

/// 执行一次 WAL checkpoint 并记录 `-wal` 前后大小
fn checkpoint_on(
    conn: &Connection,
    db_path: &Path,
    truncate: bool,
) -> Result<CheckpointResult, String> {
    let wal_path = sibling_path(db_path, "-wal");
    let before_bytes = file_len(&wal_path);
    let sql = if truncate {
        "PRAGMA wal_checkpoint(TRUNCATE)"
    } else {
        "PRAGMA wal_checkpoint(PASSIVE)"
    };
    let busy = {
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("WAL checkpoint 失败: {}", e))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| format!("WAL checkpoint 失败: {}", e))?;
        match rows
            .next()
            .map_err(|e| format!("WAL checkpoint 失败: {}", e))?
        {
            // 结果行形如 (busy, log, checkpointed)；成功重置后 log / checkpointed 都会回到 0，
            // 所以只有 busy 值得上报。
            Some(row) => row.get::<_, i64>(0).unwrap_or(0) != 0,
            // 非 WAL 库（`journal_mode` 不是 wal）该 pragma 不返回任何行
            None => false,
        }
    };
    Ok(CheckpointResult {
        busy,
        before_bytes,
        after_bytes: file_len(&wal_path),
    })
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::Message;
    use crate::session_db::repo::SessionRepo;
    use crate::session_db::tests::{open_tmp_with_path, test_message, test_session};
    use serde_json::json;

    /// 造一条 content 很大的消息：页级空闲页要够量才观察得到
    fn big_message(id: &str, kb: usize) -> Message {
        let mut m = test_message(id, "tool");
        m.content = json!("x".repeat(kb * 1024));
        m
    }

    #[tokio::test]
    async fn stats_report_sizes_counts_and_wal_limit() {
        let (repo, db) = open_tmp_with_path();
        let m = DbMaintenance::new(db, repo.conn.clone());
        repo.upsert_session(&test_session("s1", "标题", 1))
            .await
            .unwrap();
        repo.append_messages(
            "s1",
            &[test_message("m1", "user"), test_message("m2", "assistant")],
        )
        .await
        .unwrap();
        // WAL 模式下写入先落在 `-wal` 里，checkpoint 后主库文件才成型
        m.checkpoint_truncate().await.unwrap();

        let s = m.stats().unwrap();
        assert!(s.db_bytes > 0, "checkpoint 后主库应有内容");
        assert_eq!(s.wal_bytes, 0, "TRUNCATE 后 -wal 应被截为零");
        assert!(s.page_bytes > 0);
        assert_eq!(s.session_count, 1);
        assert_eq!(s.message_count, 2);
        assert_eq!(
            s.journal_size_limit, WAL_SIZE_LIMIT,
            "open() 应把 WAL 封顶设为 16 MB（否则 -wal 会保持历史高水位）"
        );
    }

    /// `VACUUM` 需要 SQLite 的临时目录可写（沙盒里 `%TEMP%` 不可写会报
    /// `unable to open database file`）——本机跑 `cargo test` 时需把 `TEMP` 指到工作区。
    #[tokio::test]
    async fn vacuum_reclaims_freelist_and_zeroes_wal() {
        let (repo, db) = open_tmp_with_path();
        let m = DbMaintenance::new(db, repo.conn.clone());
        repo.upsert_session(&test_session("s1", "标题", 1))
            .await
            .unwrap();
        let msgs: Vec<Message> = (0..300)
            .map(|i| big_message(&format!("m{}", i), 4))
            .collect();
        repo.append_messages("s1", &msgs).await.unwrap();

        repo.delete_session("s1").await.unwrap();
        let dirty = m.stats().unwrap();
        assert_eq!(dirty.message_count, 0);
        assert!(
            dirty.freelist_pages > 0,
            "删除后应留下空闲页（否则本用例失去意义）"
        );

        let r = m.vacuum().await.unwrap();
        assert_eq!(r.after.freelist_pages, 0, "VACUUM 后不应再有空闲页");
        assert_eq!(
            r.after.auto_vacuum, 2,
            "VACUUM 后 auto_vacuum 应为 INCREMENTAL(2)"
        );
        assert!(
            r.after.page_bytes < dirty.page_bytes,
            "整理后逻辑大小应下降: {:?} -> {:?}",
            dirty.page_bytes,
            r.after.page_bytes
        );
        assert!(
            r.after.db_bytes <= dirty.db_bytes,
            "整理后主库物理文件不应变大"
        );
        assert_eq!(r.after.wal_bytes, 0, "整理末尾应把 -wal 截为零");
        assert!(!r.checkpoint.busy);
    }

    /// 退出路径的硬约束：**拿不到连接锁必须立刻跳过**（绝不能等，否则退出会被拖住）
    #[tokio::test]
    async fn try_checkpoint_skips_when_connection_is_busy() {
        let (repo, db) = open_tmp_with_path();
        let m = DbMaintenance::new(db, repo.conn.clone());

        let guard = repo.conn.lock().unwrap(); // 模拟「引擎正在落库」
        assert!(
            m.try_checkpoint_truncate().is_none(),
            "连接被占用时退出路径必须跳过而不是等待"
        );
        drop(guard);

        let r = m.try_checkpoint_truncate().expect("锁空闲时应完成截断");
        assert!(!r.busy);
    }
}
