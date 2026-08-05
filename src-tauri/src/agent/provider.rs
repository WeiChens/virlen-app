//! Provider 层 — 原生 HTTP 实现 + JS 桥接实现
//!
//! - `NativeOpenAiProvider`：OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / Ollama / 自定义）
//! - `NativeAnthropicProvider`：Anthropic Messages API
//! - `BridgedProvider`：转发到 JS 侧已有 provider（如 Gemini），通过双向事件桥

use super::bridge::{AgentBridgeState, ProviderBridgeMsg};
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::types::{ChatRequest, Message, StreamEvent, TokenUsage, ToolUseContent};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

// ==================== Provider trait ====================

#[async_trait]
pub trait Provider: Send + Sync {
    async fn chat(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Message, String>;
    async fn chat_stream(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String>;
}

// ==================== 通用工具 ====================

/// 找到最后一个 summary 消息的下标（返回其后的消息参与请求）
fn last_summary_index(messages: &[Message]) -> usize {
    let mut index = messages.len();
    for (i, m) in messages.iter().enumerate() {
        if m.role == "summary" {
            index = i;
        }
    }
    // TS: index === -1 ? all : slice(lastSummaryMessageIndex)
    if index == messages.len() {
        0
    } else {
        index
    }
}

fn slice_messages<'a>(messages: &'a [Message]) -> &'a [Message] {
    let start = last_summary_index(messages);
    if start == 0 {
        messages
    } else {
        &messages[start..]
    }
}

/// 将消息 content 序列化为 JSON（兼容 string / blocks）
fn content_to_value(m: &Message) -> Value {
    m.content.clone()
}

fn text_of_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        _ => serde_json::to_string(content).unwrap_or_default(),
    }
}

// ==================== OpenAI 兼容 Provider ====================

pub struct NativeOpenAiProvider {
    api_key: String,
    base_url: String,
    http: reqwest::Client,
}

impl NativeOpenAiProvider {
    pub fn new(_name: &str, api_key: &str, base_url: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        h.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.api_key))
                .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")),
        );
        h
    }

    /// 构建 OpenAI 兼容请求体（移植 openai.ts buildRequest）
    fn build_request(&self, request: &ChatRequest) -> Value {
        let mut messages: Vec<Value> = Vec::new();

        if let Some(sp) = &request.system_prompt {
            messages.push(json!({ "role": "system", "content": sp }));
        }

        let request_messages = slice_messages(&request.messages);
        for msg in request_messages {
            // summary / feedback 角色：转为 user 消息
            if msg.role == "summary" || msg.role == "feedback" {
                messages.push(json!({
                    "role": "user",
                    "content": text_of_content(&msg.content),
                }));
                continue;
            }

            let mut formatted = serde_json::Map::new();
            formatted.insert("role".into(), Value::String(msg.role.clone()));
            formatted.insert("content".into(), content_to_value(msg));

            // 视觉分析优化字段暂不处理（桥接 JS 时由 JS 侧处理）

            if let Some(tcs) = &msg.tool_calls {
                if !tcs.is_empty() {
                    let arr: Vec<Value> = tcs
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": serde_json::to_string(&tc.input).unwrap_or_default(),
                                }
                            })
                        })
                        .collect();
                    formatted.insert("tool_calls".into(), Value::Array(arr));
                }
            }

            if msg.role == "assistant" {
                if let Some(rc) = &msg.reasoning_content {
                    formatted.insert("reasoning_content".into(), Value::String(rc.clone()));
                }
            }

            if let Some(tcid) = &msg.tool_call_id {
                formatted.insert("tool_call_id".into(), Value::String(tcid.clone()));
            }

            messages.push(Value::Object(formatted));
        }

        let mut body = json!({
            "model": request.model,
            "messages": messages,
            "temperature": request.temperature,
            "top_p": request.top_p,
            "max_tokens": request.max_tokens,
            "stream": request.stream,
        });

        if !request.tools.is_empty() {
            let tools: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
            body["tools"] = Value::Array(tools);
        }
        if !request.tool_choice.is_empty() {
            body["tool_choice"] = Value::String(request.tool_choice.clone());
        }
        if let Some(re) = &request.reasoning_effort {
            body["reasoning_effort"] = Value::String(re.clone());
        }

        body
    }

    /// 解析非流式响应（移植 openai.ts parseResponse）
    fn parse_response(&self, data: &Value) -> Message {
        let choice = data
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .cloned()
            .unwrap_or_default();
        let msg = choice.get("message").or_else(|| choice.get("delta")).cloned().unwrap_or_default();

        let mut message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: "assistant".to_string(),
            content: msg.get("content").and_then(Value::as_str).unwrap_or("").into(),
            tool_calls: None,
            reasoning_content: None,
            tool_call_id: None,
            is_error: None,
            elapsed_ms: None,
            reasoning_elapsed_ms: None,
            ui_data: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            streaming: None,
            model: None,
            usage: None,
            image_vision_analyze_optimize: None,
            image_vision_analyze_result: None,
        };

        if let Some(tcs) = msg.get("tool_calls").and_then(Value::as_array) {
            if !tcs.is_empty() {
                let parsed: Vec<ToolUseContent> = tcs
                    .iter()
                    .filter_map(|tc| {
                        let id = tc.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        let name = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let args = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(Value::as_str)
                            .unwrap_or("{}");
                        let input = serde_json::from_str(args).unwrap_or(Value::Null);
                        Some(ToolUseContent {
                            type_: "tool_use".into(),
                            id,
                            name,
                            input,
                        })
                    })
                    .collect();
                message.tool_calls = Some(parsed);
            }
        }

        if let Some(usage) = data.get("usage") {
            message.usage = Some(TokenUsage {
                prompt_tokens: usage.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0),
                completion_tokens: usage.get("completion_tokens").and_then(Value::as_i64).unwrap_or(0),
                total_tokens: usage.get("total_tokens").and_then(Value::as_i64).unwrap_or(0),
            });
        }

        if let Some(rc) = msg.get("reasoning_content").and_then(Value::as_str) {
            if !rc.is_empty() {
                message.reasoning_content = Some(rc.to_string());
            }
        }

        message
    }
}

#[async_trait]
impl Provider for NativeOpenAiProvider {
    async fn chat(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Message, String> {
        let body = self.build_request(request);
        let url = format!("{}/chat/completions", self.base_url);

        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            r = self.http.post(&url).headers(self.headers()).json(&body).send() => r.map_err(|e| format!("API Error: {}", e))?,
        };

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }
        let data: Value =
            serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {}", e))?;
        Ok(self.parse_response(&data))
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String> {
        let mut body = self.build_request(request);
        body["stream"] = Value::Bool(true);
        let url = format!("{}/chat/completions", self.base_url);

        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            r = self.http.post(&url).headers(self.headers()).json(&body).send() => r.map_err(|e| format!("API Error: {}", e))?,
        };
        let status = resp.status();
        if !status.is_success() {
            let text = resp
                .text()
                .await
                .map_err(|e| format!("读取错误响应失败: {}", e))?;
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }

        let mut reasoning_content = String::new();
        let mut last_usage: Option<TokenUsage> = None;
        // index → (id, name, arguments)
        let mut tool_acc: std::collections::HashMap<usize, (String, String, String)> =
            std::collections::HashMap::new();
        let mut tool_fired = false;

        let result = super::provider::read_sse_lines(resp, cancel, &mut |line: String| {
            let trimmed = line.trim();
            if !trimmed.starts_with("data:") {
                return true;
            }
            let data_str = trimmed[5..].trim().to_string();
            if data_str == "[DONE]" {
                on_event(StreamEvent::MessageStop {
                    reasoning_content: if reasoning_content.is_empty() {
                        None
                    } else {
                        Some(reasoning_content.clone())
                    },
                    usage: last_usage.clone(),
                });
                return true;
            }
            let chunk: Value = match serde_json::from_str(&data_str) {
                Ok(v) => v,
                Err(_) => return true,
            };
            let delta = chunk
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|c| c.get("delta"));

            if let Some(delta) = delta {
                if let Some(content) = delta.get("content").and_then(Value::as_str) {
                    on_event(StreamEvent::TextDelta(content.to_string()));
                }
                if let Some(rc) = delta.get("reasoning_content").and_then(Value::as_str) {
                    reasoning_content.push_str(rc);
                    on_event(StreamEvent::ReasoningContentChange(reasoning_content.clone()));
                }
                if let Some(tcs) = delta.get("tool_calls").and_then(Value::as_array) {
                    for tc in tcs {
                        let idx = tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let entry = tool_acc
                            .entry(idx)
                            .or_insert_with(|| (String::new(), String::new(), String::new()));
                        if let Some(id) = tc.get("id").and_then(Value::as_str) {
                            entry.0 = id.to_string();
                        }
                        if let Some(name) = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                        {
                            entry.1 = name.to_string();
                        }
                        if let Some(args) = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(Value::as_str)
                        {
                            entry.2.push_str(args);
                        }
                    }
                }
            }

            if let Some(usage) = chunk.get("usage") {
                last_usage = Some(TokenUsage {
                    prompt_tokens: usage.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0),
                    completion_tokens: usage.get("completion_tokens").and_then(Value::as_i64).unwrap_or(0),
                    total_tokens: usage.get("total_tokens").and_then(Value::as_i64).unwrap_or(0),
                });
            }

            // finish_reason === tool_calls
            if !tool_fired {
                let finish = chunk
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|c| c.get("finish_reason"))
                    .and_then(Value::as_str);
                if finish == Some("tool_calls") {
                    tool_fired = true;
                    let mut items: Vec<(usize, (String, String, String))> =
                        tool_acc.drain().collect();
                    items.sort_by_key(|(idx, _)| *idx);
                    for (_, (id, name, args)) in items {
                        let input = serde_json::from_str(&args).unwrap_or(Value::Null);
                        on_event(StreamEvent::ToolUse(ToolUseContent {
                            type_: "tool_use".into(),
                            id,
                            name,
                            input,
                        }));
                    }
                }
            }
            true
        })
        .await;

        result
    }
}

// ==================== Anthropic Provider ====================

pub struct NativeAnthropicProvider {
    api_key: String,
    base_url: String,
    http: reqwest::Client,
}

impl NativeAnthropicProvider {
    pub fn new(_name: &str, api_key: &str, base_url: &str) -> Self {
        let base = if base_url.is_empty() {
            "https://api.anthropic.com/v1"
        } else {
            base_url
        };
        Self {
            api_key: api_key.to_string(),
            base_url: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    fn headers(&self) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        h.insert(
            "x-api-key",
            reqwest::header::HeaderValue::from_str(&self.api_key)
                .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")),
        );
        h.insert(
            "anthropic-version",
            reqwest::header::HeaderValue::from_static("2023-06-01"),
        );
        h
    }

    /// 构建 Anthropic 请求体（移植 anthropic.ts buildRequest）
    fn build_request(&self, request: &ChatRequest) -> Value {
        let mut messages: Vec<Value> = Vec::new();
        let system = request.system_prompt.clone().unwrap_or_default();

        let request_messages = slice_messages(&request.messages);
        for msg in request_messages {
            if msg.role == "summary" || msg.role == "feedback" {
                messages.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": text_of_content(&msg.content),
                    }],
                }));
                continue;
            }

            if msg.role == "assistant" {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(rc) = &msg.reasoning_content {
                    if !rc.is_empty() {
                        blocks.push(json!({ "type": "thinking", "thinking": rc }));
                    }
                }
                if let Value::String(s) = &msg.content {
                    if !s.is_empty() {
                        blocks.push(json!({ "type": "text", "text": s }));
                    }
                }
                if let Some(tcs) = &msg.tool_calls {
                    for tc in tcs {
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.input,
                        }));
                    }
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                messages.push(json!({ "role": "assistant", "content": blocks }));
                continue;
            }

            if msg.role == "tool" {
                let tool_result_block = json!({
                    "type": "tool_result",
                    "tool_use_id": msg.tool_call_id.clone().unwrap_or_default(),
                    "content": text_of_content(&msg.content),
                    "is_error": msg.is_error.unwrap_or(false),
                });
                // 若上一条是 tool_result user 消息则追加
                if let Some(last) = messages.last_mut() {
                    let is_tool_result_user = last.get("role").and_then(Value::as_str) == Some("user")
                        && last
                            .get("content")
                            .and_then(Value::as_array)
                            .and_then(|a| a.first())
                            .and_then(|b| b.get("type"))
                            .and_then(Value::as_str)
                            == Some("tool_result");
                    if is_tool_result_user {
                        if let Some(arr) = last.get_mut("content").and_then(|v| v.as_array_mut()) {
                            arr.push(tool_result_block);
                        }
                        continue;
                    }
                }
                messages.push(json!({ "role": "user", "content": [tool_result_block] }));
                continue;
            }

            // user message
            let mut blocks: Vec<Value> = Vec::new();
            match &msg.content {
                Value::String(s) => blocks.push(json!({ "type": "text", "text": s })),
                Value::Array(arr) => {
                    for block in arr {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => blocks.push(json!({
                                "type": "text",
                                "text": block.get("text").and_then(Value::as_str).unwrap_or(""),
                            })),
                            Some("image_url") => {
                                let url = block
                                    .get("image_url")
                                    .and_then(|i| i.get("url"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if let Some(rest) = url.strip_prefix("data:") {
                                    let data = rest.split(',').nth(1).unwrap_or(rest);
                                    blocks.push(json!({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": "image/jpeg",
                                            "data": data,
                                        }
                                    }));
                                } else {
                                    blocks.push(json!({
                                        "type": "image",
                                        "source": { "type": "url", "url": url },
                                    }));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            messages.push(json!({ "role": "user", "content": blocks }));
        }

        let mut body = json!({
            "model": request.model,
            "max_tokens": request.max_tokens,
            "messages": messages,
        });
        if !system.trim().is_empty() {
            body["system"] = Value::String(system.trim().to_string());
        }
        body["temperature"] = Value::from(request.temperature);
        if !request.tools.is_empty() {
            let tools: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.parameters,
                    })
                })
                .collect();
            body["tools"] = Value::Array(tools);
        }
        if request.tool_choice == "none" {
            body["tool_choice"] = json!({ "type": "none" });
        }
        body
    }

    fn parse_response(&self, data: &Value) -> Message {
        let mut message = Message {
            id: data.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            role: "assistant".to_string(),
            content: Value::String(String::new()),
            tool_calls: None,
            reasoning_content: None,
            tool_call_id: None,
            is_error: None,
            elapsed_ms: None,
            reasoning_elapsed_ms: None,
            ui_data: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
            streaming: None,
            model: None,
            usage: None,
            image_vision_analyze_optimize: None,
            image_vision_analyze_result: None,
        };

        let mut texts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<ToolUseContent> = Vec::new();

        if let Some(blocks) = data.get("content").and_then(Value::as_array) {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => texts.push(block.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                    Some("tool_use") => tool_calls.push(ToolUseContent {
                        type_: "tool_use".into(),
                        id: block.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                        name: block.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                    }),
                    _ => {}
                }
            }
        }

        message.content = Value::String(texts.join(""));

        if !tool_calls.is_empty() {
            message.tool_calls = Some(tool_calls);
        }

        if let Some(usage) = data.get("usage") {
            let input = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
            let cache_read = usage.get("cache_read_input_tokens").and_then(Value::as_i64).unwrap_or(0);
            let cache_create = usage.get("cache_creation_input_tokens").and_then(Value::as_i64).unwrap_or(0);
            message.usage = Some(TokenUsage {
                prompt_tokens: input,
                completion_tokens: output,
                total_tokens: input + output + cache_read + cache_create,
            });
        }

        message
    }
}

#[async_trait]
impl Provider for NativeAnthropicProvider {
    async fn chat(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Message, String> {
        let body = self.build_request(request);
        let url = format!("{}/messages", self.base_url);

        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            r = self.http.post(&url).headers(self.headers()).json(&body).send() => r.map_err(|e| format!("API Error: {}", e))?,
        };
        let status = resp.status();
        let text = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }
        let data: Value = serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {}", e))?;
        Ok(self.parse_response(&data))
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String> {
        let mut body = self.build_request(request);
        body["stream"] = Value::Bool(true);
        let url = format!("{}/messages", self.base_url);

        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            r = self.http.post(&url).headers(self.headers()).json(&body).send() => r.map_err(|e| format!("API Error: {}", e))?,
        };
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.map_err(|e| format!("读取错误响应失败: {}", e))?;
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }

        let mut current_event = String::new();
        let mut block_texts: std::collections::HashMap<usize, String> = Default::default();
        let mut tool_uses: std::collections::HashMap<usize, ToolUseContent> = Default::default();
        let mut input_partials: std::collections::HashMap<usize, String> = Default::default();
        let mut tool_fired = false;
        let mut thinking_buffer = String::new();
        let mut last_usage: Option<TokenUsage> = None;

        let result = super::provider::read_sse_lines(resp, cancel, &mut |line: String| {
            let trimmed = line.trim();

            if trimmed.starts_with("event:") {
                current_event = trimmed[6..].trim().to_string();
                return true;
            }

            if trimmed.starts_with("data:") {
                let data_str = trimmed[5..].trim().to_string();
                if data_str == "[DONE]" {
                    on_event(StreamEvent::MessageStop {
                        reasoning_content: if thinking_buffer.is_empty() {
                            None
                        } else {
                            Some(thinking_buffer.clone())
                        },
                        usage: last_usage.clone(),
                    });
                    return true;
                }
                let data: Value = match serde_json::from_str(&data_str) {
                    Ok(v) => v,
                    Err(_) => return true,
                };
                let index = data.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;

                match current_event.as_str() {
                    "content_block_start" => {
                        if let Some(cb) = data.get("content_block") {
                            if cb.get("type").and_then(Value::as_str) == Some("tool_use") {
                                tool_uses.insert(
                                    index,
                                    ToolUseContent {
                                        type_: "tool_use".into(),
                                        id: cb.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                                        name: cb.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                                        input: cb.get("input").cloned().unwrap_or(json!({})),
                                    },
                                );
                            }
                        }
                        block_texts.insert(index, String::new());
                    }
                    "content_block_delta" => {
                        if let Some(delta) = data.get("delta") {
                            match delta.get("type").and_then(Value::as_str) {
                                Some("text_delta") => {
                                    let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                                    block_texts.entry(index).or_default().push_str(text);
                                    on_event(StreamEvent::TextDelta(text.to_string()));
                                }
                                Some("input_json_delta") => {
                                    let partial = delta.get("partial_json").and_then(Value::as_str).unwrap_or("");
                                    input_partials.entry(index).or_default().push_str(partial);
                                }
                                Some("thinking_delta") => {
                                    let thinking = delta.get("thinking").and_then(Value::as_str).unwrap_or("");
                                    thinking_buffer.push_str(thinking);
                                    on_event(StreamEvent::ReasoningContentChange(thinking_buffer.clone()));
                                }
                                _ => {}
                            }
                        }
                    }
                    "content_block_stop" => {
                        if let Some(tool_use) = tool_uses.get_mut(&index) {
                            if let Some(partial) = input_partials.get(&index) {
                                tool_use.input = serde_json::from_str(partial).unwrap_or_else(|_| {
                                    json!({ "_partial": partial })
                                });
                            }
                            if !tool_fired {
                                tool_fired = true;
                                on_event(StreamEvent::ToolUse(tool_use.clone()));
                            }
                        }
                    }
                    "message_delta" => {
                        if let Some(usage) = data.get("usage") {
                            let input = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
                            let output = usage.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
                            let cache_read = usage.get("cache_read_input_tokens").and_then(Value::as_i64).unwrap_or(0);
                            let cache_create = usage.get("cache_creation_input_tokens").and_then(Value::as_i64).unwrap_or(0);
                            last_usage = Some(TokenUsage {
                                prompt_tokens: input,
                                completion_tokens: output,
                                total_tokens: input + output + cache_read + cache_create,
                            });
                        }
                        if !tool_fired {
                            let stop_reason = data
                                .get("delta")
                                .and_then(|d| d.get("stop_reason"))
                                .and_then(Value::as_str);
                            if stop_reason == Some("tool_use") {
                                tool_fired = true;
                                let mut items: Vec<(usize, ToolUseContent)> = tool_uses.drain().collect();
                                items.sort_by_key(|(idx, _)| *idx);
                                for (_, tu) in items {
                                    on_event(StreamEvent::ToolUse(tu));
                                }
                            }
                        }
                    }
                    "message_stop" => {
                        on_event(StreamEvent::MessageStop {
                            reasoning_content: if thinking_buffer.is_empty() {
                                None
                            } else {
                                Some(thinking_buffer.clone())
                            },
                            usage: last_usage.clone(),
                        });
                    }
                    "error" => {
                        let err = data
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("Anthropic API error")
                            .to_string();
                        on_event(StreamEvent::Error(err));
                    }
                    _ => {}
                }
                return true;
            }

            if trimmed.is_empty() {
                current_event.clear();
            }
            true
        })
        .await;

        result
    }
}

// ==================== 桥接 Provider（转发到 JS） ====================

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

// ==================== Provider 工厂 ====================

use super::types::ProviderConnection;

/// Provider 工厂 — 根据连接信息创建 Provider 实例
pub trait ProviderFactory: Send + Sync {
    fn create(&self, conn: &ProviderConnection) -> Box<dyn Provider>;
}

/// 默认工厂：openai/anthropic 原生 HTTP，其余（gemini 等）桥接 JS
pub struct DefaultProviderFactory {
    pub bridge: Arc<AgentBridgeState>,
    pub sink: Arc<dyn EventSink>,
}

impl ProviderFactory for DefaultProviderFactory {
    fn create(&self, conn: &ProviderConnection) -> Box<dyn Provider> {
        match conn.provider_type.as_str() {
            "anthropic" => Box::new(NativeAnthropicProvider::new(
                &conn.provider_id,
                &conn.api_key,
                &conn.base_url,
            )),
            "openai" => Box::new(NativeOpenAiProvider::new(
                &conn.provider_id,
                &conn.api_key,
                &conn.base_url,
            )),
            _ => Box::new(BridgedProvider::new(
                &conn.provider_id,
                &conn.provider_type,
                &conn.provider_id,
                &conn.api_key,
                &conn.base_url,
                self.bridge.clone(),
                self.sink.clone(),
            )),
        }
    }
}

// ==================== SSE 行读取 ====================

/// 逐 chunk 读取响应体并按行回调（对齐 TS readStreamLines）
async fn read_sse_lines(
    mut response: reqwest::Response,
    cancel: &CancellationToken,
    on_line: &mut (dyn FnMut(String) -> bool + Send),
) -> Result<(), String> {
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            chunk = response.chunk() => chunk.map_err(|e| format!("SSE 读取失败: {}", e))?,
        };
        match chunk {
            Some(bytes) => {
                buffer.extend_from_slice(&bytes);
                while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=pos).collect();
                    let end = line.len().saturating_sub(1);
                    let line_str = String::from_utf8_lossy(&line[..end]).to_string();
                    if !on_line(line_str) {
                        return Ok(());
                    }
                }
            }
            None => break,
        }
    }
    Ok(())
}
