//! 「引擎事件 → 文本」的纯函数层（`run` 的渲染与固化）
//!
//! 为什么单独一个文件：`render_event` 是**纯函数**（事件 + 状态 → 两段文本），
//! 它的可测路径不碰终端、不碰引擎 —— 与参数解析、驱动、交互应答放在一起会互相淹没。
//! `flush_rendered` 是 `Rendered` 的**唯一写出点**，跟着它走（谁产出、谁落盘，两个概念不分散）。

use virlen_core::agent::types::AgentEvent;
use serde_json::Value;
use std::io::Write;

/// 工具结果在 stderr 里的预览长度
pub(crate) const TOOL_PREVIEW_CHARS: usize = 160;

// ==================== 事件渲染（纯函数） ====================

/// 渲染状态（跳事件累积的少量信息：是否需要补换行、工具行是否已打过）
#[derive(Default, Debug)]
pub(crate) struct RenderState {
    /// 本轮是否已经输出过正文
    printed_text: bool,
    /// 输出是否停在行首（决定结束帧要不要补换行）
    at_line_start: bool,
    /// 已经打过「工具开始行」的 tool_call id。
    ///
    /// 为什么需要：同一次工具调用会被发两帧 `tool_call`（模型宣布调用 / 执行器开始执行），
    /// GUI 靠 id 去重；无界面输出否则会重复一行。
    started_tools: std::collections::HashSet<String>,
}

/// 一个事件渲染出来的文本（两条流分开，便于分别写 stdout / stderr）
#[derive(Default, Debug, PartialEq, Eq)]
pub(crate) struct Rendered {
    pub stdout: String,
    pub stderr: String,
}

impl Rendered {
    pub(crate) fn is_empty(&self) -> bool {
        self.stdout.is_empty() && self.stderr.is_empty()
    }
}

/// 事件 → 文本。纯函数（除 `state` 累积），单测直接断言。
///
/// `--json` 模式：整条事件序列化成一行 JSON 写 stdout（人类文本一律不产出）。
pub(crate) fn render_event(event: &AgentEvent, json: bool, state: &mut RenderState) -> Rendered {
    if json {
        return Rendered {
            stdout: format!(
                "{}\n",
                serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string())
            ),
            stderr: String::new(),
        };
    }

    let data = event.data.as_ref();
    match event.type_.as_str() {
        // 正文增量：唯一被打印的正文来源
        //（`assistant_message_updated` 带同一份 contentDelta，重复打印会出现双份正文）
        "stream_event" => {
            let delta = data
                .and_then(|d| d.get("delta"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if delta.is_empty() {
                return Rendered::default();
            }
            state.printed_text = true;
            state.at_line_start = delta.ends_with('\n');
            Rendered {
                stdout: delta.to_string(),
                stderr: String::new(),
            }
        }
        "stream_end" => {
            let paused = data
                .and_then(|d| d.get("paused"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut out = Rendered::default();
            if state.printed_text && !state.at_line_start {
                out.stdout.push('\n');
                state.at_line_start = true;
            }
            if paused {
                out.stderr
                    .push_str("[paused] 运行已暂停（快照保留在内存中，刷新 / 退出即失效）\n");
            }
            state.printed_text = false;
            out
        }
        // 工具开始帧（结束帧带 result，结果统一由 tool_result_created 呈现，避免重复）
        "tool_call" => {
            let Some(d) = data else {
                return Rendered::default();
            };
            if d.get("result").is_some() {
                return Rendered::default();
            }
            let name = d.get("name").and_then(Value::as_str).unwrap_or("tool");
            let id = d.get("id").and_then(Value::as_str).unwrap_or("");
            if !id.is_empty() && !state.started_tools.insert(id.to_string()) {
                // 同一次调用的第二帧（开始执行）—— 前面已经打过行了
                return Rendered::default();
            }
            Rendered {
                stdout: String::new(),
                stderr: format!("\n[tool] {}\n", name),
            }
        }
        "tool_result_created" => {
            let msg = data.and_then(|d| d.get("message"));
            let content = msg
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let failed = msg
                .and_then(|m| m.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Rendered {
                stdout: String::new(),
                stderr: format!(
                    "[tool]   → {} ({} 字符): {}\n",
                    if failed { "failed" } else { "ok" },
                    content.chars().count(),
                    one_line_preview(content, TOOL_PREVIEW_CHARS)
                ),
            }
        }
        "error" => Rendered {
            stdout: String::new(),
            stderr: format!(
                "\n[error] {}\n",
                event.error.as_deref().unwrap_or("unknown error")
            ),
        },
        // 迭代验证（默认不启用，只有传 iterationGoal 时才有）
        "iteration_start" => Rendered {
            stdout: String::new(),
            stderr: format!(
                "\n[iteration] 第 {} 轮\n",
                data.and_then(|d| d.get("iteration"))
                    .and_then(Value::as_i64)
                    .unwrap_or(1)
            ),
        },
        "iteration_verify_start" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 验证中…\n".to_string(),
        },
        "iteration_verify_pass" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 验证通过\n".to_string(),
        },
        "iteration_verify_fail" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 验证未通过，继续修复\n".to_string(),
        },
        "iteration_max_exceeded" => Rendered {
            stdout: String::new(),
            stderr: "[iteration] 已达最大迭代次数\n".to_string(),
        },
        // 其余（assistant_message_created/updated、update_message_id、user_interaction…）
        // 对无界面输出无意义
        _ => Rendered::default(),
    }
}

/// 单行预览：换行压成空格，超长截断
pub(crate) fn one_line_preview(s: &str, max_chars: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let mut out: String = flat.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// 把渲染结果写进两条流（stdout 放正文，stderr 放进度/错误）
pub(crate) fn flush_rendered(out: &mut dyn Write, err: &mut dyn Write, r: Rendered) {
    if !r.stdout.is_empty() {
        let _ = out.write_all(r.stdout.as_bytes());
        let _ = out.flush();
    }
    if !r.stderr.is_empty() {
        let _ = err.write_all(r.stderr.as_bytes());
        let _ = err.flush();
    }
}
