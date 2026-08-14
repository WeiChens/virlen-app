//! 双向桥接状态 — Rust 引擎 ↔ JS 侧工具/交互/Provider
//!
//! 协议约定（与前端 `rust-engine-bridge.ts` 对应）：
//!
//! ## 工具执行（Rust → JS）
//! - Rust 发出 `agent:tool-request` { requestId, sessionId, toolCallId, toolName, args, skills }
//! - JS 执行工具后调用命令 `agent_tool_response(requestId, payload)`
//! - payload: { __kind: "value"|"error"|"interaction", value?, uiData?, message?, interactionType?, interactionData? }
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

use crate::agent::event_sink::EventSink;
use crate::agent::types::Message;
use serde::Serialize;
use std::collections::HashMap;
use tokio::sync::{mpsc, oneshot, Mutex};

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

/// Provider 桥接流消息（JS → Rust）
#[derive(Debug)]
pub enum ProviderBridgeMsg {
    Event(serde_json::Value),
    Done { result: Option<Message>, error: Option<String> },
}

/// 双向桥接状态（Tauri managed state）
#[derive(Default)]
pub struct AgentBridgeState {
    pub pending_tools: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    pub pending_interactions: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    pub pending_providers: Mutex<HashMap<String, mpsc::Sender<ProviderBridgeMsg>>>,
    /// 运行中的原生 execute_command（toolCallId → 取消令牌），支持前端 stop 按钮
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

        rx.await.map_err(|_| format!("工具请求被丢弃: {}", tool_name))
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

        rx.await.map_err(|_| format!("用户交互请求被丢弃: {}", type_))
    }

    /// 打开一个 Provider 流通道（BridgedProvider 使用）
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

        Ok(rx)
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
            .send(ProviderBridgeMsg::Done { result, error })
            .await;
    }
}

/// 将 JS 工具回执转换为统一的 Rust 侧结果
#[derive(Debug, Clone)]
pub enum BridgeToolResult {
    Value { content: String, ui_data: Option<serde_json::Value> },
    Error(String),
    Interaction { interaction_type: String, interaction_data: serde_json::Value },
}

impl BridgeToolResult {
    /// 解析 JS 工具回执 payload
    pub fn parse(payload: &serde_json::Value) -> BridgeToolResult {
        let kind = payload.get("__kind").and_then(|v| v.as_str()).unwrap_or("value");
        match kind {
            "error" => BridgeToolResult::Error(
                payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool error")
                    .to_string(),
            ),
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
    Error(String),
    Shelved,
    Cancelled,
}

impl BridgeInteractionResult {
    pub fn parse(payload: &serde_json::Value) -> BridgeInteractionResult {
        let kind = payload.get("__kind").and_then(|v| v.as_str()).unwrap_or("value");
        match kind {
            "error" => BridgeInteractionResult::Error(
                payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("interaction error")
                    .to_string(),
            ),
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
