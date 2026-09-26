//! 续连体验的两处**共享格式化** —— 「历史预览」与「退出时的续连提示」
//!
//! ## 为什么单独一个文件
//!
//! 这两样东西 `TUI`（`app.rs`）与**顺序输出模式**（`plain.rs`）**各调一次**：放一处才不会
//! 出现「一条路径显示了会话 id、另一条忘了」这类**静默分叉**（与 `session_rt` 存在的理由同款）。
//!
//! ## 边界
//!
//! 本模块**没有任何 I/O、不碰终端**：`history_preview` 是「消息 → 行」的纯函数，因此可以直接
//! 单测；怎么呈现（TUI 按 `LineKind` 上色 / 顺序模式直接打印）由调用方决定 —— 两种模式用的是
//! **同一份文本**。

use crate::tui::sink::first_line;
use crate::tui::state::{LineKind, OutLine};
use virlen_core::agent::types::Message;

/// 续连时预览的历史消息条数。
///
/// 用户 2026-09-26 定案：取最近 5 条（会话末尾）—— 续连时最有用的是「上次说到哪」，而不是会话
/// 开头的寒暄。⚠️ `get_messages` 返回的是从旧到新的时序，所以这里取的是尾部。
pub(crate) const HISTORY_PREVIEW: usize = 5;

/// 单条预览行最多显示的字符数（预览是「一眼看清」，不是把整段历史重放一遍）
const PREVIEW_CHARS: usize = 120;

/// 续连（`chat --session <id>`）时的历史预览：**最近 `max` 条**，最旧的在前（保持时序）。
///
/// 消息为空时返回空 `Vec`（调用方据此决定要不要说话 —— 新会话就没有历史，不该打表头）。
/// 返回的行**已带角色前缀**（`[你]` / `[AI]` / `[工具]`），因此 TUI 上色与顺序打印共用同一份文本。
pub(crate) fn history_preview(messages: &[Message], max: usize) -> Vec<OutLine> {
    if messages.is_empty() || max == 0 {
        return Vec::new();
    }
    let start = messages.len().saturating_sub(max);
    let shown = &messages[start..];
    let mut out = Vec::with_capacity(shown.len() + 1);
    // 表头写明「取了几条 / 一共几条」：用户才知道上面看到的不是全部历史
    out.push(OutLine::new(
        LineKind::Notice,
        format!(
            "—— 历史预览：最近 {} 条 / 共 {} 条 ——",
            shown.len(),
            messages.len()
        ),
    ));
    out.extend(shown.iter().map(preview_line));
    out
}

/// 退出时的续连提示（两种模式共用）。
///
/// ⚠️ 会话 id 完整给出（不截断）：它要能被直接复制回命令行 —— 这与状态行里那个只显示前 8 位的
/// `short_id` 是两种用途，不要图省事合并。
pub(crate) fn resume_hint(session_id: &str) -> String {
    format!(
        "[chat] 会话 id: {id}\n[chat] 续连本会话: virlen-cli chat --session {id}",
        id = session_id
    )
}

/// 一条消息 → 一行预览
fn preview_line(m: &Message) -> OutLine {
    let (kind, label) = role_label(&m.role);
    OutLine::new(kind, format!("[{}] {}", label, preview_body(m)))
}

/// 角色 → （着色 + 前缀）。称呼与桌面端一致（`你` / `AI`）。
fn role_label(role: &str) -> (LineKind, &str) {
    match role {
        "user" => (LineKind::User, "你"),
        "assistant" => (LineKind::Assistant, "AI"),
        "tool" => (LineKind::ToolOutput, "工具"),
        "system" => (LineKind::Notice, "系统"),
        other => (LineKind::Notice, other),
    }
}

/// 消息的**单行**摘要：正文压平 + 截断；正文为空时退回工具调用 / 占位。
///
/// 「正文为空」不是罕见情况：纯工具调用的助手消息（只有 `tool_calls`、没有 text）也会落库，
/// 直接取 `text_content()` 会得到空串 —— 那样预览里会出现一行光秃秃的 `[AI]`，看不出发生过什么。
fn preview_body(m: &Message) -> String {
    let flat = first_line(&m.text_content(), PREVIEW_CHARS);
    if !flat.is_empty() {
        return flat;
    }
    let names: Vec<&str> = m
        .tool_calls
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    if names.is_empty() {
        "（空）".to_string()
    } else {
        format!("（调用工具 {}）", names.join("、"))
    }
}
