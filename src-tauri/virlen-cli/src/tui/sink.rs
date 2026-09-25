//! TUI 的事件出口 —— 把引擎事件**结构化**送进 UI 线程（渲染交给 `view`）
//!
//! 与 `run::CliEventSink` 的差别值得写在这里：那个把事件渲染成**文本**写流，
//! 这个**原样转交**给 UI —— 因为 TUI 要自己决定「哪些进在飞区、哪些进状态行」。
//! 文件末尾三个纯函数（`input_preview` / `text_of` / `first_line`）是它的格式化助手，
//! 与它同生共死：状态行与工具行只用得上一行信息量。

use crate::tui::state::UiEvent;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use virlen_core::agent::bridge::{self, AgentBridgeState};
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::types::AgentEvent;

use super::term;

// ==================== 事件出口（结构化，不做文本渲染） ====================

/// TUI 的事件出口：把引擎事件**结构化**送进 UI 线程（渲染交给 `view`）。
///
/// 与 `run::CliEventSink` 的差别：那个把事件渲染成文本写流；这个原样转交 UI，
/// 因为 TUI 要自己决定「哪些进在飞区、哪些进状态行」。
pub(crate) struct UiEventSink {
    tx: mpsc::UnboundedSender<UiEvent>,
    bridge: Arc<AgentBridgeState>,
    /// 每条助手消息最近的 token 总数（按 messageId 去重后求和）——
    /// `assistant_message_updated` 一轮会发多次，直接累加会重复计数
    tokens: Mutex<HashMap<String, i64>>,
}

impl UiEventSink {
    pub(crate) fn new(tx: mpsc::UnboundedSender<UiEvent>, bridge: Arc<AgentBridgeState>) -> Self {
        Self {
            tx,
            bridge,
            tokens: Mutex::new(HashMap::new()),
        }
    }

    fn send(&self, ev: UiEvent) {
        let _ = self.tx.send(ev);
    }
}

impl EventSink for UiEventSink {
    fn emit_agent_event(&self, _session_id: &str, event: &AgentEvent) {
        let data = event.data.as_ref();
        match event.type_.as_str() {
            // 正文增量：唯一被打印的正文来源
            //（`assistant_message_updated` 里带同一份 contentDelta，两者都取会出现双份正文）
            "stream_event" => {
                if let Some(d) = data.and_then(|d| d.get("delta")).and_then(Value::as_str) {
                    if !d.is_empty() {
                        self.send(UiEvent::TextDelta(d.to_string()));
                    }
                }
            }
            // 收尾帧（streaming=false）才用全量内容纠正；流式帧的 content 是「已累积内容」，
            // 与随后的 delta 会重复（实测语义：先发 patch，再发 delta）
            "assistant_message_updated" => {
                let Some(patch) = data.and_then(|d| d.get("patch")) else {
                    return;
                };
                if patch.get("streaming").and_then(Value::as_bool) == Some(false) {
                    if let Some(c) = patch.get("content").and_then(Value::as_str) {
                        if !c.is_empty() {
                            self.send(UiEvent::AssistantContent(c.to_string()));
                        }
                    }
                }
                self.collect_usage(data, patch);
            }
            // 工具开始帧（结束帧带 result，结果统一由 tool_result_created 呈现）
            "tool_call" => {
                let Some(d) = data else { return };
                if d.get("result").is_some() {
                    return;
                }
                self.send(UiEvent::ToolStart {
                    id: d.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    name: d
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string(),
                    detail: input_preview(d.get("input")),
                });
            }
            "tool_result_created" => {
                let msg = data.and_then(|d| d.get("message"));
                let content = msg
                    .and_then(|m| m.get("content"))
                    .map(text_of)
                    .unwrap_or_default();
                let failed = msg
                    .and_then(|m| m.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.send(UiEvent::ToolDone {
                    ok: !failed,
                    chars: content.chars().count(),
                    preview: first_line(&content, 80),
                });
            }
            "error" => {
                self.send(UiEvent::Error(format!(
                    "[error] {}",
                    event.error.as_deref().unwrap_or("unknown error")
                )));
            }
            // 迭代验证（默认不启用，只有传 iterationGoal 时才有）
            "iteration_start" => {
                let n = data
                    .and_then(|d| d.get("iteration"))
                    .and_then(Value::as_i64)
                    .unwrap_or(1);
                self.send(UiEvent::Notice(format!("[iteration] 第 {} 轮", n)));
            }
            "iteration_verify_start" => self.send(UiEvent::Notice("[iteration] 验证中…".to_string())),
            "iteration_verify_pass" => self.send(UiEvent::Notice("[iteration] 验证通过".to_string())),
            "iteration_verify_fail" => {
                self.send(UiEvent::Notice("[iteration] 验证未通过，继续修复".to_string()))
            }
            "iteration_max_exceeded" => {
                self.send(UiEvent::Notice("[iteration] 已达最大迭代次数".to_string()))
            }
            // 其余（assistant_message_created / update_message_id / stream_end …）对界面无信息量
            _ => {}
        }
    }

    fn emit_raw(&self, event_name: &str, payload: Value) {
        match event_name {
            // 真的在问用户（命令授权 / 选择）：送进 UI 渲染，等按键回来再回执。
            // ⚠️ 这里**不能**同步阻塞读 stdin —— 那会和输入框抢同一个 stdin（`run.rs` 的做法不适用）
            "agent:user-interaction-request" => {
                let kind = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let data = payload.get("data").cloned().unwrap_or(Value::Null);
                let Some(request_id) = payload
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(String::from)
                else {
                    return;
                };
                self.send(UiEvent::Interaction {
                    request_id,
                    kind,
                    data,
                });
            }
            // 不可达的两条（工具全原生化；BridgedProvider 在装配期就拒绝）——
            // 仍然要应答：宁可给出可读失败，也不能把引擎挂住
            "agent:round-boundary" | "agent:tool-output" | "agent:tool-request"
            | "agent:provider-request" => {
                let Some(request_id) = payload
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(String::from)
                else {
                    // 实时输出带的是 toolCallId 而不是 requestId —— 用它渲染「实时输出尾部」
                    if event_name == "agent:tool-output" {
                        if let Some(chunk) = payload.get("chunk").and_then(Value::as_str) {
                            self.send(UiEvent::ToolOutput {
                                chunk: chunk.to_string(),
                            });
                        }
                    }
                    return;
                };
                let bridge = self.bridge.clone();
                let name = event_name.to_string();
                let tool_name = payload
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let spawned = tokio::runtime::Handle::try_current().map(|h| {
                    h.spawn(async move {
                        match name.as_str() {
                            "agent:round-boundary" => {
                                bridge::handle_round_boundary_response(
                                    &bridge,
                                    &request_id,
                                    json!({ "messages": [] }),
                                )
                                .await;
                            }
                            "agent:tool-request" => {
                                bridge::handle_tool_response(
                                    &bridge,
                                    &request_id,
                                    json!({
                                        "__kind": "error",
                                        "message": format!(
                                            "CLI has no JS runtime: tool `{}` is not natively implemented",
                                            tool_name
                                        ),
                                    }),
                                )
                                .await;
                            }
                            _ => {
                                bridge::handle_provider_stream_done(
                                    &bridge,
                                    &request_id,
                                    None,
                                    Some(
                                        "CLI has no JS runtime: provider requires the JS bridge"
                                            .to_string(),
                                    ),
                                )
                                .await;
                            }
                        }
                    })
                });
                if spawned.is_err() {
                    term::log(&format!(
                        "桥请求 {} 无法回执（不在 tokio 运行时里）",
                        event_name
                    ));
                }
            }
            _ => {}
        }
    }
}

impl UiEventSink {
    /// 采集 token 用量：`patch.usage` 按 messageId 去重后求和
    fn collect_usage(&self, data: Option<&Value>, patch: &Value) {
        let Some(msg_id) = data.and_then(|d| d.get("messageId")).and_then(Value::as_str) else {
            return;
        };
        let Some(usage) = patch.get("usage") else {
            return;
        };
        let total = usage
            .get("totalTokens")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| {
                usage
                    .get("promptTokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    + usage
                        .get("completionTokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
            });
        if total <= 0 {
            return;
        }
        let mut map = match self.tokens.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        map.insert(msg_id.to_string(), total);
        let sum: i64 = map.values().sum();
        drop(map);
        self.send(UiEvent::Usage { total: sum });
    }
}

/// 工具入参的短预览（状态行/工具行只显示一行的信息量）
pub(crate) fn input_preview(input: Option<&Value>) -> String {
    let Some(v) = input else {
        return String::new();
    };
    let obj = match v.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    // 优先挑「最像命令/路径」的字段，与桌面端工具行的观感一致
    for key in ["command", "path", "query", "url", "pattern", "name"] {
        if let Some(s) = obj.get(key).and_then(Value::as_str) {
            return first_line(s, 60);
        }
    }
    if let Some(arr) = obj.get("paths").and_then(Value::as_array) {
        if let Some(s) = arr.first().and_then(Value::as_str) {
            return first_line(s, 60);
        }
    }
    // 兜底：第一个字符串值
    for v in obj.values() {
        if let Some(s) = v.as_str() {
            if !s.is_empty() {
                return first_line(s, 60);
            }
        }
    }
    String::new()
}

/// 消息内容 → 纯文本（string 或 text block 数组；与引擎侧同一口径）
pub(crate) fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    b.get("text").and_then(Value::as_str).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// 取首行并截断（预览绝不带换行，否则会把动态区顶掉）
pub(crate) fn first_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max).collect();
    out.push('…');
    out
}
