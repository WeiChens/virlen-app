//! `session_db` 的 **Tauri 命令层**（GUI 壳）
//!
//! 库的打开、会话与配置的读写实现全在 `virlen-core::session_db`（零 `tauri::`）。本文件只有三件事：
//! 1. `init_session_db`：构造 `TauriHost` → 打开库 → 注册 Tauri 状态；
//! 2. `manage_noop_settings`：库打不开时的 Noop 兜底（否则设置命令会因「状态未注册」失败）；
//! 3. 全部 `cmd_*`：只做「参数兜底 + 调用 repo + 埋点」，业务语义都在 `SessionRepo` 实现里。
//!
//! ```text
//! GUI：TauriHost::data_dir() ─┐
//! CLI：CliHost::data_dir()    ├─→ virlen_core::session_db::open_session_db
//! ```
//!
//! 两条路径的 `data_dir()` 指向同一目录 → 读写同一份 `virlen.db`（配置下沉 D3 的落点）。

use std::sync::Arc;

use virlen_core::agent::types::{Message, Session};
use virlen_core::session_db::{
    open_session_db, 
    total_bytes, CheckpointResult, DbMaintenance, DbStats, MaintainResult, MessagePage,
    MessageSearchPage, MessageTimelinePage, MessageWindow, NoopSettingsRepo, SearchCursor,
    SessionRepo, SettingsRepo, UsageEntry, UsageQuery, UsageRecordPage, UsageStats, UserMessageRef,
    MSG_QUERY_MAX_LIMIT,
};

/// **GUI 入口**（薄壳）：构造 Tauri 宿主 → 打开会话库 → 注册 Tauri 状态。
///
/// headless / CLI 走 [`open_session_db`] + `CliHost`，因此本文件里只有这里（以及
/// 下面的 [`manage_noop_settings`]）允许出现 `tauri::`。
pub fn init_session_db(app: &tauri::AppHandle) -> Result<Arc<dyn SessionRepo>, String> {
    use tauri::Manager;
    let db = open_session_db(
        &crate::host::TauriHost::new(app.clone()),
        // `.setup()` 回调没有 tokio reactor 上下文 → 必须用 Tauri 自己的运行时派发
        &|fut| {
            tauri::async_runtime::spawn(fut);
        },
    )?;
    app.manage(db.settings.clone());
    app.manage(db.maintenance.clone());
    Ok(db.repo.clone())
}

/// **GUI 兜底**：库打不开时把配置仓储换成 [`NoopSettingsRepo`]。
///
/// 不换的话 `cmd_settings_*` 会因「状态未注册」报错；换成 Noop 后命令正常返回，
/// 并由 `cmd_settings_get_all` 如实报「本地存储不可用」（而不是假装表是空的 ——
/// 那会让前端误判为「空表 → 该导入」）。
pub fn manage_noop_settings(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.manage(Arc::new(NoopSettingsRepo) as Arc<dyn SettingsRepo>);
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

/// 替换会话「指定消息及其之后」的后缀（前端在只加载了尾部窗口时回写修复结果用）
///
/// 与 `cmd_replace_session_messages`（全量替换）的区别：只动后缀，前缀（更早、可能尚未加载的历史）原样保留。
/// ⚠️ 不刷新会话时间（修复不是用户发言）
#[tauri::command]
pub async fn cmd_replace_session_messages_from(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    from_message_id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = messages.len();
    let result = state
        .replace_messages_from(&session_id, &from_message_id, &messages)
        .await;
    track_db(
        "replace_from",
        Some(&session_id),
        started,
        Some(rows),
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

// ==================== 应用设置（配置下沉 D3） ====================
//
// 命令只做「参数兜底 + 调 repo + 埋点」，与上面的会话命令同风格。
// 键名与前端 `SettingsStore` 字段同名同层（见 `settings.rs` 文件头）。

/// 读取全部应用设置（GUI 启动水合 / CLI 读配置）
///
/// ⚠️ 无真实后端时**如实报错**（而不是返回空表）：前端 `hydrateSettings` 会捕获并
/// 继续用 localStorage 的值；若返回空表，前端会误判为「首启 → 该把 localStorage 导入」
/// 而反复调用 `cmd_settings_import`。
#[tauri::command]
pub async fn cmd_settings_get_all(
    state: tauri::State<'_, Arc<dyn SettingsRepo>>,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !state.is_available() {
        return Err("本地存储不可用（配置仓储未初始化）".to_string());
    }
    let started = crate::telemetry::now_ms();
    let result = state.get_all().await;
    track_db(
        "settings_get",
        None,
        started,
        result.as_ref().ok().map(|m| m.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 写入 / 覆写若干应用设置（只动传入的键）
#[tauri::command]
pub async fn cmd_settings_upsert(
    state: tauri::State<'_, Arc<dyn SettingsRepo>>,
    entries: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let started = crate::telemetry::now_ms();
    let rows = entries.len();
    let result = state.upsert(entries).await;
    track_db(
        "settings_upsert",
        None,
        started,
        Some(rows),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 首启迁移：**仅当表为空**时导入（从 localStorage 带来的旧设置）；返回是否真的写入
#[tauri::command]
pub async fn cmd_settings_import(
    state: tauri::State<'_, Arc<dyn SettingsRepo>>,
    entries: serde_json::Map<String, serde_json::Value>,
) -> Result<bool, String> {
    let started = crate::telemetry::now_ms();
    let rows = entries.len();
    let result = state.import_if_empty(entries).await;
    track_db(
        "settings_import",
        None,
        started,
        result.as_ref().ok().map(|_| rows),
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
