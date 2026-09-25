//! 事件出口 `CliEventSink` —— 渲染成文本推给输出循环，并在原地应答桥请求
//!
//! 为什么单独一个文件：它是 `EventSink` 的**唯一实现**，把「引擎事件 → 文本」与
//! 「桥请求 → 应答」两件事收在一处；驱动（`run`）只负责在通道另一头写流。

use virlen_core::agent::bridge::{self, AgentBridgeState};
use virlen_core::agent::event_sink::EventSink;
use virlen_core::agent::types::AgentEvent;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use super::ask::ask_user;
use super::render::{render_event, RenderState, Rendered};

// ==================== 事件出口 ====================

/// CLI 事件出口：渲染成文本后经无界通道交给输出循环写流；
/// 桥请求（交互 / 轮次边界 / 未原生化的工具与 Provider）在这里就地应答。
///
/// `pub(crate)`：`chat` 的**顺序输出模式**（无 TTY / 降级）复用它 ——
/// 同一份「引擎事件 → 文本」的渲染逻辑，不在第二个入口里再实现一遍。
pub(crate) struct CliEventSink {
    bridge: Arc<AgentBridgeState>,
    tx: mpsc::UnboundedSender<Rendered>,
    json: bool,
    interactive: bool,
    state: Mutex<RenderState>,
}

impl CliEventSink {
    pub(crate) fn new(
        bridge: Arc<AgentBridgeState>,
        tx: mpsc::UnboundedSender<Rendered>,
        json: bool,
        interactive: bool,
    ) -> Self {
        Self {
            bridge,
            tx,
            json,
            interactive,
            state: Mutex::new(RenderState::default()),
        }
    }

    /// 在 runtime 里异步执行一个桥回执（emit 是同步函数，不能 await）
    fn spawn_reply<F>(&self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(future);
        }
    }
}

impl EventSink for CliEventSink {
    fn emit_agent_event(&self, _session_id: &str, event: &AgentEvent) {
        let rendered = {
            let mut state = self.state.lock().unwrap();
            render_event(event, self.json, &mut state)
        };
        if !rendered.is_empty() {
            let _ = self.tx.send(rendered);
        }
    }

    fn emit_raw(&self, event_name: &str, payload: serde_json::Value) {
        let Some(request_id) = payload
            .get("requestId")
            .and_then(Value::as_str)
            .map(String::from)
        else {
            return;
        };

        match event_name {
            // 真的在问用户（命令授权 / 选择）：提示 + 读 stdin（阻塞放 blocking 池）
            "agent:user-interaction-request" => {
                let kind = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let data = payload.get("data").cloned().unwrap_or(Value::Null);
                let bridge = self.bridge.clone();
                let interactive = self.interactive;
                self.spawn_reply(async move {
                    let answer = tokio::task::spawn_blocking(move || {
                        let stdin = std::io::stdin();
                        let mut lock = stdin.lock();
                        ask_user(&kind, &data, interactive, &mut lock)
                    })
                    .await
                    .unwrap_or_else(|_| json!({ "__kind": "cancelled" }));
                    bridge::handle_user_interaction_response(&bridge, &request_id, answer).await;
                });
            }
            // 轮次边界注入：CLI 没有「回复期间用户改清单」这种来源 → 空注入。
            // 必须回，否则引擎要等 5s 超时（`ROUND_BOUNDARY_TIMEOUT`）。
            "agent:round-boundary" => {
                let bridge = self.bridge.clone();
                self.spawn_reply(async move {
                    bridge::handle_round_boundary_response(
                        &bridge,
                        &request_id,
                        json!({ "messages": [] }),
                    )
                    .await;
                });
            }
            // 以下两类在 CLI 里都不该发生（工具全原生化；BridgedProvider 已在装配期拒绝）。
            // 仍然应答：宁可给出可读失败，也不要挂起。
            "agent:tool-request" => {
                let tool_name = payload
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                eprintln!(
                    "[bridge] 工具 `{}` 未原生化，CLI 无 JS 执行环境 → 失败",
                    tool_name
                );
                let bridge = self.bridge.clone();
                self.spawn_reply(async move {
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
                });
            }
            "agent:provider-request" => {
                eprintln!("[bridge] 该 Provider 需要前端 JS 桥，CLI 不支持 → 失败");
                let bridge = self.bridge.clone();
                self.spawn_reply(async move {
                    bridge::handle_provider_stream_done(
                        &bridge,
                        &request_id,
                        None,
                        Some("CLI has no JS runtime: provider requires the JS bridge".to_string()),
                    )
                    .await;
                });
            }
            // `agent:tool-output`（PTY 实时输出）：CLI 不逐块打印，只在工具结束时给摘要，
            // 避免与正文交错成噪音。需要实时进度时看桌面端。
            _ => {}
        }
    }
}
