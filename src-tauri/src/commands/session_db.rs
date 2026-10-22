//! session_db 的 Tauri 命令层（GUI 壳）。实现全在 virlen-core::session_db，本文件只做
//! 打开库 / 注册状态、Noop 兜底、以及全部 cmd_*（参数兜底 + 调 repo + 埋点）。

use std::sync::Arc;

use virlen_core::agent::types::{Message, Session};
use virlen_core::session_db::{
    get_message_page_filled, open_session_db, total_bytes, CheckpointResult, DbMaintenance, DbStats,
    MaintainResult, MemoryRepo, MessagePage, MessageSearchPage, MessageTimelinePage, MessageWindow,
    NoopMemoryRepo, NoopSettingsRepo, SearchCursor, SessionRepo, SettingsRepo, TailRepair,
    UsageEntry, UsageQuery, UsageRecordPage, UsageStats, UserMessageRef, MSG_QUERY_MAX_LIMIT,
};

/// GUI 入口（薄壳）：构造 Tauri 宿主 → 打开会话库 → 注册 Tauri 状态。
/// CLI 走 open_session_db + CliHost，故本文件只有这里与 `manage_noop_settings` 允许出现 tauri::。
pub fn init_session_db(app: &tauri::AppHandle) -> Result<Arc<dyn SessionRepo>, String> {
    use tauri::Manager;
    let db = open_session_db(
        &crate::host::TauriHost::new(app.clone()),
        // `.setup()` 回调没有 tokio reactor 上下文，必须用 Tauri 自己的运行时派发
        &|fut| {
            tauri::async_runtime::spawn(fut);
        },
    )?;
    app.manage(db.settings.clone());
    app.manage(db.memory.clone());
    app.manage(db.maintenance.clone());
    Ok(db.repo.clone())
}

/// GUI 兜底：库打不开时把配置 / 记忆仓储换成 Noop。
/// 换成 Noop 后命令正常返回，并由 cmd_settings_get_all 如实报「本地存储不可用」——
/// 假装的空表会让前端误判为「首启 → 该导入」。
pub fn manage_noop_settings(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.manage(Arc::new(NoopSettingsRepo) as Arc<dyn SettingsRepo>);
    app.manage(Arc::new(NoopMemoryRepo) as Arc<dyn MemoryRepo>);
}

// ==================== Tauri 命令 ====================

/// 记录一次 SQLite 操作（rust.db.op / rust.db.error）
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

/// 收口上一轮的崩溃残留（未定稿回复 / 悬空工具调用），返回本次改动的条数。
///
/// 调用时机：**打开会话、读消息之前**（`sessionStore.ensureMessagesLoaded`）——
/// 与引擎每次发送前的那次修复共用同一份实现（`SessionRepo::repair_tail`），
/// 幂等且正常会话零写入。没有这一步，重开 App 时半截回复既不会被定稿、
/// 也不会打上「已中断」，直到用户再发一条消息才会被修复。
#[tauri::command]
pub async fn cmd_repair_session_tail(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
) -> Result<TailRepair, String> {
    let started = crate::telemetry::now_ms();
    let result = state.repair_tail(&session_id).await;
    track_db(
        "repair_session_tail",
        Some(&session_id),
        started,
        result
            .as_ref()
            .ok()
            .map(|r| r.finalized + r.dropped + r.tool_results),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 分页获取会话消息（尾部窗口：只取最近 N 条，向上滚动按 before_rowid 回补）。
/// min_visible > 0 时按「可见行数」补足：一次 IPC 就取够 UI 高度，避免工具调用折成一行后反复上滑。
#[tauri::command]
pub async fn cmd_get_message_page(
    state: tauri::State<'_, Arc<dyn SessionRepo>>,
    session_id: String,
    limit: Option<usize>,
    before_rowid: Option<i64>,
    min_visible: Option<usize>,
    fold: Option<bool>,
) -> Result<MessagePage, String> {
    let started = crate::telemetry::now_ms();
    let limit = limit.unwrap_or(60).clamp(1, 1000);
    let min_visible = min_visible.unwrap_or(0);
    let fold = fold.unwrap_or(true);
    let result = if min_visible == 0 {
        state.get_message_page(&session_id, limit, before_rowid).await
    } else {
        get_message_page_filled(&**state, &session_id, limit, before_rowid, min_visible, fold).await
    };
    track_db(
        "get_messages_page",
        Some(&session_id),
        started,
        result.as_ref().ok().map(|p| p.messages.len()),
        result.as_ref().err().map(|s| s.as_str()),
    );
    result
}

/// 按锚点取时序窗口（只覆盖已压缩区间）
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

/// 列出已压缩区间的消息时序（可关键词过滤 / 向前翻页）
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

/// 会话内全部用户消息的轻量索引（右侧锚点列表用）
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
    if result.is_ok() {
        // 会话没了 → 它的后台服务也不该继续跑；删除失败则不动（会话还在，服务就该还在）
        let stopped = virlen_core::agent::native_tools::kill_session_services(&session_id);
        if stopped > 0 {
            crate::telemetry::track(
                "tool.service.session_cleanup",
                serde_json::json!({ "count": stopped }),
            );
        }
    }
    result
}

/// 整批替换会话全部消息（压缩等全量替换场景）；不刷新会话时间（压缩不是用户发言）
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

/// 追加消息（前端落库用；Rust 引擎内部直落不经 IPC）。不刷新会话时间（时间由会话元数据那一次 upsert 定）。
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

/// 删除「指定消息及其之后」的全部消息；不刷新会话时间
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

/// 替换「指定消息及其之后」的后缀（只加载了尾部窗口时回写修复结果用）。
/// 与全量替换的区别：只动后缀，更早的历史若尚未加载则原样保留。不刷新会话时间。
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

// ==================== 用量账本命令 ====================

/// 追加用量流水（前端非消息型调用走此命令；Rust 引擎内部直落）
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

/// 聚合用量统计（按时间 / 模型 / 会话 / 调用类型分桶）。
/// 只返回 token 数，不返回费用：单价是用户可编辑项，算在 SQL 里改一次就要回填整张表。
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

// ==================== 应用设置 ====================
// 键名与前端 SettingsStore 字段同名同层。

/// 读取全部应用设置。
/// ⚠️ 无真实后端时如实报错（不返回空表）：返回空表会让前端误判为「首启 → 该导入」。
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

/// 首启迁移：仅当表为空时才导入；返回是否真的写入
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

// ==================== 库维护命令 ====================

/// 数据库体积快照。走 spawn_blocking：与引擎写入共用连接锁，不能卡住 runtime 线程。
#[tauri::command]
pub async fn cmd_db_stats(m: tauri::State<'_, Arc<DbMaintenance>>) -> Result<DbStats, String> {
    let m = m.inner().clone();
    tokio::task::spawn_blocking(move || m.stats())
        .await
        .map_err(|e| format!("DB task join error: {}", e))?
}

/// 只截断 WAL（wal_checkpoint(TRUNCATE)）—— 廉价的「第一步整理」，不动主库结构，不需用户确认。
#[tauri::command]
pub async fn cmd_db_checkpoint(
    m: tauri::State<'_, Arc<DbMaintenance>>,
) -> Result<CheckpointResult, String> {
    let m = m.inner().clone();
    m.checkpoint_truncate().await
}

/// 清理“无引用的图片附件”（P0-1 的回收侧）。
///
/// 只扫本地附件目录，不碰数据库行；刚写入（[`GC_GRACE`]）的文件会跳过，避免误删正在发送的图。
#[tauri::command]
pub async fn cmd_attachments_gc(
    m: tauri::State<'_, Arc<DbMaintenance>>,
) -> Result<virlen_core::session_db::AttachmentsGcResult, String> {
    let m = m.inner().clone();
    let started = crate::telemetry::now_ms();
    let result = m.gc_attachments(GC_GRACE).await;
    crate::telemetry::track(
        "rust.db.attachments_gc",
        serde_json::json!({
            "duration_ms": crate::telemetry::now_ms() - started,
            "status": if result.is_err() { "fail" } else { "success" },
            "removed": result.as_ref().map(|r| r.removed).unwrap_or(0),
            "removed_parts": result.as_ref().map(|r| r.removed_parts).unwrap_or(0),
            "freed_bytes": result.as_ref().map(|r| r.freed_bytes).unwrap_or(0),
        }),
    );
    result
}

/// 附件回收的安全阀：写入不足该时长的文件即使没被引用也不删。
///
/// 引擎是「先把图写到附件目录、再把消息落库」，中间存在一个合法的时间窗口；
/// 30 分钟远超这个窗口，又不会让垃圾文件长期堆积。
const GC_GRACE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// 立即整理：先 wal_checkpoint(TRUNCATE) 回收 -wal，再 VACUUM 归还空闲页。
/// ⚠️ 只在用户显式点击时调用：VACUUM 期间独占连接（数百 MB 库约 10–60 s），且需约 2 倍库大小的临时盘。
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
