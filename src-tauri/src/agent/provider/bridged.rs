//! 桥接 Provider — 转发到 JS 侧已有 provider（如 Gemini），通过双向事件桥
//!
//! Rust 侧不原生实现该协议的 HTTP/SSE，而是把请求交回前端 provider 实例执行，
//! 事件再经 `ProviderBridgeMsg` 回灌（见 `docs/rust-engine.md`）。

use super::Provider;
use super::super::bridge::{AgentBridgeState, ProviderBridgeMsg};
use super::super::cancellation::CancellationToken;
use super::super::event_sink::EventSink;
use super::super::types::{ChatRequest, Message, StreamEvent};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct BridgedProvider {
    provider_type: String,
    provider_id: String,
    api_key: String,
    base_url: String,
    bridge: Arc<AgentBridgeState>,
    sink: Arc<dyn EventSink>,
}

impl BridgedProvider {
    pub fn new(
        _name: &str,
        provider_type: &str,
        provider_id: &str,
        api_key: &str,
        base_url: &str,
        bridge: Arc<AgentBridgeState>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            provider_type: provider_type.to_string(),
            provider_id: provider_id.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
            bridge,
            sink,
        }
    }

    fn request_value(&self, request: &ChatRequest) -> Value {
        json!({
            "model": request.model,
            "messages": request.messages,
            "systemPrompt": request.system_prompt,
            "tools": request.tools,
            "temperature": request.temperature,
            "topP": request.top_p,
            "maxTokens": request.max_tokens,
            "stream": request.stream,
            "tool_choice": request.tool_choice,
            "reasoningEffort": request.reasoning_effort,
        })
    }
}

#[async_trait]
impl Provider for BridgedProvider {
    async fn chat(
        &self,
        request: &ChatRequest,
        _cancel: &CancellationToken,
    ) -> Result<Message, String> {
        let request_value = self.request_value(request);
        let mut rx = self
            .bridge
            .open_provider_stream(
                self.sink.as_ref(),
                &self.provider_type,
                &self.provider_id,
                &self.api_key,
                &self.base_url,
                request_value,
                false,
            )
            .await?;

        while let Some(msg) = rx.recv().await {
            match msg {
                ProviderBridgeMsg::Done { result, error } => {
                    if let Some(err) = error {
                        return Err(err);
                    }
                    if let Some(m) = result {
                        return Ok(m);
                    }
                    return Err("Provider 未返回结果".into());
                }
                _ => {}
            }
        }
        Err("Provider 流提前关闭".into())
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
        _cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String> {
        let request_value = self.request_value(request);
        let mut rx = self
            .bridge
            .open_provider_stream(
                self.sink.as_ref(),
                &self.provider_type,
                &self.provider_id,
                &self.api_key,
                &self.base_url,
                request_value,
                true,
            )
            .await?;

        while let Some(msg) = rx.recv().await {
            match msg {
                ProviderBridgeMsg::Event(v) => {
                    if let Some(ev) = parse_bridge_stream_event(&v) {
                        on_event(ev);
                    }
                }
                ProviderBridgeMsg::Done { error, .. } => {
                    if let Some(err) = error {
                        return Err(err);
                    }
                    return Ok(());
                }
            }
        }
        Ok(())
    }
}

/// 解析 JS 侧 StreamEvent JSON → Rust StreamEvent
fn parse_bridge_stream_event(v: &Value) -> Option<StreamEvent> {
    let t = v.get("type").and_then(Value::as_str)?;
    match t {
        "text_delta" => Some(StreamEvent::TextDelta(
            v.get("data").and_then(Value::as_str).unwrap_or("").to_string(),
        )),
        "reasoning_content_change" => Some(StreamEvent::ReasoningContentChange(
            v.get("data").and_then(Value::as_str).unwrap_or("").to_string(),
        )),
        "tool_use" => v
            .get("toolUse")
            .and_then(|x| serde_json::from_value(x.clone()).ok())
            .map(StreamEvent::ToolUse),
        "message_stop" => Some(StreamEvent::MessageStop {
            reasoning_content: v.get("reasoningContent").and_then(Value::as_str).map(String::from),
            usage: v.get("usage").and_then(|u| serde_json::from_value(u.clone()).ok()),
        }),
        "error" => Some(StreamEvent::Error(
            v.get("error").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        )),
        _ => None,
    }
}
