//! Anthropic Messages API Provider
//!
//! 移植自 TS `src/infrastructure/provider/anthropic.ts`（铁律 1：双引擎同语义）。
//!
//! ## ⚠️ 与 TS 的唯一有意分歧：显式缓存断点（`cache_control`）
//!
//! Anthropic 的前缀缓存**不像** OpenAI / DeepSeek 那样自动生效 —— 不显式打断点，
//! `usage.cache_read_input_tokens` **恒为 0**（等于每一轮都按输入价全额重算整段历史）。
//! 因此本文件在组装请求时打 3 个断点（官方上限 4 个），见 [`mark_tail_block`] 与 `build_request`
//! 里的三处断点注释。
//!
//! 这里**只改 Rust 侧**、不去同步 TS 的 `anthropic.ts`：TS 那份 buildRequest 已不在对话路径上
//! （anthropic 恒为原生 Provider，见 [`super::DefaultProviderFactory`]），只在 vitest 里跑；
//! 两边都实现会把「断点位置策略」变成两份要同步的状态，得不偿失。

use super::blocks::{anthropic_blocks, process_vision_content, slice_messages, text_of_content};
use super::sse::{read_sse_lines, SseItem};
use super::Provider;
use super::super::cancellation::CancellationToken;
use super::super::types::{
    ChatRequest, Message, ProgressThrottle, StreamEvent, TokenUsage, ToolUseContent,
    TOOL_PROGRESS_INTERVAL_MS,
};
use async_trait::async_trait;
use serde_json::{json, Value};

// ==================== Anthropic Provider ====================

/// 显式缓存断点的取值 —— 全仓库**唯一**写 `cache_control` 的地方。
///
/// 5 分钟 TTL；写入按 1.25x 输入价、命中按 0.1x 输入价计费（先读缓存，只写"上次断点之后的新内容"）。
fn cache_control_breakpoint() -> Value {
    json!({ "type": "ephemeral" })
}

/// 允许挂 `cache_control` 的块类型（**白名单**）。
///
/// 为什么用白名单而不是黑名单：块类型不对会被服务端**直接 400 掉整个请求** ——
/// 「顺手省钱的优化」绝对不能变成「聊天打不开」。`thinking` 块尤其不能挂。
const CACHEABLE_BLOCK_TYPES: [&str; 5] = ["text", "image", "tool_use", "tool_result", "document"];

/// 一个块能不能挂 `cache_control`。
///
/// 两道关：① 类型在白名单里；② 文本块的内容不能是空/空白。
/// 第 ② 条容易漏：块类型对了但正文为空时，服务端本就在「接受与拒绝」的边缘，此时再挂一个断点
/// 等于把一个已存在的边界情况变成 400（同样适用「宁可少一个断点」的口径）。
fn is_cacheable_tail(block: &Value) -> bool {
    let Some(kind) = block.get("type").and_then(Value::as_str) else {
        return false;
    };
    if !CACHEABLE_BLOCK_TYPES.contains(&kind) {
        return false;
    }
    if kind == "text" {
        return block
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty());
    }
    true
}

/// 给一条消息的**最后一个可缓存块**打上断点；打上返回 `true`。
///
/// 找不到可缓存块（`content` 不是数组 / 数组为空 / 末尾块不满足 [`is_cacheable_tail`]）时
/// **什么都不做** —— 少一个断点只是少省一点钱，不是错误。
///
/// `pub(super)`：与 `process_vision_content` 同理，供 `provider/tests.rs` 直接单测。
pub(super) fn mark_tail_block(message: &mut Value) -> bool {
    let Some(last) = message
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .and_then(|blocks| blocks.last_mut())
    else {
        return false;
    };
    if !is_cacheable_tail(last) {
        return false;
    }
    match last.as_object_mut() {
        Some(obj) => {
            obj.insert("cache_control".into(), cache_control_breakpoint());
            true
        }
        None => false,
    }
}

// 缓存断点的 3 个落点（官方上限 4 个；全部在 `build_request` 里就地打）：
//
// 1. **最后一个工具定义** —— 纯静态；只要工具集相同，跨会话也能复用；
// 2. **系统提示词块**（数组形态） —— 覆盖「工具 + 系统提示词」这一整段静态头部，会话内每轮复用；
// 3. **最后一条消息的末尾块**（`mark_tail_block`） —— 对话前缀随轮次增长，
//    命中「上一轮已缓存的整段历史」；这正是 Anthropic 顶级 `cache_control` 自动缓存的语义
//    （「断点落在最后一个可缓存块，随对话前移」），这里是它的手动等价实现。
//
// 为什么可以无脑打：前缀不足最小长度（多数模型 1024 token，部分 Haiku/Opus 型号更高）时
// 服务端**静默跳过**、不报错；且写入按段**增量**计费，1 号被 2 号覆盖也不重复花钱。

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
            // 数组形态（而非裸字符串）才能挂断点 —— 断点 ②（静态头部：工具 + 系统提示词）
            body["system"] = json!([{
                "type": "text",
                "text": system.trim(),
                "cache_control": cache_control_breakpoint(),
            }]);
        }
        body["temperature"] = Value::from(request.temperature);
        if !request.tools.is_empty() {
            let mut tools: Vec<Value> = request
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
            // 断点 ①：工具定义末尾（纯静态）
            if let Some(obj) = tools.last_mut().and_then(Value::as_object_mut) {
                obj.insert("cache_control".into(), cache_control_breakpoint());
            }
            body["tools"] = Value::Array(tools);
        }
        // 断点 ③：对话末尾（最后一条消息的最后一个可缓存块）—— 每轮向后移一格，
        // 于是这轮命中「上一轮已经写好的整段前缀」。
        if let Some(last) = body["messages"].as_array_mut().and_then(|m| m.last_mut()) {
            mark_tail_block(last);
        }
        if request.tool_choice == "none" {
            body["tool_choice"] = json!({ "type": "none" });
        }
        // thinking 模式控制（Anthropic extended thinking）—— 与 TS `anthropic.ts` 同语义
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
                // 读 / 写分开报：两者差 12.5 倍（命中 0.1x ↔ 写入 1.25x），账本要分列入账
                cached_tokens: Some(cache_read),
                cache_write_tokens: Some(cache_create),
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
        let text = resp.text().await.map_err(|e| format!("Failed to read the response: {}", e))?;
        if !status.is_success() {
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }
        let data: Value = serde_json::from_str(&text).map_err(|e| format!("Failed to parse the response: {}", e))?;
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
            let text = resp.text().await.map_err(|e| format!("Failed to read the error response: {}", e))?;
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }

        let mut current_event = String::new();
        let mut block_texts: std::collections::HashMap<usize, String> = Default::default();
        let mut tool_uses: std::collections::HashMap<usize, ToolUseContent> = Default::default();
        let mut input_partials: std::collections::HashMap<usize, String> = Default::default();
        let mut tool_fired = false;
        // 工具参数累积期的进度节流器（见 `StreamEvent::ToolArgsProgress`）
        let mut progress = ProgressThrottle::new(TOOL_PROGRESS_INTERVAL_MS);
        let mut thinking_buffer = String::new();
        let mut last_usage: Option<TokenUsage> = None;

        let result = read_sse_lines(resp, cancel, &mut |item: SseItem| {
            let line = match item {
                SseItem::Idle => {
                    // 静默期心跳（§27）：让引擎把节流器里扣着的正文尾部刷出去
                    on_event(StreamEvent::Idle);
                    return true;
                }
                SseItem::Line(l) => l,
            };
            let trimmed = line.trim();

            if let Some(rest) = trimmed.strip_prefix("event:") {
                current_event = rest.trim().to_string();
                return true;
            }

            if let Some(rest) = trimmed.strip_prefix("data:") {
                let data_str = rest.trim().to_string();
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
                                    let acc = input_partials.entry(index).or_default();
                                    acc.push_str(partial);
                                    // 参数累积期的进度上报（节流）：工具名在 content_block_start 时已知
                                    if progress.allow(crate::telemetry::now_ms()) {
                                        let name = tool_uses
                                            .get(&index)
                                            .map(|t| t.name.clone())
                                            .unwrap_or_default();
                                        on_event(StreamEvent::ToolArgsProgress {
                                            index,
                                            name,
                                            chars: acc.chars().count(),
                                        });
                                    }
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
                                // 读 / 写分开报（同 parse_response）
                                cached_tokens: Some(cache_read),
                                cache_write_tokens: Some(cache_create),
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
