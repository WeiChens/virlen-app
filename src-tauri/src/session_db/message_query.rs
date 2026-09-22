//! 消息查询工具（query messages）与消息检索的查询辅助
//!
//! - 窗口 / 时序查询与检索的 SQL 都在这里，`sqlite::SqliteSessionRepo` 只做转发；
//! - 「已压缩区间」语义见 `boundary_seq`（与 Provider 的切片语义严格一致）。

use crate::session_db::row::{content_plain_text, row_err, truncate_chars};
use crate::session_db::types::{
    MessageBrief, MessageSearchItem, MessageSearchPage, MessageTimelineItem, MessageTimelinePage,
    MessageWindow, SearchCursor, ToolCallBrief, MSG_QUERY_MAX_BACK, MSG_QUERY_MAX_FWD,
    MSG_QUERY_MAX_LIMIT, MSG_QUERY_MAX_SPAN, MSG_QUERY_PREVIEW_MAX_CHARS,
    MSG_QUERY_TEXT_MAX_CHARS, MSG_QUERY_TOOL_DETAIL_MAX_CHARS,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::sync::{Arc, Mutex};

// ==================== 消息查询辅助 ====================

/// 按字符截断，返回 (文本, 是否被截断)
fn truncate_with_flag(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    let head: String = text.chars().take(max).collect();
    (format!("{}…", head), true)
}

/// content 是否含图片 / 文件 / 引用 / 技能块（仅用于提示「有附件」，不展开内容）
fn content_has_attachments(content: &serde_json::Value) -> bool {
    match content {
        serde_json::Value::Array(blocks) => blocks.iter().any(|b| {
            matches!(
                b.get("type").and_then(|v| v.as_str()),
                Some("image_url") | Some("file") | Some("quote") | Some("skill")
            )
        }),
        _ => false,
    }
}

/// 把 (before, after) 收敛到工具上限内（按比例缩放，保证锚点前后都保留）
fn clamp_window(before: usize, after: usize) -> (usize, usize) {
    let b = before.min(MSG_QUERY_MAX_BACK);
    let a = after.min(MSG_QUERY_MAX_FWD);
    if b + a <= MSG_QUERY_MAX_SPAN {
        return (b, a);
    }
    let total = b + a;
    let nb = (b * MSG_QUERY_MAX_SPAN) / total;
    (nb, MSG_QUERY_MAX_SPAN - nb)
}

/// 会话消息总数
fn session_message_count(conn: &Connection, session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id=?1",
        params![session_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("统计会话消息数失败: {}", e))
}

/// 某个 rowid 对应的 1 基时序
fn seq_of_rowid(conn: &Connection, session_id: &str, rowid: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_id=?1 AND rowid <= ?2",
        params![session_id, rowid],
        |row| row.get(0),
    )
    .map_err(|e| format!("计算消息时序失败: {}", e))
}

/// 「已压缩区间」上界 = 最后一个 summary 消息的 1 基时序；无 summary 时返回 None。
///
/// 与 Provider 的切片语义严格一致（`provider.rs::last_summary_index` / TS
/// `getLastSummaryMessageIndex`）：最后一个 summary 及其之后的消息都已进入模型
/// 当前上下文，因此**不可查询**。
fn boundary_seq(conn: &Connection, session_id: &str) -> Result<Option<i64>, String> {
    let rowid: Option<i64> = conn
        .query_row(
            "SELECT rowid FROM messages WHERE session_id=?1 AND role='summary' \
             ORDER BY rowid DESC LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查询压缩边界失败: {}", e))?;
    match rowid {
        None => Ok(None),
        Some(rid) => seq_of_rowid(conn, session_id, rid).map(Some),
    }
}

/// 从查询行构造 `MessageBrief`（正文 / 工具详情按上限截断；剔除深度思考）
fn message_brief_from_row(row: &Row) -> Result<MessageBrief, String> {
    let role: String = row.get("role").map_err(|e| e.to_string())?;
    let content_json: String = row.get("content").map_err(|e| e.to_string())?;
    let content: serde_json::Value =
        serde_json::from_str(&content_json).unwrap_or(serde_json::Value::Null);

    let raw_text = content_plain_text(&content);
    // tool 消息的正文就是「工具结果详情」——与工具调用参数同口径截断；
    // 其它角色（user / assistant）保留较长正文（仍设上限，防止单条撑爆上下文）
    let text_limit = if role == "tool" {
        MSG_QUERY_TOOL_DETAIL_MAX_CHARS
    } else {
        MSG_QUERY_TEXT_MAX_CHARS
    };
    let (text, text_truncated) = truncate_with_flag(&raw_text, text_limit);

    let mut tool_calls: Vec<ToolCallBrief> = Vec::new();
    if let Some(json) = row
        .get::<_, Option<String>>("tool_calls")
        .map_err(|e| e.to_string())?
    {
        if let Ok(list) = serde_json::from_str::<Vec<crate::agent::types::ToolUseContent>>(&json) {
            for tc in list {
                let raw = serde_json::to_string(&tc.input).unwrap_or_default();
                let (input_brief, input_truncated) =
                    truncate_with_flag(&raw, MSG_QUERY_TOOL_DETAIL_MAX_CHARS);
                tool_calls.push(ToolCallBrief {
                    name: tc.name,
                    input_brief,
                    input_truncated,
                });
            }
        }
    }

    Ok(MessageBrief {
        seq: row.get("idx").map_err(|e| e.to_string())?,
        id: row.get("id").map_err(|e| e.to_string())?,
        role,
        timestamp: row.get("timestamp").map_err(|e| e.to_string())?,
        text,
        text_truncated,
        has_attachments: content_has_attachments(&content),
        tool_calls,
        tool_call_id: row.get("tool_call_id").map_err(|e| e.to_string())?,
        is_error: row
            .get::<_, Option<i64>>("is_error")
            .map_err(|e| e.to_string())?
            .map(|v| v != 0),
        has_reasoning: row
            .get::<_, i64>("has_reasoning")
            .map_err(|e| e.to_string())?
            != 0,
    })
}

/// 取 [start_seq, end_seq]（含端点，1 基时序）的消息骨架（时序升序）
///
/// ⚠️ 不 select `reasoning_content`：深度思考量最大且绝不允许下发给模型。
fn fetch_message_briefs(
    conn: &Connection,
    session_id: &str,
    start_seq: i64,
    end_seq: i64,
) -> Result<Vec<MessageBrief>, String> {
    let mut stmt = conn
        .prepare(
            "WITH ordered AS ( \
               SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY rowid) AS idx \
               FROM messages WHERE session_id = ?1 \
             ) \
             SELECT m.id AS id, m.role AS role, m.content AS content, \
                    m.tool_calls AS tool_calls, m.tool_call_id AS tool_call_id, \
                    m.is_error AS is_error, m.timestamp AS timestamp, o.idx AS idx, \
                    (m.reasoning_content IS NOT NULL AND length(m.reasoning_content) > 0) AS has_reasoning \
             FROM ordered o JOIN messages m ON m.rowid = o.rid \
             WHERE o.idx BETWEEN ?2 AND ?3 \
             ORDER BY o.idx ASC",
        )
        .map_err(|e| format!("准备消息窗口查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![session_id, start_seq, end_seq], |row| {
            message_brief_from_row(row).map_err(row_err)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 生成检索命中片段：围绕首个命中位置向两侧取窗口，命中落在很靠后的位置时
/// 也能看到关键词（否则前 200 字截断会让人以为「没搜到」）。
/// 大小写不敏感；`to_lowercase` 可能改变个别字符长度，长度不一致时退化为从头截断。
///
/// 直接作用于「纯文本」：调用方从 `messages.text_plain`（或从 content JSON 提取）取到。
fn search_snippet_text(text: &str, query: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let q = query.trim();
    if q.is_empty() {
        return truncate_chars(&chars, max_chars);
    }
    let lq: Vec<char> = q.to_lowercase().chars().collect();
    let lc: Vec<char> = text.to_lowercase().chars().collect();
    let pos = if !lq.is_empty() && lc.len() == chars.len() {
        lc.windows(lq.len()).position(|w| w == lq.as_slice())
    } else {
        None
    };
    match pos {
        Some(p) => {
            let start = p.saturating_sub(30);
            let end = (p + lq.len() + 160).min(chars.len());
            let mut s = String::new();
            if start > 0 {
                s.push('…');
            }
            s.extend(chars[start..end].iter());
            if end < chars.len() {
                s.push('…');
            }
            s
        }
        None => truncate_chars(&chars, max_chars),
    }
}

/// 反查工具名时，往前最多扫描的「带 tool_calls 的 assistant 消息」条数。
/// 并行工具调用会把宿主 assistant 隔开若干条结果消息，正常远小于这个上限。
const TOOL_HOST_SCAN: usize = 20;

/// 从「工具结果消息」反查发起该调用的工具名（如 `read_file` / `edit_file`）。
///
/// tool 消息只存结果与 `tool_call_id`，工具名在同会话、rowid 更小的 assistant
/// 消息的 `tool_calls` JSON 里（[`crate::agent::types::ToolUseContent`]）。
/// 单页最多 `limit` 次调用（每次 2 条走索引的查询），开销与检索本身同量级。
/// 任何一步失败都退化为 `None`（前端只是不展示工具标签，不影响检索结果）。
fn tool_name_of_tool_message(
    conn: &Connection,
    session_id: &str,
    tool_rowid: i64,
) -> Option<String> {
    let tool_call_id: String = conn
        .query_row(
            "SELECT tool_call_id FROM messages WHERE rowid=?1 AND tool_call_id IS NOT NULL",
            params![tool_rowid],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    let mut stmt = conn
        .prepare(
            "SELECT tool_calls FROM messages \
             WHERE session_id=?1 AND role='assistant' AND tool_calls IS NOT NULL AND rowid<?2 \
             ORDER BY rowid DESC LIMIT ?3",
        )
        .ok()?;
    let rows = stmt
        .query_map(
            params![session_id, tool_rowid, TOOL_HOST_SCAN as i64],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    for json in rows.flatten() {
        if let Ok(list) = serde_json::from_str::<Vec<crate::agent::types::ToolUseContent>>(&json) {
            if let Some(tc) = list.into_iter().find(|t| t.id == tool_call_id) {
                return Some(tc.name);
            }
        }
    }
    None
}

pub(crate) async fn get_message_window(
    conn: Arc<Mutex<Connection>>,
    session_id: &str,
    anchor_id: Option<&str>,
    anchor_seq: Option<i64>,
    before: usize,
    after: usize,
) -> Result<MessageWindow, String> {
    let session_id = session_id.to_string();
    let anchor_id = anchor_id.map(|s| s.to_string());
    let (before, after) = clamp_window(before, after);
    tokio::task::spawn_blocking(move || -> Result<MessageWindow, String> {
        let conn = conn.lock().unwrap();
        let total = session_message_count(&conn, &session_id)?;
        let boundary = boundary_seq(&conn, &session_id)?;
        // 可查询区间的最后一条时序（无 summary → 该区间为空）
        let last_queryable = boundary.map(|b| b - 1).unwrap_or(0);

        // 解析锚点时序（优先 id，其次 seq；都不传则取区间最新一条）
        let mut anchor_found = true;
        let anchor: i64 = if let Some(id) = anchor_id.as_deref() {
            let rid: Option<i64> = conn
                .query_row(
                    "SELECT rowid FROM messages WHERE session_id=?1 AND id=?2",
                    params![session_id, id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("查询锚点消息失败: {}", e))?;
            match rid {
                None => {
                    anchor_found = false;
                    0
                }
                Some(r) => seq_of_rowid(&conn, &session_id, r)?,
            }
        } else if let Some(s) = anchor_seq {
            if s >= 1 && s <= total {
                s
            } else {
                anchor_found = false;
                0
            }
        } else {
            last_queryable
        };

        // 锚点未找到 / 区间为空 / 锚点落在「已在上下文」的区间 → 返回空窗口
        // （由调用方转成提示，不当成错误）
        if !anchor_found || last_queryable < 1 || anchor < 1 || anchor > last_queryable {
            return Ok(MessageWindow {
                anchor_found,
                anchor_seq: anchor.max(0),
                start_seq: 0,
                end_seq: 0,
                total,
                boundary_seq: boundary,
                clamped_by_boundary: true,
                messages: Vec::new(),
            });
        }

        let start = (anchor - before as i64).max(1);
        let mut end = anchor + after as i64;
        let mut clamped = false;
        if end > last_queryable {
            end = last_queryable;
            clamped = true;
        }

        let messages = fetch_message_briefs(&conn, &session_id, start, end)?;
        Ok(MessageWindow {
            anchor_found: true,
            anchor_seq: anchor,
            start_seq: start,
            end_seq: end,
            total,
            boundary_seq: boundary,
            clamped_by_boundary: clamped,
            messages,
        })
    })
    .await
    .map_err(|e| format!("DB task join error: {}", e))?
}

pub(crate) async fn get_message_timeline(
    conn: Arc<Mutex<Connection>>,
    session_id: &str,
    keyword: Option<&str>,
    before_seq: Option<i64>,
    limit: usize,
) -> Result<MessageTimelinePage, String> {
    let session_id = session_id.to_string();
    let keyword = keyword
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let limit = limit.clamp(1, MSG_QUERY_MAX_LIMIT);
    tokio::task::spawn_blocking(move || -> Result<MessageTimelinePage, String> {
        let conn = conn.lock().unwrap();
        let total = session_message_count(&conn, &session_id)?;
        let boundary = boundary_seq(&conn, &session_id)?;
        let last_queryable = boundary.map(|b| b - 1).unwrap_or(0);
        if last_queryable < 1 {
            return Ok(MessageTimelinePage {
                items: Vec::new(),
                has_more: false,
                next_cursor: None,
                total,
                boundary_seq: boundary,
            });
        }

        // 全部匿名 `?`：与 args 压入顺序严格一致
        let mut sql = String::from(
            "WITH ordered AS ( \
               SELECT rowid AS rid, ROW_NUMBER() OVER (ORDER BY rowid) AS idx \
               FROM messages WHERE session_id = ? \
             ) \
             SELECT m.id AS id, m.role AS role, m.tool_calls AS tool_calls, \
                    m.timestamp AS timestamp, o.idx AS idx, \
                    COALESCE(m.text_plain, '') AS text_plain \
             FROM ordered o JOIN messages m ON m.rowid = o.rid \
             WHERE o.idx <= ?",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(session_id.clone()), Box::new(last_queryable)];
        if let Some(cursor) = before_seq {
            sql.push_str(" AND o.idx < ?");
            args.push(Box::new(cursor));
        }
        if let Some(kw) = &keyword {
            // 转义 LIKE 通配符，避免关键词里的 % _ \ 改变语义
            let escaped = kw
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            sql.push_str(" AND COALESCE(m.text_plain, '') LIKE ? ESCAPE '\\'");
            args.push(Box::new(format!("%{}%", escaped)));
        }
        sql.push_str(" ORDER BY o.idx DESC LIMIT ?");
        args.push(Box::new((limit + 1) as i64));

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("准备消息时序查询失败: {}", e))?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(args.iter().map(|p| p.as_ref())),
                |row| {
                    let text_plain: String = row.get("text_plain")?;
                    let (preview, _) =
                        truncate_with_flag(&text_plain, MSG_QUERY_PREVIEW_MAX_CHARS);
                    let mut tool_names: Vec<String> = Vec::new();
                    if let Some(json) = row.get::<_, Option<String>>("tool_calls")? {
                        if let Ok(list) = serde_json::from_str::<
                            Vec<crate::agent::types::ToolUseContent>,
                        >(&json)
                        {
                            tool_names = list.into_iter().map(|t| t.name).collect();
                        }
                    }
                    Ok(MessageTimelineItem {
                        seq: row.get("idx")?,
                        id: row.get("id")?,
                        role: row.get("role")?,
                        timestamp: row.get("timestamp")?,
                        preview,
                        tool_names,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        let mut items: Vec<MessageTimelineItem> = Vec::new();
        for r in rows {
            items.push(r.map_err(|e| e.to_string())?);
        }
        let has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        // 查询为时序倒序 → 反转为升序（与 read 工具一致，便于模型阅读）
        items.reverse();
        let next_cursor = if has_more {
            items.first().map(|i| i.seq)
        } else {
            None
        };
        Ok(MessageTimelinePage {
            items,
            has_more,
            next_cursor,
            total,
            boundary_seq: boundary,
        })
    })
    .await
    .map_err(|e| format!("DB task join error: {}", e))?
}

pub(crate) async fn search_messages(
    conn: Arc<Mutex<Connection>>,
    migrated: bool,
    query: &str,
    session_id: Option<&str>,
    role: Option<&str>,
    limit: usize,
    cursor: Option<SearchCursor>,
) -> Result<MessageSearchPage, String> {
    // 空查询 = 不按关键词过滤，直接返回最新消息（见下方分支）。
    let query = query.trim().to_string();
    let session_id = session_id.map(|s| s.to_string());
    let role = role.map(|s| s.to_string());
    let limit = limit.max(1);
    // 迁移是否完成：未完成时 text_plain 尚未回填，检索需回退到旧的 content 路径
    tokio::task::spawn_blocking(move || -> Result<MessageSearchPage, String> {
        let conn = conn.lock().unwrap();

        // 空查询不做关键词过滤（返回最新消息）；非空查询再按长度分流：
        // ≥3 字符走 FTS5（trigram，走索引）；更短的查询 trigram 无法命中，
        // 回退到对纯文本列 `text_plain` 的 LIKE —— 短查询虽仍是扫描，但已不再误命中 JSON 键名。
        // 迁移未完成时改走 COALESCE(text_plain, content) 的 LIKE（见下方分支），短查询仍可命中。
        let has_query = !query.is_empty();
        let use_fts = has_query && migrated && query.chars().count() >= 3;

        // 目标条数：多取 1 条以判断是否还有下一页；正文为空的行会被跳过，
        // 因此可能需要向后多扫几批才能凑够一页（见下方循环）。
        let want = limit + 1;
        let mut collected: Vec<(MessageSearchItem, i64)> = Vec::new();
        let mut scan = cursor;

        loop {
            let remaining = want - collected.len();
            if remaining == 0 {
                break;
            }

            // 匿名 `?` 按出现顺序编号，参数顺序与拼接顺序严格一致
            let mut sql: String;
            let mut args: Vec<Box<dyn rusqlite::ToSql>>;
            if use_fts {
                // 整体加引号作为短语查询；内部双引号翻倍转义，避免 FTS5 语法注入
                let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
                sql = String::from(
                    "SELECT m.id AS id, m.session_id AS session_id, m.role AS role, \
                     m.text_plain AS text_plain, m.content AS content, m.timestamp AS timestamp, \
                     m.rowid AS message_rowid, \
                     s.title AS session_title, s.workspace AS workspace, s.agent_id AS agent_id \
                     FROM messages_fts \
                     JOIN messages m ON m.rowid = messages_fts.rowid \
                     JOIN sessions s ON s.id = m.session_id \
                     WHERE messages_fts MATCH ?",
                );
                args = vec![Box::new(fts_query)];
            } else if has_query {
                // LIKE 模式：转义 % _ \ ，避免用户输入里的通配符改变语义
                let escaped = query
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                let like = format!("%{}%", escaped);
                // 优先匹配纯文本列；仅「未回填的旧行」text_plain 为 NULL →
                // 才回退到 content（否则那部分行会完全搜不到）。
                sql = String::from(
                    "SELECT m.id AS id, m.session_id AS session_id, m.role AS role, \
                     m.text_plain AS text_plain, m.content AS content, m.timestamp AS timestamp, \
                     m.rowid AS message_rowid, \
                     s.title AS session_title, s.workspace AS workspace, s.agent_id AS agent_id \
                     FROM messages m JOIN sessions s ON s.id = m.session_id \
                     WHERE COALESCE(m.text_plain, m.content) LIKE ? ESCAPE '\\'",
                );
                args = vec![Box::new(like)];
            } else {
                // 空查询：不做关键词过滤，仅按 role / session / 游标取最新消息。
                sql = String::from(
                    "SELECT m.id AS id, m.session_id AS session_id, m.role AS role, \
                     m.text_plain AS text_plain, m.content AS content, m.timestamp AS timestamp, \
                     m.rowid AS message_rowid, \
                     s.title AS session_title, s.workspace AS workspace, s.agent_id AS agent_id \
                     FROM messages m JOIN sessions s ON s.id = m.session_id \
                     WHERE 1=1",
                );
                args = Vec::new();
            }
            // 先剔除「非 NULL 的空 / 空白」（如 '' / 纯空白）；
            // text_plain 为 NULL 的历史行交给下方 Rust 侧按实际正文判定。
            sql.push_str(
                " AND (m.text_plain IS NULL OR \
                 LENGTH(TRIM(m.text_plain, char(32,9,10,13))) > 0)",
            );
            match role.as_deref() {
                Some(r) => {
                    sql.push_str(" AND m.role = ?");
                    args.push(Box::new(r.to_string()));
                }
                // 未指定角色时只检索聊天列表真正展示的两类，排除 tool / summary / feedback
                None => sql.push_str(" AND m.role IN ('user','assistant')"),
            }
            if let Some(sid) = session_id.as_deref() {
                sql.push_str(" AND m.session_id = ?");
                args.push(Box::new(sid.to_string()));
            }
            // keyset 游标：只取「严格排在已扫描最后一条之后」的消息（同一 timestamp 用 rowid 破平）
            if let Some(c) = scan {
                sql.push_str(" AND (m.timestamp < ? OR (m.timestamp = ? AND m.rowid < ?))");
                args.push(Box::new(c.timestamp));
                args.push(Box::new(c.timestamp));
                args.push(Box::new(c.rowid));
            }
            sql.push_str(" ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?");
            args.push(Box::new(remaining as i64));

            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("准备检索查询失败: {}", e))?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(args.iter().map(|p| p.as_ref())),
                    |row| {
                        // text_plain 为新列（迁移后必有值）；为空时兜底从 content 提取
                        let plain: Option<String> = row.get("text_plain")?;
                        let plain = match plain {
                            Some(t) => t,
                            None => {
                                let content_json: String = row.get("content")?;
                                let content: serde_json::Value =
                                    serde_json::from_str(&content_json).map_err(|e| {
                                        row_err(format!("反序列化消息内容失败: {}", e))
                                    })?;
                                content_plain_text(&content)
                            }
                        };
                        // 正文为空（含纯空白）→ 仅做思考 / 工具调用，不纳入检索
                        let blank = plain.trim().is_empty();
                        let rowid: i64 = row.get("message_rowid")?;
                        let item = MessageSearchItem {
                            id: row.get("id")?,
                            session_id: row.get("session_id")?,
                            role: row.get("role")?,
                            text: search_snippet_text(&plain, &query, 200),
                            timestamp: row.get("timestamp")?,
                            session_title: row.get("session_title")?,
                            workspace: row.get("workspace")?,
                            agent_id: row.get("agent_id")?,
                            // 工具名在下方按 rowid 反查后才回填
                            tool_name: None,
                        };
                        Ok((item, rowid, blank))
                    },
                )
                .map_err(|e| e.to_string())?;
            let mut raw: Vec<(MessageSearchItem, i64, bool)> = Vec::new();
            for r in rows {
                raw.push(r.map_err(|e| e.to_string())?);
            }
            if raw.is_empty() {
                break;
            }
            let scanned = raw.len();
            // 游标推进到本批扫到的最后一行，下一批从它之后继续（不重复扫描）
            if let Some((it, rid, _)) = raw.last() {
                scan = Some(SearchCursor {
                    timestamp: it.timestamp,
                    rowid: *rid,
                });
            }
            for (item, rid, blank) in raw {
                if !blank {
                    collected.push((item, rid));
                }
            }
            // 本批没取满 → 后面没有更多行了
            if scanned < remaining {
                break;
            }
        }

        let has_more = collected.len() > limit;
        if has_more {
            collected.truncate(limit);
        }
        let next_cursor = if has_more {
            collected.last().map(|(it, rid)| SearchCursor {
                timestamp: it.timestamp,
                rowid: *rid,
            })
        } else {
            None
        };
        // tool 结果行反查工具名：前端据此在命中条目前展示「查看文件 / 编辑文件」等标签
        let items = collected
            .into_iter()
            .map(|(mut it, rid)| {
                if it.role == "tool" {
                    let name = tool_name_of_tool_message(&conn, &it.session_id, rid);
                    it.tool_name = name;
                }
                it
            })
            .collect();
        Ok(MessageSearchPage {
            items,
            has_more,
            next_cursor,
        })
    })
    .await
    .map_err(|e| format!("DB task join error: {}", e))?
}
