//! service — 后台服务分类公共模块（分类 id: service）。
//!
//! 与 `execute` 分类的分工：`execute_command` 会**等命令结束**（超时即杀），本分类的
//! `start_background_service` 把进程**留在后台**——工具返回后进程继续活着、输出继续被收集，
//! 由 `get_background_service` / `kill_background_service` / `list_background_services` 管理。
//!
//! 本文件集中放常量、参数/文本辅助与「模型侧文案 + uiData」组装，供四个工具共用。
//! ⚠️ 模型侧文案固定英文（与 TS / UI 无关）；UI 只读 `uiData` 按界面语言重建（铁律 1）。

use serde_json::{json, Value};

// ==================== 常量 ====================

/// `start_background_service` 的默认等待时间（ms）——用于收集启动输出。
pub(super) const DEFAULT_WAIT_MS: i64 = 1000;
/// 等待窗口上限（ms）。再长也没有意义：启动日志该出来早出来了，剩下的交给 get 的 `waitMs`。
pub(super) const MAX_WAIT_MS: i64 = 60_000;
/// 单个会话内最多同时存在的服务条目数（含已结束未清理的）。
pub(super) const MAX_SERVICES_PER_SESSION: usize = 8;
/// 全局最多服务条目数（多会话叠加）。
pub(super) const MAX_SERVICES_TOTAL: usize = 32;
/// 每个流（stdout / stderr）保留的输出字符上限（环形，超限丢最旧）。
pub(super) const STREAM_CAP_CHARS: usize = 200_000;
/// 单次返回给模型的输出字符上限（超出截断 + 明示总长）。
pub(super) const MAX_RESULT_CHARS: usize = 20_000;
/// `mode="tail"` 的默认行数 / 上限。
pub(super) const DEFAULT_TAIL_LINES: usize = 200;
pub(super) const MAX_TAIL_LINES: usize = 2000;
/// `kill` 后等待进程真正退出的上限（ms）——拿最终退出码 + 尾部输出。
pub(super) const KILL_WAIT_MS: i64 = 3000;

/// 状态字符串（模型侧与 uiData 共用，语言无关 —— UI 按它映射徽标文案）。
pub(crate) mod status {
    /// 存活
    pub(crate) const RUNNING: &str = "running";
    /// 已结束（自行退出或被终止；`returnCode` 给退出码，`killed` 区分是否被终止）
    pub(crate) const EXITED: &str = "exited";
    /// 启动失败（连 shell 都没起来，无 pid、无退出码）
    pub(crate) const FAILED: &str = "failed";
}

/// 追加到审批弹窗提示后的「这是常驻服务」说明（弹窗文案与 `SANDBOX_BYPASS_HINT` 同源策略：
/// 由 Rust 直接下发给 JS，不进 i18n）。
pub(super) const SERVICE_START_HINT: &str = "⚠️ 该命令将作为**后台服务**常驻运行：AI 不会等它结束，服务会一直留在本会话里（直到 AI 或你终止它、或应用退出）。";

// ==================== 文本辅助 ====================

/// 第 `n` 个字符的字节下标（`n >= 字符数` → 返回 `len()`）。
pub(super) fn char_index(s: &str, n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    match s.char_indices().nth(n) {
        Some((idx, _)) => idx,
        None => s.len(),
    }
}

/// 从第 `n` 个字符起切片（按字符，不按字节 —— 中文安全）。
pub(super) fn slice_from_char(s: &str, n: usize) -> &str {
    &s[char_index(s, n)..]
}

/// 取末尾 `n` 行（保留行尾换行的原貌）。
pub(super) fn tail_lines(s: &str, n: usize) -> &str {
    if n == 0 || s.is_empty() {
        return "";
    }
    let mut count = 0usize;
    for (idx, ch) in s.char_indices().rev() {
        if ch == '\n' && idx + 1 < s.len() {
            count += 1;
            if count == n {
                return &s[idx + 1..];
            }
        }
    }
    s
}

/// 截断到 [`MAX_RESULT_CHARS`]，返回 `(文本, 是否截断)`。
///
/// 截断时保留**尾部**（服务的诊断信息在最后几行：端口占用 / 编译错误都在末尾）。
pub(super) fn cap_output(text: &str) -> (String, bool) {
    let chars = text.chars().count();
    if chars <= MAX_RESULT_CHARS {
        return (text.to_string(), false);
    }
    let tail = slice_from_char(text, chars - MAX_RESULT_CHARS);
    (
        format!(
            "({} characters omitted)...\n{}",
            chars - MAX_RESULT_CHARS,
            // 丢掉的那段可能以半行结尾：给个换行，别让截断处跟后面的正文粘一行
            tail.trim_start_matches(['\n', ' '])
        ),
        true,
    )
}

/// 渲染一个流的输出（ANSI / `\r` 覆盖处理与 `execute_command` 同一实现）。
pub(super) fn render_stream(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    super::super::execute::common::process_terminal_output(text)
}

/// 合并 stdout / stderr 为模型侧输出块（与 `execute_command` 的 `[stderr]` 分段同形）。
pub(super) fn render_output(stdout: &str, stderr: &str) -> String {
    let mut out = render_stream(stdout);
    if !stderr.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("[stderr]\n");
        out.push_str(&render_stream(stderr));
    }
    out
}

/// 运行时长的人类可读形态（`12s` / `2m10s` / `1h03m`）。
pub(super) fn format_uptime(ms: i64) -> String {
    let secs = (ms.max(0) / 1000) as u64;
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// 服务条目的语言无关结构化字段（四个工具的 `uiData` 共用一份骨架）。
///
/// `terminal` / `interactive`（P3）是两个不同的问题，都要给：
/// - `terminal` = 该服务**（曾）跑在伪控制台里**（`ServiceState::pty_capable`）—— 已结束的终端服务仍为
///   `true`（控制台随进程退出被关闭，但「它当初是个终端服务」这个事实不变）；
/// - `interactive` = **现在就能输入**（仍在运行 **且** 控制台还活着）。
///
/// 界面据此把两种「不能输入」分开：`terminal=true && running=false` → 「服务已结束，只能查看输出」，
/// `terminal=false` → 「管道模式，无法输入」。
pub(super) fn base_ui(entry: &super::registry::ServiceEntry, now: i64) -> Value {
    let (status, code, killed) = entry.snapshot();
    let running = status == status::RUNNING;
    let terminal = entry.state.pty_capable();
    let interactive = running && entry.state.has_pty();
    json!({
        "id": entry.id.clone(),
        "name": entry.name.clone(),
        "cmd": entry.cmd.clone(),
        "status": status,
        "returnCode": code,
        "killed": killed,
        "pid": entry.pid,
        "startedAt": entry.started_at,
        "uptimeMs": (now - entry.started_at).max(0),
        "uptime": format_uptime(now - entry.started_at),
        "sandbox": entry.sandbox.clone(),
        "terminal": terminal,
        "interactive": interactive,
    })
}

/// 在 `uiData` 上补输出字段（stdout / stderr 分开给 UI，由 UI 自己拼与转义）。
pub(super) fn with_output(mut ui: Value, stdout: &str, stderr: &str, truncated: bool) -> Value {
    if let Value::Object(map) = &mut ui {
        map.insert("stdout".into(), Value::String(stdout.to_string()));
        map.insert("stderr".into(), Value::String(stderr.to_string()));
        map.insert("truncated".into(), Value::Bool(truncated));
    }
    ui
}

/// 「服务结束」通知的**消息本体**（模型侧英文正文 + `uiData`）—— 队列 / 注入 / 落库 / 上屏用的都是这一条。
///
/// 模型要能一眼拿到四件事：**哪个**服务（name + id）、**怎么**结束的（自行退出 / 被终止）、
/// **退出码**、**下一步**（输出还在，别干等）。界面只读 `uiData`（铁律 1）。
///
/// `role = "feedback"`：与「用户更新了任务清单」同一类载体 —— 三个 Provider 都把它映射成 user，
/// 模型天然可见；界面按 `uiData.type` 决定怎么渲染（不是用户发言，所以不进会话时间）。
pub(super) fn exit_notice(entry: &super::registry::ServiceEntry, now: i64) -> Value {
    let (_, code, killed) = entry.snapshot();
    let uptime = format_uptime(now - entry.started_at);
    let how = if killed {
        "was terminated (it did not exit on its own)"
    } else {
        "exited on its own"
    };
    let code_text = match (code, killed) {
        (Some(c), true) => format!("{c} (terminated)"),
        (Some(c), false) => c.to_string(),
        (None, true) => "null (terminated)".to_string(),
        (None, false) => "null".to_string(),
    };
    let content = format!(
        "[Background service ended] \"{}\" (id: {}) {how} after {uptime}.\n\
         Command: {}\n\
         Exit code: {code_text}\n\
         It is no longer running — do not wait on it. Read what it printed with \
         get_background_service (id: \"{}\") if that matters, then fix the command and start it again if needed.",
        entry.name, entry.id, entry.cmd, entry.id
    );
    let mut ui = base_ui(entry, now);
    if let Value::Object(map) = &mut ui {
        map.insert("type".into(), Value::String("service".into()));
        map.insert("event".into(), Value::String("exit".into()));
    }
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "role": "feedback",
        "content": content,
        "uiData": ui,
        "timestamp": now,
    })
}

/// 输出读取模式（`get` / `kill` 的 `mode` 参数）。
pub(super) enum ReadMode {
    /// 自上次读取以来的新内容（默认；唯一会推进已读游标的模式）
    New,
    /// 末尾 n 行
    Tail(usize),
    /// 完整窗口（受环形容量限制）
    All,
}

/// 解析 `mode` 参数（默认 `new`；未知值也按 `new` —— 宁可多给新内容也不默默给旧的）。
pub(super) fn parse_read_mode(args: &Value) -> ReadMode {
    let mode = arg_trimmed(args, "mode").unwrap_or_else(|| "new".to_string());
    match mode.to_ascii_lowercase().as_str() {
        "tail" => ReadMode::Tail(arg_clamped_i64(
            args,
            "tailLines",
            DEFAULT_TAIL_LINES as i64,
            1,
            MAX_TAIL_LINES as i64,
        ) as usize),
        "all" => ReadMode::All,
        _ => ReadMode::New,
    }
}

/// `mode` 的语言无关名字（`uiData.mode`）。
pub(super) fn read_mode_name(mode: &ReadMode) -> &'static str {
    match mode {
        ReadMode::New => "new",
        ReadMode::Tail(_) => "tail",
        ReadMode::All => "all",
    }
}

/// 取参数：非空字符串（trim 后），空串/非法 → `None`。
pub(super) fn arg_trimmed(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 取参数：整数（可给上下限）。
pub(super) fn arg_clamped_i64(args: &Value, key: &str, default: i64, min: i64, max: i64) -> i64 {
    let v = args.get(key).and_then(|v| v.as_i64()).unwrap_or(default);
    v.clamp(min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_and_tail_are_char_safe() {
        let s = "启动中…\n监听 3000\n完成";
        assert_eq!(slice_from_char(s, 0), s);
        assert_eq!(slice_from_char(s, s.chars().count()), "");
        assert_eq!(tail_lines(s, 1), "完成");
        assert_eq!(tail_lines(s, 2), "监听 3000\n完成");
        assert_eq!(tail_lines(s, 99), s);
    }

    #[test]
    fn cap_output_keeps_tail() {
        let long = format!("{}{}", "a".repeat(MAX_RESULT_CHARS + 10), "末尾");
        let (text, truncated) = cap_output(&long);
        assert!(truncated);
        assert!(text.starts_with("(12 characters omitted)"), "text head: {text}");
        assert!(text.ends_with("末尾"), "截断必须保留尾部（诊断信息在最后几行）");
    }
    #[test]
    fn format_uptime_is_readable() {
        assert_eq!(format_uptime(0), "0s");
        assert_eq!(format_uptime(12_400), "12s");
        assert_eq!(format_uptime(130_000), "2m10s");
        assert_eq!(format_uptime(3_780_000), "1h03m");
    }
}
