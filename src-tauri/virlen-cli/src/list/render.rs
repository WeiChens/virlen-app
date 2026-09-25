//! 表格渲染（纯函数）—— 按**显示列宽**对齐、按时间与摘要截断
//!
//! 为什么单独一层：中文字符占两列（`is_wide` / `display_width`），对齐必须按显示宽度算；
//! 这套口径同时决定**表头**（在 `sessions.rs` / `agents.rs`）与**每一行**（`session_line` 在这里），
//! 分开放一定会错位。

use virlen_core::agent::types::Session;
use serde_json::{json, Value};

use super::{DEFAULT_LIMIT, MAX_LIMIT};

// ==================== 渲染 ====================

// 列宽（显示列数；改这里即改表格形状）
pub(crate) const COL_ID: usize = 36;
pub(crate) const COL_TIME: usize = 16;
pub(crate) const COL_MODEL: usize = 20;
pub(crate) const COL_TITLE: usize = 40;
pub(crate) const COL_COUNT: usize = 6;
pub(crate) const COL_DIR: usize = 28;

/// 字符是否占两个终端列（CJK / 全角）
pub(crate) fn is_wide(c: char) -> bool {
    matches!(
        c as u32,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
    )
}

/// 终端显示宽度（中文按 2 列）
///
/// ⚠️ Rust 的 `{:<n}` 按**字符数**补齐，中文列（如「会话数」= 6 列 / 3 字符）会错位，
/// 所以表格一律走本文件的 `pad` / `pad_left`。
pub(crate) fn display_width(s: &str) -> usize {
    s.chars().map(|c| if is_wide(c) { 2 } else { 1 }).sum()
}

/// 左对齐补齐到 `width` 显示列
pub(crate) fn pad(s: &str, width: usize) -> String {
    let w = display_width(s);
    if w >= width {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(width - w))
    }
}

/// 右对齐补齐到 `width` 显示列
pub(crate) fn pad_left(s: &str, width: usize) -> String {
    let w = display_width(s);
    if w >= width {
        s.to_string()
    } else {
        format!("{}{}", " ".repeat(width - w), s)
    }
}

/// 毫秒时间戳 → 本地时间 `YYYY-MM-DD HH:MM`
pub(crate) fn fmt_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| {
            dt.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "-".to_string())
}

/// 压平换行 + 按**显示列**截断（超过 `max_cols` 加省略号）
pub(crate) fn brief(s: &str, max_cols: usize) -> String {
    let flat = s.replace(['\r', '\n'], " ");
    if display_width(&flat) <= max_cols {
        return flat;
    }
    let mut out = String::new();
    let mut w = 0usize;
    for c in flat.chars() {
        let cw = if is_wide(c) { 2 } else { 1 };
        if w + cw > max_cols.saturating_sub(1) {
            break;
        }
        out.push(c);
        w += cw;
    }
    out.push('…');
    out
}

/// 生效条数：`None` → 默认；`Some(0)` → 全部（仍受 `MAX_LIMIT` 限制）
pub(crate) fn effective_limit(limit: Option<usize>) -> usize {
    match limit {
        None => DEFAULT_LIMIT,
        Some(0) => MAX_LIMIT,
        Some(n) => n.min(MAX_LIMIT),
    }
}

/// 一个会话 → JSON（字段与前端 `Session` 同名；不含 messages）
pub(crate) fn session_json(s: &Session) -> Value {
    json!({
        "id": s.id,
        "title": s.title,
        "agentId": s.agent_id,
        "workspace": s.workspace,
        "providerConfigId": s.provider_config_id,
        "modelId": s.model_id,
        "pinned": s.pinned,
        "tags": s.tags,
        "createdAt": s.created_at,
        "updatedAt": s.updated_at,
    })
}

/// 会话行：`ID  更新于  模型  标题`（`indent` 供分组模式缩进）
pub(crate) fn session_line(s: &Session, indent: &str) -> String {
    format!(
        "{}{}  {}  {}  {}",
        indent,
        pad(&s.id, COL_ID),
        pad(&fmt_time(s.updated_at), COL_TIME),
        pad(&brief(&s.model_id, COL_MODEL), COL_MODEL),
        brief(&s.title, COL_TITLE)
    )
}
