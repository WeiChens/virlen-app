//! `init_session_db` 与全部 Tauri 命令
//!
//! 命令只做「参数兜底 + 调用 repo + 埋点」，业务语义都在 `SessionRepo` 实现里。

use crate::agent::types::{Message, Session};
use crate::session_db::maintenance::{
    total_bytes, CheckpointResult, DbMaintenance, DbStats, MaintainResult,
};
use crate::session_db::repo::SessionRepo;
use crate::session_db::sqlite::SqliteSessionRepo;
use crate::session_db::types::{
    MessagePage, MessageSearchPage, MessageTimelinePage, MessageWindow, SearchCursor,
    UserMessageRef, MSG_QUERY_MAX_LIMIT,
};
use crate::session_db::usage::{UsageEntry, UsageQuery, UsageRecordPage, UsageStats};
use std::sync::Arc;

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
    let repo = Arc::new(SqliteSessionRepo::open(&db_path)?);
    // 库维护句柄（设置 → 存储「立即整理」）：与 repo **共用同一把连接锁**，
    // 因此维护动作与聊天写入天然互斥；退出路径也用它做一次廉价的 WAL 截断。
    app.manage(Arc::new(DbMaintenance::new(db_path.clone(), repo.conn.clone())));
    // 历史数据迁移（回填 text_plain + 重建 FTS 索引）放后台执行，避免超大库首次启动卡顿。
    // 迁移完成前，检索自动回退到旧的 LIKE content 路径，结果依然正确。
    if !repo.migration_done() {
        let r = repo.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = r.migrate().await {
                eprintln!("[session_db] 后台迁移失败（检索将暂时回退旧路径）: {}", e);
            }
        });
    }
    // 兜底回收孤儿消息（`session_id` 指向不存在会话的行）：早期版本删除会话时若有 run
    // 在跑，会经由 append_messages 写入孤儿消息 —— 它们查不到也清不掉，只会让库文件
    // 只增不减。幂等；无孤儿时开销仅一次反连接扫描，故放后台、与迁移互不阻塞
    // （两者共用同一把连接锁，谁先谁后结果一致）。
    {
        let r_purge = repo.clone();
        tauri::async_runtime::spawn(async move {
            match r_purge.purge_orphan_messages().await {
                Ok(0) => {}
                Ok(n) => eprintln!("[session_db] 已清理 {} 条孤儿消息", n),
                Err(e) => eprintln!("[session_db] 孤儿消息清理失败: {}", e),
            }
        });
    }
    Ok(repo)
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

/// 消息查询工具：按锚点（id / seq）取时序窗口（只覆盖「已压缩区间」）
#[tauri::command]
pub async fn cmd_get_message_window(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    anchor_id: Option<String>,
    anchor_seq: Option<i64>,
    before: Option<usize>,
    after: Option<usize>,
) -> Result<MessageWindow, String> {
    let started = crate::telemetry::now_ms();
    let before = before.unwrap_or(5);
    let after = after.unwrap_or(5);
    let result = state
        .get_message_window(&session_id, anchor_id.as_deref(), anchor_seq, before, after)
        .await;
    track_db(
        "get_message_window",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|w| w.messages.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 消息查询工具：列出「已压缩区间」的消息时序（可按关键词过滤 / 向前翻页）
#[tauri::command]
pub async fn cmd_get_message_timeline(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    keyword: Option<String>,
    before_seq: Option<i64>,
    limit: Option<usize>,
) -> Result<MessageTimelinePage, String> {
    let started = crate::telemetry::now_ms();
    let limit = limit.unwrap_or(30).clamp(1, MSG_QUERY_MAX_LIMIT);
    let result = state
        .get_message_timeline(&session_id, keyword.as_deref(), before_seq, limit)
        .await;
    track_db(
        "get_message_timeline",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|p| p.items.len()),
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

/// 检索消息（会话内 / 跨会话，分页）
#[tauri::command]
pub async fn cmd_search_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    query: String,
    session_id: Option<String>,
    role: Option<String>,
    limit: Option<usize>,
    cursor: Option<SearchCursor>,
) -> Result<MessageSearchPage, String> {
    let started = crate::telemetry::now_ms();
    let limit = limit.unwrap_or(40).clamp(1, 200);
    let result = state
        .search_messages(&query, session_id.as_deref(), role.as_deref(), limit, cursor)
        .await;
    track_db(
        "search_messages",
        session_id.as_deref(),
        started,
        result.as_ref().ok().map(|p| p.items.len()),
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
/// ⚠️ 不刷新会话时间（压缩不是用户发言）
#[tauri::command]
pub async fn cmd_replace_session_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = messages.len();
    let result = state.replace_messages(&session_id, &messages).await;
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
/// ⚠️ 不刷新会话时间（AI 回复 / 工具结果 / 用户消息都由会话元数据的那次 upsert 定时间）
#[tauri::command]
pub async fn cmd_append_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = messages.len();
    let result = state.append_messages(&session_id, &messages).await;
    track_db(
        "append",
        Some(&session_id),
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 删除会话中「指定消息及其之后」的全部消息（前端删除消息时同步落库）
/// ⚠️ 不刷新会话时间（删除消息不是用户发言）
#[tauri::command]
pub async fn cmd_truncate_session_messages(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let result = state.truncate_messages_from(&session_id, &message_id).await;
    track_db(
        "truncate",
        Some(&session_id),
        started,
        None,
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

// ==================== 用量账本命令（token 统计） ====================

/// 追加用量流水（TS 引擎 / 前端非消息型调用走此命令；Rust 引擎内部直落不经 IPC）
#[tauri::command]
pub async fn cmd_append_usage(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    entries: Vec<UsageEntry>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = entries.len();
    let result = state.append_usage(&entries).await;
    track_db(
        "usage_append",
        None,
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 聚合用量统计（按时间 / 模型 / 会话 / 调用类型分桶 + 合计）
///
/// 只返回 token 数，**不返回费用**：单价是用户可编辑的设置项，
/// 算在 SQL 里会导致「改一次单价就要回填整张表」，因此费用一律由前端计算。
#[tauri::command]
pub async fn cmd_usage_stats(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    query: Option<UsageQuery>,
) -> Result<UsageStats, String> {
    let started = crate::telemetry::now_ms();
    let query = query.unwrap_or_default();
    let result = state.usage_stats(&query).await;
    track_db(
        "usage_stats",
        query.session_id.as_deref(),
        started,
        result.as_ref().ok().map(|s| s.buckets.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 用量明细（时间倒序，分页；表格视图与 CSV 导出用）
#[tauri::command]
pub async fn cmd_usage_query(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    query: Option<UsageQuery>,
) -> Result<UsageRecordPage, String> {
    let started = crate::telemetry::now_ms();
    let query = query.unwrap_or_default();
    let result = state.usage_records(&query).await;
    track_db(
        "usage_query",
        query.session_id.as_deref(),
        started,
        result.as_ref().ok().map(|p| p.records.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 清空用量账本（返回删除条数）
#[tauri::command]
pub async fn cmd_usage_clear(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
) -> Result<i64, String> {
    let started = crate::telemetry::now_ms();
    let result = state.clear_usage().await;
    track_db(
        "usage_clear",
        None,
        started,
        result.as_ref().ok().map(|n| *n as usize),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

// ==================== 库维护命令（设置 → 存储） ====================

/// 数据库体积快照（纯读，设置 → 存储 展示用）
///
/// 走 spawn_blocking：与引擎写入共用一把连接锁，锁被占用时不能卡住 runtime 线程。
#[tauri::command]
pub async fn cmd_db_stats(m: tauri::State<'_, Arc<DbMaintenance>>) -> Result<DbStats, String> {
    let m = m.inner().clone();
    tokio::task::spawn_blocking(move || m.stats())
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
}

/// 只截断 WAL 日志（`wal_checkpoint(TRUNCATE)`）—— 廉价的「第一步整理」
///
/// 只把 `-wal` 里已提交的页搬回主库并截断文件（毫秒~秒级），不动主库结构，
/// 因此不需要用户确认；重建主库（`VACUUM`）另见 `cmd_db_maintain`。
#[tauri::command]
pub async fn cmd_db_checkpoint(
    m: tauri::State<'_, Arc<DbMaintenance>>,
) -> Result<CheckpointResult, String> {
    let m = m.inner().clone();
    m.checkpoint_truncate().await
}

/// 立即整理数据库：`wal_checkpoint(TRUNCATE)` 回收 `-wal`，再 `VACUUM` 归还空闲页
///
/// ⚠️ **只在用户显式点击时调用**：`VACUUM` 期间独占连接（数百 MB 库约 10–60 s），
/// 且需要约 2 倍库大小的临时磁盘空间（SQLite 放在系统临时目录）。
#[tauri::command]
pub async fn cmd_db_maintain(
    m: tauri::State<'_, Arc<DbMaintenance>>,
) -> Result<MaintainResult, String> {
    let m = m.inner().clone();
    let started = crate::telemetry::now_ms();
    let result = m.vacuum().await;
    let (before, after) = match result.as_ref() {
        Ok(r) => (total_bytes(&r.before), total_bytes(&r.after)),
        Err(_) => (0, 0),
    };
    crate::telemetry::track(
        "rust.db.maintain",
        serde_json::json!({
            "duration_ms": crate::telemetry::now_ms() - started,
            "status": if result.is_err() { "fail" } else { "success" },
            "before_bytes": before,
            "after_bytes": after,
            "reclaimed_bytes": before.saturating_sub(after),
        }),
    );
    result
}
