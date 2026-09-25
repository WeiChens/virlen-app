//! 打开会话库（`open_session_db`）—— **零 `tauri::` 依赖**
//!
//! 库路径完全由 `host.data_dir()` 决定：只要 GUI 与 CLI 的 `HostEnv::data_dir()`
//! 指向同一目录，读写的就是同一份 `virlen.db`（同一份会话 + 同一份配置）——
//! 这正是配置下沉 D3 的落点：CLI 侧只需
//! `open_session_db(&CliHost::from_env(), &|fut| { tokio::spawn(fut); })`
//! 即接管同一份配置，不必等前端下发。
//!
//! ⚠️ Tauri 侧的三件事已移到 `virlen-app` 的 `src/commands/session_db.rs`
//! （core 不得出现 `tauri::`）：
//! 1. `init_session_db(app)` —— 构造 `TauriHost` 并注册 Tauri 状态；
//! 2. `manage_noop_settings(app)` —— 库打不开时的 Noop 兜底；
//! 3. 全部 `cmd_*` 命令。
//!
//! 后台任务派发函数做成参数而不是写死 `tokio::spawn`：GUI 的 `.setup()` 回调里
//! **没有 tokio reactor 上下文**（只能用 `tauri::async_runtime::spawn`），而 CLI
//! （`#[tokio::main]`）用 `tokio::spawn` —— 本文件不能假设调用方处于哪种运行时。

use crate::agent::host::HostEnv;
use crate::session_db::maintenance::DbMaintenance;
use crate::session_db::repo::SessionRepo;
use crate::session_db::sqlite::SqliteSessionRepo;
use crate::session_db::{SettingsRepo, SqliteSettingsRepo};
use std::sync::Arc;

/// 后台任务派发函数 —— 由宿主提供，见 [`open_session_db`]。
type BoxFut = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>>;
pub type Spawner<'a> = &'a dyn Fn(BoxFut);

/// 一个已打开的会话库：会话 repo + 配置 repo + 维护句柄（**同一个 `virlen.db`**）
pub struct SessionDb {
    pub repo: Arc<dyn SessionRepo>,
    /// 应用设置（配置下沉 D3）——与会话**共用同一把连接锁**
    pub settings: Arc<dyn SettingsRepo>,
    /// 库维护句柄（设置 → 存储「立即整理」）
    pub maintenance: Arc<DbMaintenance>,
}

/// 打开会话库（**零 `tauri::` 依赖**）——库路径完全由 `host.data_dir()` 决定。
///
/// 后台任务（历史迁移 / 孤儿消息回收）经 `spawn` 派发，不由本函数假设运行时。
pub fn open_session_db(host: &dyn HostEnv, spawn: Spawner<'_>) -> Result<SessionDb, String> {
    let db_path = host.data_dir().join("virlen.db");
    let sqlite = Arc::new(SqliteSessionRepo::open(&db_path)?);
    let repo: Arc<dyn SessionRepo> = sqlite.clone();
    // 应用设置（配置下沉 D3）：**复用同一把连接**（不引入第二个写连接 → 不会 SQLITE_BUSY），
    // 因此设置写入与会话写入天然互斥；GUI 与 CLI 指向同一个 `virlen.db` 即共用同一份配置。
    let settings: Arc<dyn SettingsRepo> = Arc::new(SqliteSettingsRepo::new(sqlite.conn.clone()));
    // 库维护句柄（设置 → 存储「立即整理」）：与 repo **共用同一把连接锁**，
    // 因此维护动作与聊天写入天然互斥；退出路径也用它做一次廉价的 WAL 截断。
    let maintenance = Arc::new(DbMaintenance::new(db_path, sqlite.conn.clone()));

    // 历史数据迁移（回填 text_plain + 重建 FTS 索引）放后台执行，避免超大库首次启动卡顿。
    // 迁移完成前，检索自动回退到旧的 LIKE content 路径，结果依然正确。
    if !sqlite.migration_done() {
        let r = sqlite.clone();
        spawn(Box::pin(async move {
            if let Err(e) = r.migrate().await {
                eprintln!("[session_db] 后台迁移失败（检索将暂时回退旧路径）: {}", e);
            }
        }));
    }
    // 兜底回收孤儿消息（`session_id` 指向不存在会话的行）：早期版本删除会话时若有 run
    // 在跑，会经由 append_messages 写入孤儿消息 —— 它们查不到也清不掉，只会让库文件
    // 只增不减。幂等；无孤儿时开销仅一次反连接扫描，故放后台、与迁移互不阻塞
    // （两者共用同一把连接锁，谁先谁后结果一致）。
    {
        let r_purge = sqlite.clone();
        spawn(Box::pin(async move {
            match r_purge.purge_orphan_messages().await {
                Ok(0) => {}
                Ok(n) => eprintln!("[session_db] 已清理 {} 条孤儿消息", n),
                Err(e) => eprintln!("[session_db] 孤儿消息清理失败: {}", e),
            }
        }));
    }

    Ok(SessionDb {
        repo,
        settings,
        maintenance,
    })
}
