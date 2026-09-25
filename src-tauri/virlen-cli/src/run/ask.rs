//! 交互应答 —— 终端里问一句、答一句（授权 / 选择 / 未知类型）
//!
//! 三条硬约束（与文件内注释一致，别在这里放宽）：
//!
//! 1. **fail-closed**：stdin 不是 TTY（管道 / CI）时一律拒绝；
//! 2. **每种类型都必须应答**（含未知类型）—— 引擎在等 `rx.await`，不回就永远不返回；
//! 3. 口径与桌面端一致：多选用 `, ` 连接，自由文本按「自定义回复」原样带上。

use serde_json::{json, Value};
use std::io::{BufRead, Write};

// ==================== 交互应答（方案 A） ====================

/// 由终端输入解析 `user_choice` 的回答；`None` = 取消。
///
/// 与桌面端 `tool-ui.tsx::handleChoiceConfirm` 同口径：多个选中项用 `, ` 连接；
/// 非选项的自由文本按「自定义回复」原样带上（对应 GUI 的 customReply）。
pub(crate) fn resolve_choice(input: &str, options: &[String], multi: bool) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    let pick_one = |token: &str| -> Option<String> {
        let t = token.trim();
        if t.is_empty() {
            return None;
        }
        if let Ok(n) = t.parse::<usize>() {
            if n >= 1 && n <= options.len() {
                return Some(options[n - 1].clone());
            }
        }
        if let Some(hit) = options.iter().find(|o| o.as_str() == t) {
            return Some(hit.clone());
        }
        options
            .iter()
            .find(|o| o.eq_ignore_ascii_case(t))
            .cloned()
    };

    if !multi {
        return Some(pick_one(raw).unwrap_or_else(|| raw.to_string()));
    }

    let mut picked: Vec<String> = Vec::new();
    let mut custom: Vec<String> = Vec::new();
    for token in raw.split([',', '，', '、', ';', '；']) {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        match pick_one(t) {
            Some(o) => picked.push(o),
            None => custom.push(t.to_string()),
        }
    }
    picked.extend(custom);
    if picked.is_empty() {
        None
    } else {
        Some(picked.join(", "))
    }
}

/// 读一行 stdin（去掉行尾换行）；读不到（EOF / 出错）返回空串
fn read_stdin_line(input: &mut impl BufRead) -> String {
    let mut line = String::new();
    match input.read_line(&mut line) {
        Ok(_) => line.trim_end_matches(['\r', '\n']).to_string(),
        Err(_) => String::new(),
    }
}

/// 应答一次用户交互（**同步、可能阻塞** —— 由调用方放进 `spawn_blocking`）
///
/// 返回桥协议载荷：`{__kind:"value", value}` 表示正常回答，`{__kind:"cancelled"}` 表示拒绝。
pub(crate) fn ask_user(kind: &str, data: &Value, interactive: bool, stdin: &mut impl BufRead) -> Value {
    let denied = || json!({ "__kind": "cancelled" });

    match kind {
        "confirm_command_native" => {
            let title = data.get("title").and_then(Value::as_str).unwrap_or("");
            let desc = data.get("desc").and_then(Value::as_str).unwrap_or("");
            let hint = data.get("hint").and_then(Value::as_str).unwrap_or("");
            let risk = data.get("risk").and_then(Value::as_str).unwrap_or("");

            eprintln!("\n[confirm] {}（权限: {}）", title, risk);
            if !desc.is_empty() {
                eprintln!("  内容: {}", desc);
            }
            if !hint.is_empty() {
                eprintln!("  {}", hint);
            }
            if !interactive {
                eprintln!("  → 非交互终端，已拒绝（fail-closed）");
                return denied();
            }
            eprint!("  允许执行？[y/N] ");
            let _ = std::io::stderr().flush();
            let answer = read_stdin_line(stdin);
            if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
                // Rust 侧 `parse_approval` 认 `approved` 文本（与桌面端弹窗同一条路径）
                json!({ "__kind": "value", "value": "approved" })
            } else {
                eprintln!("  → 已拒绝");
                denied()
            }
        }
        "user_choice" => {
            let question = data.get("question").and_then(Value::as_str).unwrap_or("");
            let multi = data.get("multi").and_then(Value::as_bool).unwrap_or(false);
            let options: Vec<String> = data
                .get("options")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();

            eprintln!("\n[question] {}", question);
            for (i, o) in options.iter().enumerate() {
                eprintln!("  {}. {}", i + 1, o);
            }
            if !interactive {
                eprintln!("  → 非交互终端，无选择（按取消处理）");
                return denied();
            }
            eprint!(
                "  请输入{}（直接回车 = 取消）: ",
                if multi {
                    "序号或文本，逗号分隔可多选"
                } else {
                    "序号或文本"
                }
            );
            let _ = std::io::stderr().flush();
            let answer = read_stdin_line(stdin);
            match resolve_choice(&answer, &options, multi) {
                Some(content) => json!({ "__kind": "value", "value": content }),
                None => denied(),
            }
        }
        other => {
            // 未知类型也必须应答 —— 否则引擎会一直等回执（见文件头）
            eprintln!("\n[interaction] 未支持的交互类型 `{}`，已拒绝", other);
            denied()
        }
    }
}
