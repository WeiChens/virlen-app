//! 双向桥接状态 — Rust 引擎 ↔ JS 侧工具/交互/Provider
//!
//! 协议约定（与前端 `rust-engine-bridge.ts` 对应）：
//!
//! ## 工具执行（Rust → JS）
//! - Rust 发出 `agent:tool-request` { requestId, sessionId, toolCallId, toolName, args, skills }
//! - JS 执行工具后调用命令 `agent_tool_response(requestId, payload)`
//! - payload: { __kind: "value"|"error"|"interaction", value?, uiData?, message?, interactionType?, interactionData? }
//!   ⚠️ `__kind: "error"` 也允许携带 `uiData`：失败文案同样是「模型侧英文 + UI 侧结构化」
//!   两用，UI 靠 `uiData` 按界面语言重建，否则只能直显英文报告。
//!
//! ## 用户交互（Rust → JS）
//! - Rust 发出 `agent:user-interaction-request` { requestId, type, data }
//! - JS 处理弹窗后调用命令 `agent_user_interaction_response(requestId, payload)`
//! - payload: { __kind: "value"|"error"|"shelved"|"cancelled", value?, uiData?, message? }
//!
//! ## Provider 流（Rust → JS，仅 BridgedProvider 使用）
//! - Rust 发出 `agent:provider-request` { requestId, providerType, providerId, apiKey, baseUrl, request, stream }
//! - JS 流式回调中调用 `agent_provider_stream_event(requestId, event)`，结束后调用
//!   `agent_provider_stream_done(requestId, result?, error?)`
//! - 非流式：result = Message JSON；流式：result = null（事件已逐条送达）
//!
//! ## 轮次边界注入（Rust → JS）
//! - Rust 在「上一批工具已回复、下一次 LLM 请求尚未发出」时发出
//!   `agent:round-boundary` { requestId, sessionId }
//! - JS 回 `agent_round_boundary_response(requestId, payload)`，
//!   payload: { messages: Message[] }（无注入时为空数组）
//! - 用途：用户在 AI 回复期间「应用」的任务清单变更，必须在下一次请求之前进入消息列表，
//!   模型才能在这一轮里看到；否则要等整个循环结束、用户再说一句话才生效。

use crate::agent::event_sink::EventSink;
use crate::agent::types::Message;
use crate::session_db::SessionRepo;
use serde::Serialize;
use std::collections::HashMap;
use tokio::sync::{mpsc, oneshot, Mutex};

/// 轮次边界回执超时 —— JS 侧没装监听器（前端版本不匹配）时不能拖死整个 agent 循环
const ROUND_BOUNDARY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(5000);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequestPayload {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInteractionRequestPayload {
    pub request_id: String,
    pub session_id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub data: serde_json::Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequestPayload {
    pub request_id: String,
    pub provider_type: String,
    pub provider_id: String,
    pub api_key: String,
    pub base_url: String,
    pub request: serde_json::Value,
    pub stream: bool,
}

/// 轮次边界注入请求（Rust → JS）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundBoundaryRequestPayload {
    pub request_id: String,
    pub session_id: String,
}

/// Provider 桥接流消息（JS → Rust）
#[derive(Debug)]
pub enum ProviderBridgeMsg {
    /// 流式增量（热路径：每个 token 一条）—— `Value` 小，是枚举尺寸的基准
    Event(serde_json::Value),
    /// 结束（每轮一条）—— `Message` 结构体大（>300B），故 **装箱** 以免把整个枚举
    /// （含热路径的 `Event`）撑到 `Message` 的尺寸。
    Done {
        result: Box<Option<Message>>,
        error: Option<String>,
    },
}

/// 双向桥接状态（Tauri managed state）
#[derive(Default)]
pub struct AgentBridgeState {
    pub pending_tools: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    pub pending_interactions: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    pub pending_providers: Mutex<HashMap<String, mpsc::Sender<ProviderBridgeMsg>>>,
    /// 轮次边界请求（Rust → JS，等待回执）
    pub pending_round_boundaries: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    /// 运行中的原生 execute_command（toolCallId → 取消令牌），支持前端 stop 按钮
    #[allow(dead_code)]
    pub running_commands: Mutex<HashMap<String, crate::agent::cancellation::CancellationToken>>,
}

impl AgentBridgeState {
    /// 请求 JS 执行一个工具，等待回执
    pub async fn request_tool(
        &self,
        sink: &dyn EventSink,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        args: serde_json::Value,
        skills: Option<Vec<String>>,
    ) -> Result<serde_json::Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_tools.lock().await.insert(request_id.clone(), tx);

        let payload = ToolRequestPayload {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            args,
            skills,
        };
        sink.emit_raw(
            "agent:tool-request",
            serde_json::to_value(&payload).map_err(|e| e.to_string())?,
        );

        let started = crate::telemetry::now_ms();
        crate::telemetry::track(
            "rust.bridge.request",
            serde_json::json!({ "kind": "tool-request", "request_id": request_id.as_str() }),
        );
        let outcome = rx.await;
        crate::telemetry::track(
            "rust.bridge.response",
            serde_json::json!({
                "kind": "tool-request",
                "request_id": request_id.as_str(),
                "duration_ms": crate::telemetry::now_ms() - started,
                "status": if outcome.is_ok() { "success" } else { "fail" },
            }),
        );
        outcome.map_err(|_| format!("Tool request was dropped: {}", tool_name))
    }

    /// 请求 JS 处理用户交互，等待回执
    pub async fn request_user_interaction(
        &self,
        sink: &dyn EventSink,
        session_id: &str,
        type_: &str,
        data: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_interactions
            .lock()
            .await
            .insert(request_id.clone(), tx);

        let payload = UserInteractionRequestPayload {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            type_: type_.to_string(),
            data,
        };
        sink.emit_raw(
            "agent:user-interaction-request",
            serde_json::to_value(&payload).map_err(|e| e.to_string())?,
        );

        let started = crate::telemetry::now_ms();
        crate::telemetry::track(
            "rust.bridge.request",
            serde_json::json!({ "kind": "user-interaction", "request_id": request_id.as_str() }),
        );
        let outcome = rx.await;
        crate::telemetry::track(
            "rust.bridge.response",
            serde_json::json!({
                "kind": "user-interaction",
                "request_id": request_id.as_str(),
                "duration_ms": crate::telemetry::now_ms() - started,
                "status": if outcome.is_ok() { "success" } else { "fail" },
            }),
        );
        outcome.map_err(|_| format!("User-interaction request was dropped: {}", type_))
    }

    /// 打开一个 Provider 流通道（BridgedProvider 使用）
    ///
    /// `#[allow(too_many_arguments)]`：每个参数都是独立的桥协议字段，收成结构体只是换个
    /// 地方写，不增加任何约束力。
    #[allow(clippy::too_many_arguments)]
    pub async fn open_provider_stream(
        &self,
        sink: &dyn EventSink,
        provider_type: &str,
        provider_id: &str,
        api_key: &str,
        base_url: &str,
        request: serde_json::Value,
        stream: bool,
    ) -> Result<mpsc::Receiver<ProviderBridgeMsg>, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel(64);
        self.pending_providers
            .lock()
            .await
            .insert(request_id.clone(), tx);

        let payload = ProviderRequestPayload {
            request_id: request_id.clone(),
            provider_type: provider_type.to_string(),
            provider_id: provider_id.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
            request,
            stream,
        };
        sink.emit_raw(
            "agent:provider-request",
            serde_json::to_value(&payload).map_err(|e| e.to_string())?,
        );

        crate::telemetry::track(
            "rust.bridge.request",
            serde_json::json!({ "kind": "provider", "request_id": request_id.as_str() }),
        );

        Ok(rx)
    }

    /// 请求 JS 在轮次边界注入消息（工具回复后、下一次 LLM 请求前），等待回执
    ///
    /// ⚠️ 必须带超时：JS 侧若没装监听器（前端版本不匹配）就永远不会回执，不兜底会让整个
    /// agent 循环卡在这一步。
    pub async fn request_round_boundary(
        &self,
        sink: &dyn EventSink,
        session_id: &str,
    ) -> Result<serde_json::Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_round_boundaries
            .lock()
            .await
            .insert(request_id.clone(), tx);

        let payload = RoundBoundaryRequestPayload {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
        };
        sink.emit_raw(
            "agent:round-boundary",
            serde_json::to_value(&payload).map_err(|e| e.to_string())?,
        );

        let outcome = tokio::time::timeout(ROUND_BOUNDARY_TIMEOUT, rx).await;
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err("Round-boundary request was dropped".to_string()),
            Err(_) => {
                // 超时：主动摘下挂起槽位，避免 JS 迟到的回执写进已无用的通道
                self.pending_round_boundaries.lock().await.remove(&request_id);
                Err("Round-boundary request timed out".to_string())
            }
        }
    }
}

// ==================== 回执处理（Tauri 命令调用） ====================

pub async fn handle_tool_response(
    state: &AgentBridgeState,
    request_id: &str,
    payload: serde_json::Value,
) {
    if let Some(tx) = state.pending_tools.lock().await.remove(request_id) {
        let _ = tx.send(payload);
    }
}

pub async fn handle_user_interaction_response(
    state: &AgentBridgeState,
    request_id: &str,
    payload: serde_json::Value,
) {
    if let Some(tx) = state.pending_interactions.lock().await.remove(request_id) {
        let _ = tx.send(payload);
    }
}

pub async fn handle_provider_stream_event(
    state: &AgentBridgeState,
    request_id: &str,
    event: serde_json::Value,
) {
    if let Some(tx) = state.pending_providers.lock().await.get(request_id) {
        let _ = tx.send(ProviderBridgeMsg::Event(event)).await;
    }
}

pub async fn handle_provider_stream_done(
    state: &AgentBridgeState,
    request_id: &str,
    result: Option<Message>,
    error: Option<String>,
) {
    if let Some(tx) = state.pending_providers.lock().await.remove(request_id) {
        let _ = tx
            .send(ProviderBridgeMsg::Done {
                result: Box::new(result),
                error,
            })
            .await;
    }
}

/// JS 轮次边界回执（要注入本轮消息列表的消息，无则空数组）
pub async fn handle_round_boundary_response(
    state: &AgentBridgeState,
    request_id: &str,
    payload: serde_json::Value,
) {
    if let Some(tx) = state.pending_round_boundaries.lock().await.remove(request_id) {
        let _ = tx.send(payload);
    }
}

// ==================== 轮次边界注入 ====================

/// 轮次边界注入（工具回复后、下一次 LLM 请求发出前调用）
///
/// 向 JS 索取「AI 回复期间用户已应用的任务清单变更」等消息，追加进 `messages`，让紧接着的
/// 那次请求就能看到 —— 而不是等整个 agent 循环结束、用户再说一句话才生效。
///
/// ⚠️ 任何失败（超时 / 解析失败 / 写库失败）都降级为「不注入」：只丢一次提前生效的机会，
/// 绝不影响本轮执行。与前端监听回调同语义（铁律 1），只是 Rust 侧多一次 IPC 往返
/// （消息列表在 Rust 内存里，前端无法直接改）。
pub async fn inject_round_boundary_messages(
    state: &AgentBridgeState,
    sink: &dyn EventSink,
    repo: &dyn SessionRepo,
    session_id: &str,
    messages: &mut Vec<Message>,
) {
    let payload = match state.request_round_boundary(sink, session_id).await {
        Ok(p) => p,
        Err(_) => return,
    };
    let injected = parse_round_boundary_messages(&payload);
    if injected.is_empty() {
        return;
    }
    // JS 侧已落库一次（messages.id 主键 + `ON CONFLICT DO UPDATE`，幂等），
    // 这里再落一次是兜底：保证「进入本轮上下文」与「在库里」两件事同时成立。
    if let Err(e) = repo.append_messages_if_alive(session_id, &injected).await {
        eprintln!("[session_db] 写入轮次边界注入消息失败: {}", e);
    }
    messages.extend(injected);
}

/// 解析 JS 回执 → 要注入的消息列表（非法项直接跳过）
pub fn parse_round_boundary_messages(payload: &serde_json::Value) -> Vec<Message> {
    let Some(arr) = payload.get("messages").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| serde_json::from_value::<Message>(v.clone()).ok())
        .collect()
}

/// 将 JS 工具回执转换为统一的 Rust 侧结果
#[derive(Debug, Clone)]
pub enum BridgeToolResult {
    Value { content: String, ui_data: Option<serde_json::Value> },
    /// 失败：`content` = 模型侧固定英文；`ui_data` = 可选结构化描述（供 UI 按界面语言重建）
    Error { content: String, ui_data: Option<serde_json::Value> },
    Interaction { interaction_type: String, interaction_data: serde_json::Value },
}

impl BridgeToolResult {
    /// 解析 JS 工具回执 payload
    pub fn parse(payload: &serde_json::Value) -> BridgeToolResult {
        let kind = payload.get("__kind").and_then(|v| v.as_str()).unwrap_or("value");
        match kind {
            "error" => BridgeToolResult::Error {
                content: payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool error")
                    .to_string(),
                ui_data: payload.get("uiData").cloned().filter(|v| !v.is_null()),
            },
            "interaction" => BridgeToolResult::Interaction {
                interaction_type: payload
                    .get("interactionType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                interaction_data: payload.get("interactionData").cloned().unwrap_or_default(),
            },
            _ => BridgeToolResult::Value {
                content: payload
                    .get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                ui_data: payload.get("uiData").cloned().filter(|v| !v.is_null()),
            },
        }
    }
}

/// 将 JS 用户交互回执转换为统一结果
#[derive(Debug, Clone)]
pub enum BridgeInteractionResult {
    Value { content: String, ui_data: Option<serde_json::Value> },
    /// 失败：同 `BridgeToolResult::Error`（`ui_data` 可选）
    Error { content: String, ui_data: Option<serde_json::Value> },
    Shelved,
    Cancelled,
}

impl BridgeInteractionResult {
    pub fn parse(payload: &serde_json::Value) -> BridgeInteractionResult {
        let kind = payload.get("__kind").and_then(|v| v.as_str()).unwrap_or("value");
        match kind {
            "error" => BridgeInteractionResult::Error {
                content: payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("interaction error")
                    .to_string(),
                ui_data: payload.get("uiData").cloned().filter(|v| !v.is_null()),
            },
            "shelved" => BridgeInteractionResult::Shelved,
            "cancelled" => BridgeInteractionResult::Cancelled,
            _ => BridgeInteractionResult::Value {
                content: payload
                    .get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                ui_data: payload.get("uiData").cloned().filter(|v| !v.is_null()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_round_boundary_messages_skips_invalid_items() {
        let payload = json!({
            "messages": [
                { "id": "m1", "role": "feedback", "content": "【用户更新了任务清单】", "timestamp": 1 },
                { "bogus": true },
                "not-an-object"
            ]
        });
        let msgs = parse_round_boundary_messages(&payload);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[0].role, "feedback");
    }

    #[test]
    fn parse_round_boundary_messages_tolerates_missing_field() {
        assert!(parse_round_boundary_messages(&json!({})).is_empty());
        assert!(parse_round_boundary_messages(&json!({ "messages": null })).is_empty());
        assert!(parse_round_boundary_messages(&json!({ "messages": [] })).is_empty());
    }

    /// D2 的失败侧：`__kind: "error"` 也能带 `uiData`
    /// （UI 按界面语言重建，而不是把模型侧英文报告直接贴给用户，见遗留项 L6）
    #[test]
    fn parse_error_payload_carries_ui_data() {
        let parsed = BridgeToolResult::parse(&json!({
            "__kind": "error",
            "message": "Exit code: 2",
            "uiData": { "exitCode": 2, "stdout": "", "stderr": "" },
        }));
        match parsed {
            BridgeToolResult::Error { content, ui_data } => {
                assert_eq!(content, "Exit code: 2");
                assert_eq!(ui_data.expect("uiData 应保留")["exitCode"], json!(2));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_error_payload_without_ui_data_is_tolerated() {
        let parsed = BridgeToolResult::parse(&json!({ "__kind": "error", "message": "boom" }));
        match parsed {
            BridgeToolResult::Error { content, ui_data } => {
                assert_eq!(content, "boom");
                assert!(ui_data.is_none());
            }
            other => panic!("expected Error, got {other:?}"),
        }
        // `uiData: null` 与缺失等价
        let parsed = BridgeToolResult::parse(&json!({
            "__kind": "error",
            "message": "boom",
            "uiData": null,
        }));
        match parsed {
            BridgeToolResult::Error { ui_data, .. } => assert!(ui_data.is_none()),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_interaction_error_payload_carries_ui_data() {
        let parsed = BridgeInteractionResult::parse(&json!({
            "__kind": "error",
            "message": "denied",
            "uiData": { "noteKind": "deleted" },
        }));
        match parsed {
            BridgeInteractionResult::Error { content, ui_data } => {
                assert_eq!(content, "denied");
                assert_eq!(ui_data.expect("uiData 应保留")["noteKind"], json!("deleted"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }
}
