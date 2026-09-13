//! Provider 层 — 原生 HTTP 实现 + JS 桥接实现
//!
//! - `NativeOpenAiProvider`：OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / Ollama / 自定义）
//! - `NativeAnthropicProvider`：Anthropic Messages API
//! - `NativeResponsesProvider`：OpenAI Responses API（/responses）
//! - `NativeGeminiProvider`：Google Gemini（generateContent / streamGenerateContent）
//! - `BridgedProvider`：未原生化的类型转发到 JS 侧已有 provider，通过双向事件桥

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

/// 本地图片伪视觉分析 — 处理消息 content（对齐 TS `visionInject.ts processVisionContent`）
///
/// 当 user 消息标记了 `imageVisionAnalyzeOptimize=true` 且带 `imageVisionAnalyzeResult` 时：
/// - 移除 image_url 块（不把原始 base64 图片发给纯文本 LLM）
/// - 追加 `\n\n{分析结果}` 文本块
/// 否则返回 None（content 原样发送）
fn process_vision_content(msg: &Message) -> Option<Value> {
    let result = msg.image_vision_analyze_result.as_deref().unwrap_or("");
    if msg.role != "user"
        || msg.image_vision_analyze_optimize != Some(true)
        || result.is_empty()
    {
        return None;
    }

    // 确保 content 是数组格式
    let mut blocks: Vec<Value> = match &msg.content {
        Value::Array(arr) => arr.clone(),
        Value::String(s) if !s.is_empty() => vec![json!({ "type": "text", "text": s })],
        _ => Vec::new(),
    };

    // 过滤掉 image_url 块
    blocks.retain(|b| b.get("type").and_then(Value::as_str) != Some("image_url"));

    // 追加分析结果文本（已由前端按多图格式组装好）
    blocks.push(json!({ "type": "text", "text": format!("\n\n{}", result) }));

    Some(Value::Array(blocks))
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
            // 本地图片伪视觉分析：将图片替换为分析文本（纯文本模型不支持 image 类型）
            if let Some(processed) = process_vision_content(msg) {
                formatted.insert("content".into(), processed);
            } else {
                formatted.insert("content".into(), content_to_value(msg));
            }

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
        // thinking 模式控制（优先于 reasoningEffort，对齐 openai.ts buildRequest）
        // - DeepSeek reasoner：thinking: { type: 'disabled' }
        // - OpenAI 兼容 / o 系列：reasoning_effort: 'none' 禁用思考
        if request.thinking == Some(false) {
            body["thinking"] = json!({ "type": "disabled" });
            body["reasoning_effort"] = Value::String("none".into());
        } else if let Some(re) = &request.reasoning_effort {
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
                            thought_signature: None,
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
                        if let Some(id) = tc.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                            entry.0 = id.to_string();
                        }
                        if let Some(name) = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
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
                            thought_signature: None,
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
            // 本地图片伪视觉分析：将图片替换为分析文本（纯文本模型不支持 image 类型）
            if let Some(processed) = process_vision_content(msg) {
                blocks = processed.as_array().cloned().unwrap_or_default();
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
        // thinking 模式控制（Anthropic extended thinking，对齐 anthropic.ts buildRequest）
        if request.thinking == Some(false) {
            body["thinking"] = json!({ "type": "disabled" });
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
                        thought_signature: None,
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
                                        thought_signature: None,
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

// ==================== OpenAI Responses Provider ====================

pub struct NativeResponsesProvider {
    api_key: String,
    base_url: String,
    http: reqwest::Client,
}

impl NativeResponsesProvider {
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

    /// 构建 Responses API 请求体（移植 responses.ts buildRequest）
    fn build_request(&self, request: &ChatRequest) -> Value {
        let mut input: Vec<Value> = Vec::new();

        let request_messages = slice_messages(&request.messages);
        for msg in request_messages {
            // summary / feedback 角色：转为 user 消息
            if msg.role == "summary" || msg.role == "feedback" {
                input.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": text_of_content(&msg.content) }],
                }));
                continue;
            }

            if msg.role == "assistant" {
                if let Value::String(s) = &msg.content {
                    if !s.is_empty() {
                        input.push(json!({
                            "type": "message",
                            "role": "assistant",
                            "content": [{ "type": "output_text", "text": s }],
                        }));
                    }
                }
                if let Some(tcs) = &msg.tool_calls {
                    for tc in tcs {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": tc.id,
                            "name": tc.name,
                            "arguments": serde_json::to_string(&tc.input)
                                .unwrap_or_else(|_| "{}".to_string()),
                        }));
                    }
                }
                continue;
            }

            if msg.role == "tool" {
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": msg.tool_call_id.clone().unwrap_or_default(),
                    "output": text_of_content(&msg.content),
                }));
                continue;
            }

            // user 消息
            let mut parts: Vec<Value> = Vec::new();
            match &msg.content {
                Value::String(s) => {
                    if !s.is_empty() {
                        parts.push(json!({ "type": "input_text", "text": s }));
                    }
                }
                Value::Array(arr) => {
                    for block in arr {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => parts.push(json!({
                                "type": "input_text",
                                "text": block.get("text").and_then(Value::as_str).unwrap_or(""),
                            })),
                            Some("image_url") => {
                                let url = block
                                    .get("image_url")
                                    .and_then(|i| i.get("url"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                parts.push(json!({ "type": "input_image", "image_url": url }));
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            if let Some(processed) = process_vision_content(msg) {
                parts = processed
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|b| {
                        json!({
                            "type": "input_text",
                            "text": b.get("text").and_then(Value::as_str).unwrap_or(""),
                        })
                    })
                    .collect();
            }
            input.push(json!({ "type": "message", "role": "user", "content": parts }));
        }

        let mut body = json!({
            "model": request.model,
            "input": input,
            "stream": request.stream,
            "store": false,
        });

        if let Some(sp) = &request.system_prompt {
            if !sp.is_empty() {
                body["instructions"] = Value::String(sp.clone());
            }
        }
        body["temperature"] = Value::from(request.temperature);
        body["top_p"] = Value::from(request.top_p);
        if request.max_tokens > 0 {
            body["max_output_tokens"] = Value::from(request.max_tokens);
        }

        if !request.tools.is_empty() {
            let tools: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    })
                })
                .collect();
            body["tools"] = Value::Array(tools);
        }
        if !request.tool_choice.is_empty() {
            body["tool_choice"] = Value::String(request.tool_choice.clone());
        }
        // thinking 模式控制（Responses API 使用 reasoning.effort；官方合法取值含 'none'）
        if request.thinking == Some(false) {
            body["reasoning"] = json!({ "effort": "none" });
        } else if let Some(re) = &request.reasoning_effort {
            body["reasoning"] = json!({ "effort": re });
        }

        body
    }

    /// 解析非流式响应（移植 responses.ts parseResponse）
    fn parse_response(&self, data: &Value) -> Message {
        let mut message = Message {
            id: data
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
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
        let mut reasoning = String::new();

        if let Some(output) = data.get("output").and_then(Value::as_array) {
            for item in output {
                match item.get("type").and_then(Value::as_str) {
                    Some("message") => {
                        if let Some(content) = item.get("content").and_then(Value::as_array) {
                            for c in content {
                                if c.get("type").and_then(Value::as_str) == Some("output_text") {
                                    if let Some(t) = c.get("text").and_then(Value::as_str) {
                                        texts.push(t.to_string());
                                    }
                                }
                            }
                        }
                    }
                    Some("function_call") => {
                        let id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .or_else(|| item.get("id").and_then(Value::as_str))
                            .unwrap_or("")
                            .to_string();
                        let args = item
                            .get("arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}");
                        tool_calls.push(ToolUseContent {
                            type_: "tool_use".into(),
                            id,
                            name: item
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            input: serde_json::from_str(args).unwrap_or(Value::Null),
                            thought_signature: None,
                        });
                    }
                    Some("reasoning") => {
                        if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                            for s in summary {
                                if let Some(t) = s.get("text").and_then(Value::as_str) {
                                    reasoning.push_str(t);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        message.content = Value::String(texts.join(""));
        if !tool_calls.is_empty() {
            message.tool_calls = Some(tool_calls);
        }
        if !reasoning.is_empty() {
            message.reasoning_content = Some(reasoning);
        }

        if let Some(usage) = data.get("usage") {
            let input = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
            let output = usage
                .get("output_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let total = usage
                .get("total_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(input + output);
            message.usage = Some(TokenUsage {
                prompt_tokens: input,
                completion_tokens: output,
                total_tokens: total,
            });
        }

        message
    }
}

#[async_trait]
impl Provider for NativeResponsesProvider {
    async fn chat(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Message, String> {
        let body = self.build_request(request);
        let url = format!("{}/responses", self.base_url);

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
        let url = format!("{}/responses", self.base_url);

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
        // key → (id, name, args, fired)
        let mut tool_items: std::collections::HashMap<String, (String, String, String, bool)> =
            std::collections::HashMap::new();

        let result = read_sse_lines(resp, cancel, &mut |line: String| {
            let trimmed = line.trim();
            if !trimmed.starts_with("data:") {
                return true;
            }
            let data_str = trimmed[5..].trim().to_string();
            if data_str == "[DONE]" {
                return true;
            }
            let data: Value = match serde_json::from_str(&data_str) {
                Ok(v) => v,
                Err(_) => return true,
            };
            let t = data.get("type").and_then(Value::as_str).unwrap_or("");
            match t {
                "response.output_text.delta" => {
                    if let Some(d) = data.get("delta").and_then(Value::as_str) {
                        if !d.is_empty() {
                            on_event(StreamEvent::TextDelta(d.to_string()));
                        }
                    }
                }
                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                    if let Some(d) = data.get("delta").and_then(Value::as_str) {
                        if !d.is_empty() {
                            reasoning_content.push_str(d);
                            on_event(StreamEvent::ReasoningContentChange(
                                reasoning_content.clone(),
                            ));
                        }
                    }
                }
                "response.output_item.added" => {
                    if let Some(item) = data.get("item") {
                        if item.get("type").and_then(Value::as_str) == Some("function_call") {
                            let key = item
                                .get("id")
                                .and_then(Value::as_str)
                                .map(String::from)
                                .or_else(|| {
                                    data.get("output_index")
                                        .and_then(Value::as_u64)
                                        .map(|i| format!("idx_{}", i))
                                });
                            if let Some(key) = key {
                                let id = item
                                    .get("call_id")
                                    .and_then(Value::as_str)
                                    .or_else(|| item.get("id").and_then(Value::as_str))
                                    .unwrap_or("")
                                    .to_string();
                                let name = item
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let args = item
                                    .get("arguments")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                tool_items.insert(key, (id, name, args, false));
                            }
                        }
                    }
                }
                "response.function_call_arguments.delta" => {
                    if let Some(key) = data.get("item_id").and_then(Value::as_str) {
                        if let Some(entry) = tool_items.get_mut(key) {
                            if let Some(d) = data.get("delta").and_then(Value::as_str) {
                                entry.2.push_str(d);
                            }
                        }
                    }
                }
                "response.function_call_arguments.done" => {
                    if let Some(key) = data.get("item_id").and_then(Value::as_str) {
                        if let Some(entry) = tool_items.get_mut(key) {
                            if let Some(a) = data.get("arguments").and_then(Value::as_str) {
                                entry.2 = a.to_string();
                            }
                        }
                    }
                }
                "response.output_item.done" => {
                    if let Some(item) = data.get("item") {
                        if item.get("type").and_then(Value::as_str) == Some("function_call") {
                            let key = item
                                .get("id")
                                .and_then(Value::as_str)
                                .map(String::from)
                                .or_else(|| {
                                    data.get("output_index")
                                        .and_then(Value::as_u64)
                                        .map(|i| format!("idx_{}", i))
                                })
                                .unwrap_or_default();
                            let entry = tool_items
                                .entry(key)
                                .or_insert((String::new(), String::new(), String::new(), false));
                            if let Some(a) = item.get("arguments").and_then(Value::as_str) {
                                if !a.is_empty() {
                                    entry.2 = a.to_string();
                                }
                            }
                            if let Some(n) = item.get("name").and_then(Value::as_str) {
                                if !n.is_empty() {
                                    entry.1 = n.to_string();
                                }
                            }
                            if let Some(cid) = item.get("call_id").and_then(Value::as_str) {
                                entry.0 = cid.to_string();
                            }
                            if !entry.3 {
                                entry.3 = true;
                                let input = serde_json::from_str(&entry.2).unwrap_or(json!({}));
                                on_event(StreamEvent::ToolUse(ToolUseContent {
                                    type_: "tool_use".into(),
                                    id: entry.0.clone(),
                                    name: entry.1.clone(),
                                    input,
                                    thought_signature: None,
                                }));
                            }
                        }
                    }
                }
                "response.completed" | "response.incomplete" => {
                    if let Some(u) = data.get("response").and_then(|r| r.get("usage")) {
                        let input = u.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
                        let output = u
                            .get("output_tokens")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        let total = u
                            .get("total_tokens")
                            .and_then(Value::as_i64)
                            .unwrap_or(input + output);
                        last_usage = Some(TokenUsage {
                            prompt_tokens: input,
                            completion_tokens: output,
                            total_tokens: total,
                        });
                    }
                }
                "response.failed" | "response.error" | "error" => {
                    let msg = data
                        .get("response")
                        .and_then(|r| r.get("error"))
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .or_else(|| {
                            data.get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(Value::as_str)
                        })
                        .or_else(|| data.get("message").and_then(Value::as_str))
                        .unwrap_or("Responses API error")
                        .to_string();
                    on_event(StreamEvent::Error(msg));
                }
                _ => {}
            }
            true
        })
        .await;

        result?;

        // 兜底触发尚未发出的 function_call
        let mut keys: Vec<String> = tool_items.keys().cloned().collect();
        keys.sort();
        for key in keys {
            if let Some((id, name, args, fired)) = tool_items.remove(&key) {
                if !fired {
                    let input = serde_json::from_str(&args).unwrap_or(json!({}));
                    on_event(StreamEvent::ToolUse(ToolUseContent {
                        type_: "tool_use".into(),
                        id,
                        name,
                        input,
                        thought_signature: None,
                    }));
                }
            }
        }

        on_event(StreamEvent::MessageStop {
            reasoning_content: if reasoning_content.is_empty() {
                None
            } else {
                Some(reasoning_content.clone())
            },
            usage: last_usage.clone(),
        });

        Ok(())
    }
}

// ==================== Gemini Provider ====================

/// Gemini 单次输出上限的保守上界；超过则不发送 maxOutputTokens
const GEMINI_MAX_OUTPUT_TOKENS: i64 = 65536;

pub struct NativeGeminiProvider {
    api_key: String,
    base_url: String,
    http: reqwest::Client,
}

impl NativeGeminiProvider {
    pub fn new(_name: &str, api_key: &str, base_url: &str) -> Self {
        let base = if base_url.is_empty() {
            "https://generativelanguage.googleapis.com/v1beta"
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
        h
    }

    /// 构建 Gemini 请求体（移植 gemini.ts buildRequest）
    fn build_request(&self, request: &ChatRequest) -> Value {
        let mut contents: Vec<Value> = Vec::new();
        let request_messages = slice_messages(&request.messages);

        // toolCallId → 函数名 映射（functionResponse.name）
        let mut call_id_to_name: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for m in request_messages {
            if m.role == "assistant" {
                if let Some(tcs) = &m.tool_calls {
                    for tc in tcs {
                        call_id_to_name.insert(tc.id.clone(), tc.name.clone());
                    }
                }
            }
        }

        for msg in request_messages {
            if msg.role == "summary" || msg.role == "feedback" {
                contents.push(json!({
                    "role": "user",
                    "parts": [{ "text": text_of_content(&msg.content) }],
                }));
                continue;
            }

            if msg.role == "assistant" {
                let mut parts: Vec<Value> = Vec::new();
                if let Value::String(s) = &msg.content {
                    if !s.is_empty() {
                        parts.push(json!({ "text": s }));
                    }
                }
                if let Some(tcs) = &msg.tool_calls {
                    for tc in tcs {
                        let mut fc = json!({ "name": tc.name, "args": tc.input });
                        // 仅回传 Gemini 原生 functionCall.id（合成 fc_ id 不回收）
                        if !tc.id.starts_with("fc_") {
                            fc["id"] = Value::String(tc.id.clone());
                        }
                        let mut part = json!({ "functionCall": fc });
                        // Gemini 2.5 思考模型：回传函数调用的 thoughtSignature
                        if let Some(sig) = &tc.thought_signature {
                            if !sig.is_empty() {
                                part["thoughtSignature"] = Value::String(sig.clone());
                            }
                        }
                        parts.push(part);
                    }
                }
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
                continue;
            }

            if msg.role == "tool" {
                let tcid = msg.tool_call_id.clone().unwrap_or_default();
                let name = call_id_to_name.get(&tcid).cloned().unwrap_or_else(|| {
                    tcid.trim_start_matches("fc_")
                        .split('_')
                        .next()
                        .unwrap_or("unknown")
                        .to_string()
                });
                let output = text_of_content(&msg.content);
                let mut fr = json!({
                    "name": name,
                    "response": { "name": name, "content": output },
                });
                if !tcid.starts_with("fc_") && !tcid.is_empty() {
                    fr["id"] = Value::String(tcid.clone());
                }
                let fr_part = json!({ "functionResponse": fr });

                // 连续工具结果合并到同一条 user content
                let can_merge = contents
                    .last()
                    .map(|last| {
                        last.get("role").and_then(Value::as_str) == Some("user")
                            && last
                                .get("parts")
                                .and_then(Value::as_array)
                                .and_then(|p| p.last())
                                .map(|p| p.get("functionResponse").is_some())
                                .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if can_merge {
                    if let Some(arr) = contents
                        .last_mut()
                        .and_then(|l| l.get_mut("parts"))
                        .and_then(Value::as_array_mut)
                    {
                        arr.push(fr_part);
                    }
                } else {
                    contents.push(json!({ "role": "user", "parts": [fr_part] }));
                }
                continue;
            }

            // user 消息
            let mut parts: Vec<Value> = Vec::new();
            match &msg.content {
                Value::String(s) => {
                    if !s.is_empty() {
                        parts.push(json!({ "text": s }));
                    }
                }
                Value::Array(arr) => {
                    for block in arr {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(Value::as_str) {
                                    if !t.is_empty() {
                                        parts.push(json!({ "text": t }));
                                    }
                                }
                            }
                            Some("image_url") => {
                                let url = block
                                    .get("image_url")
                                    .and_then(|i| i.get("url"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if let Some(rest) = url.strip_prefix("data:") {
                                    if let Some((meta, data)) = rest.split_once(',') {
                                        let mime = meta.split(';').next().unwrap_or("image/jpeg");
                                        parts.push(json!({
                                            "inlineData": { "mimeType": mime, "data": data }
                                        }));
                                    }
                                } else {
                                    parts.push(json!({ "text": format!("[图片: {}]", url) }));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            if let Some(processed) = process_vision_content(msg) {
                parts = processed
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|b| json!({ "text": b.get("text").and_then(Value::as_str).unwrap_or("") }))
                    .collect();
            }
            if !parts.is_empty() {
                contents.push(json!({ "role": "user", "parts": parts }));
            }
        }

        let mut body = json!({ "contents": contents });

        if let Some(sp) = &request.system_prompt {
            if !sp.is_empty() {
                body["systemInstruction"] = json!({ "parts": [{ "text": sp }] });
            }
        }

        let mut gen_config = serde_json::Map::new();
        gen_config.insert("temperature".into(), Value::from(request.temperature));
        gen_config.insert("topP".into(), Value::from(request.top_p));
        if request.max_tokens > 0 && request.max_tokens <= GEMINI_MAX_OUTPUT_TOKENS {
            gen_config.insert("maxOutputTokens".into(), Value::from(request.max_tokens));
        }
        // thinking 模式控制：thinkingBudget=0 禁用思考（对齐 gemini.ts buildRequest）
        if request.thinking == Some(false) {
            gen_config.insert("thinkingConfig".into(), json!({ "thinkingBudget": 0 }));
        }

        if !request.tools.is_empty() {
            let decls: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    })
                })
                .collect();
            body["tools"] = json!([{ "functionDeclarations": decls }]);
            body["toolConfig"] = json!({
                "functionCallingConfig": {
                    "mode": if request.tool_choice == "none" { "NONE" } else { "AUTO" },
                }
            });
        }

        if !gen_config.is_empty() {
            body["generationConfig"] = Value::Object(gen_config);
        }

        body
    }

    fn parse_response(&self, data: &Value) -> Message {
        let mut message = Message {
            id: data
                .get("responseId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
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

        let candidate = data
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|a| a.first());
        let Some(candidate) = candidate else {
            if let Some(reason) = data
                .get("promptFeedback")
                .and_then(|p| p.get("blockReason"))
                .and_then(Value::as_str)
            {
                message.content = Value::String(format!("[内容被拦截: {}]", reason));
            }
            return message;
        };

        let mut texts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<ToolUseContent> = Vec::new();
        let mut reasoning = String::new();

        if let Some(parts) = candidate
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(Value::as_array)
        {
            for part in parts {
                if let Some(fc) = part.get("functionCall") {
                    let name = fc
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let id = fc
                        .get("id")
                        .and_then(Value::as_str)
                        .map(String::from)
                        .unwrap_or_else(|| format!("fc_{}_{}", name, uuid::Uuid::new_v4()));
                    let thought_signature = part
                        .get("thoughtSignature")
                        .and_then(Value::as_str)
                        .map(String::from);
                    tool_calls.push(ToolUseContent {
                        type_: "tool_use".into(),
                        id,
                        name,
                        input: fc.get("args").cloned().unwrap_or(json!({})),
                        thought_signature,
                    });
                } else if let Some(t) = part.get("text").and_then(Value::as_str) {
                    if part.get("thought").and_then(Value::as_bool).unwrap_or(false) {
                        reasoning.push_str(t);
                    } else {
                        texts.push(t.to_string());
                    }
                }
            }
        }

        message.content = Value::String(texts.join(""));
        if !tool_calls.is_empty() {
            message.tool_calls = Some(tool_calls);
        }
        if !reasoning.is_empty() {
            message.reasoning_content = Some(reasoning);
        }

        if let Some(u) = data.get("usageMetadata") {
            let prompt = u
                .get("promptTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let comp = u
                .get("candidatesTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let total = u
                .get("totalTokenCount")
                .and_then(Value::as_i64)
                .unwrap_or(prompt + comp);
            message.usage = Some(TokenUsage {
                prompt_tokens: prompt,
                completion_tokens: comp,
                total_tokens: total,
            });
        }

        message
    }
}

#[async_trait]
impl Provider for NativeGeminiProvider {
    async fn chat(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Message, String> {
        let body = self.build_request(request);
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            self.base_url, request.model, self.api_key
        );

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
        let body = self.build_request(request);
        let url = format!(
            "{}/models/{}:streamGenerateContent?alt=sse&key={}",
            self.base_url, request.model, self.api_key
        );

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
        let mut fired: std::collections::HashSet<String> = Default::default();

        let result = read_sse_lines(resp, cancel, &mut |line: String| {
            let trimmed = line.trim();
            if !trimmed.starts_with("data:") {
                return true;
            }
            let data_str = trimmed[5..].trim().to_string();
            if data_str.is_empty() || data_str == "[DONE]" {
                return true;
            }
            let chunk: Value = match serde_json::from_str(&data_str) {
                Ok(v) => v,
                Err(_) => return true,
            };

            if let Some(err) = chunk.get("error") {
                let m = err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Gemini API error")
                    .to_string();
                on_event(StreamEvent::Error(m));
                return true;
            }

            if let Some(u) = chunk.get("usageMetadata") {
                let prompt = u
                    .get("promptTokenCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let comp = u
                    .get("candidatesTokenCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let total = u
                    .get("totalTokenCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(prompt + comp);
                last_usage = Some(TokenUsage {
                    prompt_tokens: prompt,
                    completion_tokens: comp,
                    total_tokens: total,
                });
            }

            let parts = chunk
                .get("candidates")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(Value::as_array);
            if let Some(parts) = parts {
                for part in parts {
                    if let Some(fc) = part.get("functionCall") {
                        let name = fc
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let id = fc
                            .get("id")
                            .and_then(Value::as_str)
                            .map(String::from)
                            .unwrap_or_else(|| format!("fc_{}_{}", name, uuid::Uuid::new_v4()));
                        if fired.insert(id.clone()) {
                            let thought_signature = part
                                .get("thoughtSignature")
                                .and_then(Value::as_str)
                                .map(String::from);
                            on_event(StreamEvent::ToolUse(ToolUseContent {
                                type_: "tool_use".into(),
                                id,
                                name,
                                input: fc.get("args").cloned().unwrap_or(json!({})),
                                thought_signature,
                            }));
                        }
                    } else if let Some(t) = part.get("text").and_then(Value::as_str) {
                        if t.is_empty() {
                            continue;
                        }
                        if part.get("thought").and_then(Value::as_bool).unwrap_or(false) {
                            reasoning_content.push_str(t);
                            on_event(StreamEvent::ReasoningContentChange(
                                reasoning_content.clone(),
                            ));
                        } else {
                            on_event(StreamEvent::TextDelta(t.to_string()));
                        }
                    }
                }
            }
            true
        })
        .await;

        result?;

        on_event(StreamEvent::MessageStop {
            reasoning_content: if reasoning_content.is_empty() {
                None
            } else {
                Some(reasoning_content.clone())
            },
            usage: last_usage.clone(),
        });

        Ok(())
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
            "thinking": request.thinking,
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

/// 默认工厂：openai/anthropic/responses/gemini 原生 HTTP，其余未识别类型桥接 JS
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
            "responses" => Box::new(NativeResponsesProvider::new(
                &conn.provider_id,
                &conn.api_key,
                &conn.base_url,
            )),
            "gemini" => Box::new(NativeGeminiProvider::new(
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

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::{ToolDefinition, ToolParameters};

    fn msg(
        role: &str,
        content: Value,
        optimize: Option<bool>,
        result: Option<&str>,
    ) -> Message {
        Message {
            id: "1".into(),
            role: role.into(),
            content,
            tool_calls: None,
            reasoning_content: None,
            tool_call_id: None,
            is_error: None,
            elapsed_ms: None,
            reasoning_elapsed_ms: None,
            ui_data: None,
            timestamp: 0,
            streaming: None,
            model: None,
            usage: None,
            image_vision_analyze_optimize: optimize,
            image_vision_analyze_result: result.map(String::from),
        }
    }

    fn chat_request(messages: Vec<Message>) -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            messages,
            system_prompt: None,
            tools: vec![],
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: 100,
            stream: false,
            tool_choice: "none".into(),
            reasoning_effort: None,
            thinking: None,
        }
    }

    #[test]
    fn vision_process_filters_image_and_appends_result() {
        let m = msg(
            "user",
            json!([
                { "type": "text", "text": "看下这张图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
            ]),
            Some(true),
            Some("用户上传了1张图片\n\n第1张图片\n[分析结果]"),
        );
        let processed = process_vision_content(&m).expect("应返回处理结果");
        let blocks = processed.as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "看下这张图");
        assert_eq!(blocks[1]["type"], "text");
        assert!(blocks[1]["text"].as_str().unwrap().contains("分析结果"));
        assert!(!processed.to_string().contains("image_url"));
    }

    #[test]
    fn vision_process_string_content_becomes_blocks() {
        let m = msg("user", json!("看图"), Some(true), Some("分析结果"));
        let processed = process_vision_content(&m).unwrap();
        let blocks = processed.as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], "看图");
        assert!(blocks[1]["text"].as_str().unwrap().contains("分析结果"));
    }

    #[test]
    fn vision_process_skips_non_user_or_unmarked() {
        // 非 user 消息
        let m = msg("assistant", json!("hi"), Some(true), Some("结果"));
        assert!(process_vision_content(&m).is_none());
        // optimize=false
        let m = msg("user", json!("hi"), Some(false), Some("结果"));
        assert!(process_vision_content(&m).is_none());
        // result 为空字符串
        let m = msg("user", json!("hi"), Some(true), Some(""));
        assert!(process_vision_content(&m).is_none());
        // 未标记
        let m = msg("user", json!("hi"), None, None);
        assert!(process_vision_content(&m).is_none());
    }

    #[test]
    fn openai_build_request_injects_vision_result() {
        let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
        let request = chat_request(vec![msg(
            "user",
            json!([
                { "type": "text", "text": "描述这张图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
            ]),
            Some(true),
            Some("图中有一只猫"),
        )]);
        let body = p.build_request(&request);
        let body_str = body.to_string();
        assert!(!body_str.contains("image_url"));
        assert!(body_str.contains("图中有一只猫"));
    }

    #[test]
    fn openai_build_request_keeps_image_without_optimize() {
        let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
        let request = chat_request(vec![msg(
            "user",
            json!([
                { "type": "text", "text": "描述这张图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
            ]),
            None,
            None,
        )]);
        let body = p.build_request(&request);
        assert!(body.to_string().contains("image_url"));
    }

    #[test]
    fn anthropic_build_request_injects_vision_result() {
        let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
        let request = chat_request(vec![msg(
            "user",
            json!([
                { "type": "text", "text": "描述这张图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
            ]),
            Some(true),
            Some("图中有一只猫"),
        )]);
        let body = p.build_request(&request);
        let body_str = body.to_string();
        assert!(!body_str.contains("image_url"));
        assert!(body_str.contains("图中有一只猫"));
    }

    fn mk_tool(name: &str, description: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            label: None,
            description: description.into(),
            parameters: ToolParameters {
                type_: "object".into(),
                properties: json!({}),
                required: vec![],
                one_of: None,
            },
        }
    }

    #[test]
    fn responses_build_request_maps_system_and_input() {
        let p = NativeResponsesProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![msg("user", json!("hi"), None, None)]);
        req.system_prompt = Some("你是助手".into());
        let body = p.build_request(&req);
        assert_eq!(body["instructions"], "你是助手");
        assert_eq!(body["store"], false);
        assert_eq!(body["input"][0]["type"], "message");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(body["input"][0]["content"][0]["text"], "hi");
    }

    #[test]
    fn responses_build_request_tools_flat_and_function_call() {
        let p = NativeResponsesProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![]);
        req.tools = vec![mk_tool("foo", "desc")];
        let body = p.build_request(&req);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "foo");
        assert!(body["tools"][0].get("function").is_none());

        let mut assistant = msg("assistant", json!(""), None, None);
        assistant.tool_calls = Some(vec![ToolUseContent {
            type_: "tool_use".into(),
            id: "call_1".into(),
            name: "get_time".into(),
            input: json!({ "tz": "UTC" }),
            thought_signature: None,
        }]);
        let mut tool = msg("tool", json!("12:00"), None, None);
        tool.tool_call_id = Some("call_1".into());
        let req2 = chat_request(vec![assistant, tool]);
        let body2 = p.build_request(&req2);
        assert_eq!(body2["input"][0]["type"], "function_call");
        assert_eq!(body2["input"][0]["call_id"], "call_1");
        assert_eq!(body2["input"][1]["type"], "function_call_output");
        assert_eq!(body2["input"][1]["call_id"], "call_1");
    }

    #[test]
    fn gemini_build_request_function_response_name_with_underscore() {
        let p = NativeGeminiProvider::new("test", "key", "https://api.test.com");
        let mut assistant = msg("assistant", json!(""), None, None);
        assistant.tool_calls = Some(vec![ToolUseContent {
            type_: "tool_use".into(),
            id: "fc_read_file_abc12345".into(),
            name: "read_file".into(),
            input: json!({ "path": "a.txt" }),
            thought_signature: None,
        }]);
        let mut tool = msg("tool", json!("content"), None, None);
        tool.tool_call_id = Some("fc_read_file_abc12345".into());
        let req = chat_request(vec![assistant, tool]);
        let body = p.build_request(&req);
        assert_eq!(body["contents"][0]["role"], "model");
        assert_eq!(body["contents"][0]["parts"][0]["functionCall"]["name"], "read_file");
        // 合成的 fc_ id 不回传
        assert!(body["contents"][0]["parts"][0]["functionCall"].get("id").is_none());
        assert_eq!(body["contents"][1]["role"], "user");
        assert_eq!(
            body["contents"][1]["parts"][0]["functionResponse"]["name"],
            "read_file"
        );
    }

    #[test]
    fn gemini_build_request_tool_config_mode() {
        let p = NativeGeminiProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![]);
        req.tools = vec![mk_tool("call_any", "d")];
        req.tool_choice = "none".into();
        let body = p.build_request(&req);
        assert_eq!(
            body["tools"][0]["functionDeclarations"][0]["name"],
            "call_any"
        );
        assert_eq!(body["toolConfig"]["functionCallingConfig"]["mode"], "NONE");
    }

    #[test]
    fn gemini_build_request_returns_thought_signature() {
        let p = NativeGeminiProvider::new("test", "key", "https://api.test.com");
        let mut assistant = msg("assistant", json!(""), None, None);
        assistant.tool_calls = Some(vec![ToolUseContent {
            type_: "tool_use".into(),
            id: "call_abc".into(),
            name: "get_weather".into(),
            input: json!({ "city": "BJ" }),
            thought_signature: Some("SIG123".into()),
        }]);
        let req = chat_request(vec![assistant]);
        let body = p.build_request(&req);
        assert_eq!(body["contents"][0]["parts"][0]["functionCall"]["id"], "call_abc");
        assert_eq!(body["contents"][0]["parts"][0]["thoughtSignature"], "SIG123");
    }

    #[test]
    fn provider_factory_routes_types() {
        // 仅验证工厂分支选择（不发起网络），确认 native 类型不再走桥接
        let bridge = std::sync::Arc::new(crate::agent::bridge::AgentBridgeState::default());
        let sink: std::sync::Arc<dyn EventSink> =
            std::sync::Arc::new(crate::agent::event_sink::TestEventSink::new());
        let factory = DefaultProviderFactory { bridge, sink };

        let mk = |t: &str| ProviderConnection {
            provider_type: t.into(),
            provider_id: "p".into(),
            api_key: "k".into(),
            base_url: "https://api.test.com".into(),
        };
        // 仅确保 create 不 panic（四种原生 + 一种桥接）
        let _ = factory.create(&mk("openai"));
        let _ = factory.create(&mk("anthropic"));
        let _ = factory.create(&mk("responses"));
        let _ = factory.create(&mk("gemini"));
        let _ = factory.create(&mk("unknown"));
    }

    #[test]
    fn responses_thinking_false_maps_to_reasoning_none() {
        let p = NativeResponsesProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![]);
        req.thinking = Some(false);
        let body = p.build_request(&req);
        assert_eq!(body["reasoning"]["effort"], "none");
    }

    #[test]
    fn responses_reasoning_effort_maps_to_reasoning() {
        let p = NativeResponsesProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![]);
        req.reasoning_effort = Some("low".into());
        let body = p.build_request(&req);
        assert_eq!(body["reasoning"]["effort"], "low");
    }

    #[test]
    fn gemini_thinking_false_disables_thinking_budget() {
        let p = NativeGeminiProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![]);
        req.thinking = Some(false);
        let body = p.build_request(&req);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            json!(0)
        );
    }

    #[test]
    fn gemini_thinking_none_omits_thinking_config() {
        let p = NativeGeminiProvider::new("test", "key", "https://api.test.com");
        let req = chat_request(vec![]);
        let body = p.build_request(&req);
        assert!(body["generationConfig"].get("thinkingConfig").is_none());
    }

    #[test]
    fn openai_thinking_false_disables_reasoning() {
        let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![]);
        req.thinking = Some(false);
        let body = p.build_request(&req);
        assert_eq!(body["thinking"]["type"], "disabled");
        assert_eq!(body["reasoning_effort"], "none");
    }

    #[test]
    fn anthropic_thinking_false_disables_thinking() {
        let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
        let mut req = chat_request(vec![]);
        req.thinking = Some(false);
        let body = p.build_request(&req);
        assert_eq!(body["thinking"]["type"], "disabled");
    }
}
