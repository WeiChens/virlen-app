//! OpenAI 兼容协议 Provider — OpenAI / DeepSeek / Moonshot / Ollama / 自定义 Base URL
//!
//! 移植自 TS `src/infrastructure/provider/openai.ts`（铁律 1：双引擎同语义）。

use super::blocks::{openai_content, process_vision_content, slice_messages, text_of_content};
use super::sse::read_sse_lines;
use super::Provider;
use super::super::cancellation::CancellationToken;
use super::super::types::{ChatRequest, Message, StreamEvent, TokenUsage, ToolUseContent};
use async_trait::async_trait;
use serde_json::{json, Value};

/// 从 OpenAI 兼容的 usage 里取出**缓存命中**的输入量（与 TS `openai.ts::cachedTokensFromUsage` 对齐）。
///
/// 不取的话账本里的缓存 token 永远是 0：OpenAI 把缓存命中算在 `prompt_tokens` 里，
/// `total - prompt - completion` 恒等于 0，缓存价永远用不上。
///
/// - OpenAI：`prompt_tokens_details.cached_tokens`
/// - DeepSeek：顶层 `prompt_cache_hit_tokens`
/// - 其它兼容实现多数不返回 → `None`（账本退回推导值）
fn openai_cached_tokens(usage: &Value) -> Option<i64> {
    let n = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_i64)
        .or_else(|| usage.get("prompt_cache_hit_tokens").and_then(Value::as_i64))?;
    if n > 0 {
        Some(n)
    } else {
        None
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
    pub(super) fn build_request(&self, request: &ChatRequest) -> Value {
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
            // 两条路径都要过块降级（file / quote → 文本），否则自定义块会直接漏给 API
            let content = match process_vision_content(msg) {
                Some(processed) => openai_content(msg, &processed),
                None => openai_content(msg, &msg.content),
            };
            formatted.insert("content".into(), content);

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
                cached_tokens: openai_cached_tokens(usage),
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

        let result = read_sse_lines(resp, cancel, &mut |line: String| {
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
                    cached_tokens: openai_cached_tokens(usage),
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
