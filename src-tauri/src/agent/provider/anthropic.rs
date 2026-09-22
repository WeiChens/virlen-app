//! Anthropic Messages API Provider
//!
//! 移植自 TS `src/infrastructure/provider/anthropic.ts`（铁律 1：双引擎同语义）。

use super::blocks::{anthropic_blocks, process_vision_content, slice_messages, text_of_content};
use super::sse::read_sse_lines;
use super::Provider;
use super::super::cancellation::CancellationToken;
use super::super::types::{ChatRequest, Message, StreamEvent, TokenUsage, ToolUseContent};
use async_trait::async_trait;
use serde_json::{json, Value};

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
    pub(super) fn build_request(&self, request: &ChatRequest) -> Value {
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
            let blocks: Vec<Value> = match &msg.content {
                Value::String(s) => vec![json!({ "type": "text", "text": s })],
                Value::Array(arr) => anthropic_blocks(arr),
                _ => Vec::new(),
            };
            // 本地图片伪视觉分析：将图片替换为分析文本（纯文本模型不支持 image 类型）
            // vision 重建后的块同样要过降级，否则 file / quote 块会漏给 Anthropic
            let blocks = match process_vision_content(msg) {
                Some(processed) => anthropic_blocks(
                    processed.as_array().map(Vec::as_slice).unwrap_or(&[]),
                ),
                None => blocks,
            };
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
                cached_tokens: Some(cache_read + cache_create),
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

        let result = read_sse_lines(resp, cancel, &mut |line: String| {
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
                                cached_tokens: Some(cache_read + cache_create),
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
