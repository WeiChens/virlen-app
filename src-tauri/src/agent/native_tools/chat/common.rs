//! chat — 消息查询公共（文本格式化 / 输出上限 / 单会话字符预算）
//!
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/chat/common.ts` **逐字对齐**（铁律 1）：
//! `list_messages` / `read_messages` 原生化后，Rust 原生路径（默认）与 JS 路径（TS 引擎）
//! 必须产出同一份 `content`（模型侧文本：英文，**不进 i18n**）。
//!
//! 硬上限三处一致：本文件 ↔ TS `tools/chat/common.ts` ↔ Rust
//! `session_db::types::MSG_QUERY_*`（后者是服务端权威 clamp）。

use crate::session_db::{MessageTimelinePage, MessageWindow};
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// 概览单页条数：默认 / 上限
pub(crate) const LIST_DEFAULT_LIMIT: usize = 30;
pub(crate) const LIST_MAX_LIMIT: usize = 50;

/// 窗口相对偏移：默认前后各 5 条；单侧上限与 `MSG_QUERY_MAX_BACK/FWD` 对齐
pub(crate) const WINDOW_DEFAULT_SPAN: i64 = 5;
pub(crate) const WINDOW_MAX_BACK: i64 = 20;
pub(crate) const WINDOW_MAX_FWD: i64 = 20;

/// 单次调用输出总字符上限（超出则截断并提示缩小窗口）
pub(crate) const CALL_OUTPUT_MAX_CHARS: usize = 30_000;
/// 单会话滑窗预算：窗口内累计返回的字符上限
pub(crate) const BUDGET_WINDOW_MS: i64 = 60_000;
pub(crate) const BUDGET_MAX_CHARS: usize = 60_000;

// ==================== 参数取值（JS 同口径） ====================

/// 与 TS `Number(...)` 同口径的数字取值。
///
/// ⚠️ 只覆盖实际会出现的形态（数字 / 数字字符串 / 布尔）；`null` 与缺失一律视作
/// 「未传」（更符合工具语义，也不对应 TS 里 `Number(null) === 0` 那个边角）。
pub(crate) fn number_of(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// 正整数参数（非法返回 `None`）
pub(crate) fn to_positive_int(raw: Option<&Value>) -> Option<i64> {
    let n = number_of(raw)?;
    if n <= 0.0 {
        return None;
    }
    Some(n.floor() as i64)
}

// ==================== 字符计数 / 截断（JS 同口径） ====================

/// UTF-16 码元长度 —— 与 JS `String.prototype.length` 同一口径。
pub(crate) fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// 取前 `max` 个 **UTF-16 码元**（代理对安全）—— 与 TS `utils/text.ts::sliceHead` 同语义：
/// 截断点正好落在代理对中间时**少取一个字符**，绝不产出半个 emoji。
pub(crate) fn slice_head(text: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        let len = ch.len_utf16();
        if units + len > max {
            break;
        }
        units += len;
        out.push(ch);
    }
    out
}

/// 全量输出截断（超出追加提示，引导模型缩小窗口）
pub(crate) fn cap_output(text: String) -> (String, bool) {
    if utf16_len(&text) <= CALL_OUTPUT_MAX_CHARS {
        return (text, false);
    }
    let mut out = slice_head(&text, CALL_OUTPUT_MAX_CHARS);
    out.push_str("\n…[output truncated — narrow the window or reduce limit]");
    (out, true)
}

// ==================== 单会话字符预算（滑窗） ====================

/// 会话 id → (窗口起点, 已用字符数)
static BUDGETS: Lazy<Mutex<HashMap<String, (i64, usize)>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// 判断本次还能否返回 `chars` 个字符，并从预算中扣除。
///
/// ⚠️ StormBreaker 只能拦截「同名 + 同参」的重复调用；模型换一个锚点 id 就能绕开。
/// 因此这里再加一道按会话的滑窗预算，真正做到「不能把历史一次性刷出来」。
pub(crate) fn consume_budget(session_id: &str, chars: usize) -> bool {
    let now = crate::telemetry::now_ms();
    // 持锁期间只做 O(1) 操作；毒锁（panic 后）也继续用，不让一次历史故障永久禁用预算
    let mut map = match BUDGETS.lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    prune_budgets(&mut map, now);
    let entry = map.entry(session_id.to_string()).or_insert((now, 0));
    if now - entry.0 > BUDGET_WINDOW_MS {
        *entry = (now, 0);
    }
    if entry.1 + chars > BUDGET_MAX_CHARS {
        return false;
    }
    entry.1 += chars;
    true
}

/// 惰性清理过期会话，避免 Map 随会话数无限增长（与 TS `pruneBudgets` 同：少于 64 条直接返回）
fn prune_budgets(map: &mut HashMap<String, (i64, usize)>, now: i64) {
    if map.len() < 64 {
        return;
    }
    map.retain(|_, (start, _)| now - *start <= BUDGET_WINDOW_MS);
}

// ==================== 格式化 ====================

/// 时间戳 → `YYYY-MM-DD HH:MM:SS`（**本机时区**）
///
/// 与 TS `new Date(ts)` 的 `getFullYear()/getHours()…` 同为本地时间；
/// 这里用 `chrono::Local`（无需时区数据库，直接读系统时区）。
fn format_time(ts: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts)
        .map(|dt| {
            dt.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_default()
}

/// 概览行首提示：说明「可查询区间」与「已在上下文的部分」
fn timeline_header(page: &MessageTimelinePage) -> Vec<String> {
    // 无 summary → 可查询区间为空（0 条）
    let queryable = page.boundary_seq.map(|b| b - 1).unwrap_or(0);
    let boundary_text = page
        .boundary_seq
        .map(|b| b.to_string())
        .unwrap_or_else(|| "null".to_string());
    vec![
        format!(
            "Queryable history: #1..#{} ({} messages); conversation total: {}.",
            queryable, queryable, page.total
        ),
        format!(
            "Messages from #{} onward (the compression summary and later) are already in your current context — they are NOT repeated by this tool.",
            boundary_text
        ),
        String::new(),
    ]
}

/// 时序概览 → 模型可读文本（升序，一行一条，含 id 便于接着用 `read_messages`）
pub(crate) fn format_timeline(page: &MessageTimelinePage) -> String {
    let mut lines = timeline_header(page);
    for it in &page.items {
        let tools = if it.tool_names.is_empty() {
            String::new()
        } else {
            format!(" tools({})", it.tool_names.join(","))
        };
        lines.push(format!(
            "#{} [{}] {}{} | {}",
            it.seq,
            it.role,
            format_time(it.timestamp),
            tools,
            it.preview
        ));
        lines.push(format!("    id: {}", it.id));
    }
    lines.push(String::new());
    lines.push(if page.has_more {
        format!(
            "To see older messages, call list_messages again with cursor={}.",
            page.next_cursor
                .map(|c| c.to_string())
                .unwrap_or_else(|| "null".to_string())
        )
    } else {
        "This is the oldest page of the queryable history.".to_string()
    });
    lines.join("\n")
}

/// 窗口消息 → 模型可读文本（升序；正文全文，工具详情已截断，思考已剔除）
pub(crate) fn format_window(win: &MessageWindow) -> String {
    let mut lines: Vec<String> = vec![format!(
        "Window #{}..#{} around anchor #{} (conversation total: {}).",
        win.start_seq, win.end_seq, win.anchor_seq, win.total
    )];
    if win.clamped_by_boundary {
        lines.push(format!(
            "The window was cut at #{}: everything after that is already in your context.",
            win.end_seq
        ));
    }
    lines.push(String::new());

    for m in &win.messages {
        lines.push(format!(
            "#{} [{}] {} (id: {})",
            m.seq,
            m.role,
            format_time(m.timestamp),
            m.id
        ));
        for tc in &m.tool_calls {
            lines.push(format!("  tool: {} {}", tc.name, tc.input_brief));
        }
        // ⚠️ TS 用真值判断（空串当无）→ 这里同样把空串视作缺失
        if let Some(tcid) = m.tool_call_id.as_deref().filter(|s| !s.is_empty()) {
            let err = if m.is_error == Some(true) { " (error)" } else { "" };
            lines.push(format!("  toolCallId: {}{}", tcid, err));
        }
        if m.has_reasoning {
            lines.push("  [deep-thinking present, omitted]".to_string());
        }
        lines.push(if m.text.is_empty() {
            "(no text)".to_string()
        } else {
            m.text.clone()
        });
        if m.has_attachments {
            lines.push("  [message has attachments]".to_string());
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_db::{MessageBrief, MessageTimelineItem, ToolCallBrief};

    fn timeline_item(seq: i64, id: &str, role: &str, preview: &str, tools: Vec<&str>) -> MessageTimelineItem {
        MessageTimelineItem {
            seq,
            id: id.to_string(),
            role: role.to_string(),
            timestamp: 1_700_000_000_000,
            preview: preview.to_string(),
            tool_names: tools.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn timeline_has_header_items_and_cursor_hint() {
        let page = MessageTimelinePage {
            items: vec![
                timeline_item(1, "m1", "user", "你好", vec![]),
                timeline_item(2, "m2", "assistant", "调用工具", vec!["read_file"]),
            ],
            has_more: true,
            next_cursor: Some(9),
            total: 12,
            boundary_seq: Some(11),
        };
        let text = format_timeline(&page);
        assert!(text.starts_with(
            "Queryable history: #1..#10 (10 messages); conversation total: 12.\n\
             Messages from #11 onward (the compression summary and later) are already in your current context — they are NOT repeated by this tool.\n\n"
        ));
        assert!(text.contains("#1 [user] "));
        assert!(text.contains("| 你好\n    id: m1"));
        assert!(text.contains(" tools(read_file) | 调用工具"));
        assert!(text.ends_with("To see older messages, call list_messages again with cursor=9."));
    }

    #[test]
    fn timeline_last_page_hint() {
        let page = MessageTimelinePage {
            items: vec![timeline_item(1, "m1", "user", "x", vec![])],
            has_more: false,
            next_cursor: None,
            total: 3,
            boundary_seq: Some(2),
        };
        let text = format_timeline(&page);
        assert!(text.ends_with("This is the oldest page of the queryable history."));
    }

    #[test]
    fn window_renders_tool_detail_reasoning_and_attachments() {
        let win = MessageWindow {
            anchor_found: true,
            anchor_seq: 2,
            start_seq: 2,
            end_seq: 3,
            total: 5,
            boundary_seq: Some(4),
            clamped_by_boundary: true,
            messages: vec![
                MessageBrief {
                    seq: 2,
                    id: "m2".into(),
                    role: "assistant".into(),
                    timestamp: 1_700_000_000_000,
                    text: "调用 read_file".into(),
                    text_truncated: false,
                    has_attachments: false,
                    tool_calls: vec![ToolCallBrief {
                        name: "read_file".into(),
                        input_brief: "{\"path\":\"a.ts\"}".into(),
                        input_truncated: false,
                    }],
                    tool_call_id: None,
                    is_error: None,
                    has_reasoning: true,
                },
                MessageBrief {
                    seq: 3,
                    id: "m3".into(),
                    role: "tool".into(),
                    timestamp: 1_700_000_000_000,
                    text: String::new(),
                    text_truncated: false,
                    has_attachments: true,
                    tool_calls: vec![],
                    tool_call_id: Some("tc1".into()),
                    is_error: Some(true),
                    has_reasoning: false,
                },
            ],
        };
        let text = format_window(&win);
        assert!(text.starts_with(
            "Window #2..#3 around anchor #2 (conversation total: 5).\n\
             The window was cut at #3: everything after that is already in your context.\n\n"
        ));
        assert!(text.contains("  tool: read_file {\"path\":\"a.ts\"}"));
        assert!(text.contains("  [deep-thinking present, omitted]"));
        assert!(text.contains("  toolCallId: tc1 (error)"));
        assert!(text.contains("(no text)"));
        assert!(text.contains("  [message has attachments]"));
    }

    #[test]
    fn cap_output_truncates_with_hint_and_keeps_emoji_intact() {
        let short = "abc".to_string();
        assert_eq!(cap_output(short.clone()), (short, false));

        // 恰好 30000 个 emoji（60000 码元）→ 截到 15000 个整 emoji + 提示
        let long = "😀".repeat(20_000);
        let (text, truncated) = cap_output(long);
        assert!(truncated);
        assert!(text.ends_with("\n…[output truncated — narrow the window or reduce limit]"));
        let body = text
            .split("\n…[output truncated")
            .next()
            .unwrap()
            .to_string();
        assert_eq!(utf16_len(&body), CALL_OUTPUT_MAX_CHARS);
        assert!(body.chars().all(|c| c == '😀'), "不能切出半个 emoji");
    }

    #[test]
    fn budget_is_per_session_and_capped() {
        // 用唯一会话 id，避免并行测试互相影响
        let s1 = format!("s_budget_{}", uuid::Uuid::new_v4());
        let s2 = format!("s_budget_{}", uuid::Uuid::new_v4());

        assert!(consume_budget(&s1, BUDGET_MAX_CHARS - 1));
        assert!(!consume_budget(&s1, 2), "超出滑窗预算应被拒绝");
        assert!(consume_budget(&s1, 1), "恰好用完预算仍允许");
        // 另一个会话不受影响
        assert!(consume_budget(&s2, BUDGET_MAX_CHARS));
    }

    #[test]
    fn format_time_is_local_hh_mm_ss() {
        let ts = 1_700_000_000_000i64;
        let text = format_time(ts);
        // 与 chrono 的本地时间表述逐字一致（= 与 JS `new Date(ts)` 同口径）
        let expected = chrono::DateTime::from_timestamp_millis(ts)
            .unwrap()
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        assert_eq!(text, expected);
        assert_eq!(text.len(), 19, "YYYY-MM-DD HH:MM:SS");
    }
}
