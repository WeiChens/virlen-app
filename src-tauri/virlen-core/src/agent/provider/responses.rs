//! OpenAI **Responses API** Provider — `POST {baseUrl}/responses`
//!
//! 与「OpenAI 兼容」（Chat Completions）并列的**独立协议**：端点、请求体、流式事件名都不一样，
//! 不能互相回退（回退 = 一次请求发两遍、计费两遍）。差异清单：
//!
//! | | Chat Completions | Responses |
//! |---|---|---|
//! | 端点 | `/chat/completions` | `/responses` |
//! | 系统提示 | `messages[0].role=system` | 顶层 `instructions` |
//! | 历史 | `messages[]` | `input[]`（message / function_call / function_call_output 并列的 item 列表） |
//! | 工具定义 | `{type:function, function:{name,…}}` | `{type:function, name,…}`（平铺） |
//! | 推理 | `reasoning_effort` | `reasoning: { effort, summary }` |
//! | 用量 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens`（缓存在 `input_tokens_details.cached_tokens`） |
//! | 流式 | `choices[].delta` + `[DONE]` | 命名事件 `response.output_text.delta` 等 + `response.completed` |
//!
//! 语义参照：历史分支 `feat/0914-responses-api` 的 TS 实现（`src/infrastructure/provider/responses.ts`
//! 前缀，从未合入 master）+ TS 侧同源移植 `src/infrastructure/provider/responses.ts`（铁律 1：两处同语义）。

use super::blocks::{process_vision_content, responses_user_content, slice_messages, text_of_content};
use super::sse::{read_sse_lines, SseItem};
use super::Provider;
use super::{json_body_bytes, RequestMetrics};
use super::super::cancellation::CancellationToken;
use super::super::types::{
    ChatRequest, Message, ProgressThrottle, StreamEvent, TokenUsage, ToolUseContent,
    TOOL_PROGRESS_INTERVAL_MS, VISION_IMAGE_ROLE,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;

/// 从 Responses 的 usage 里取出**缓存命中**的输入量。
///
/// 与 Chat Completions 同一个事实：缓存命中已算进 `input_tokens`（= 那边的 `prompt_tokens`），
/// 不单独取出来，账本里的缓存 token 永远是 0，缓存价永远用不上（见 `domain/usage`）。
/// 路径是 `input_tokens_details.cached_tokens`；负数量按「没报」处理。
fn responses_cached_tokens(usage: &Value) -> Option<i64> {
    let n = usage
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_i64)?;
    if n > 0 {
        Some(n)
    } else {
        None
    }
}

/// `usage` 对象 → `TokenUsage`（Responses 用 input/output 命名）
fn responses_usage(usage: &Value) -> TokenUsage {
    let input = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    TokenUsage {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(input + output),
        cached_tokens: responses_cached_tokens(usage),
        // 自动前缀缓存不计写入费，也没有写入量可报（与 Chat Completions 同口径）
        cache_write_tokens: None,
    }
}

/// 一条 `function_call` 的累积器
struct ToolAcc {
    /// `call_id`：**必须**用它回填历史（`function_call_output.call_id` 与 tool 消息的
    /// `tool_call_id` 是同一个值；`item.id` 只在响应内部有效，拿它配不上历史）
    call_id: String,
    name: String,
    args: String,
    emitted: bool,
}

/// 流式累积状态。
///
/// 把「一个 SSE data 字符串 → 状态更新 + 事件」从 IO 里拆出来：`chat_stream` 只负责读行，
/// 单测可以直接喂 JSON（否则解析逻辑只能靠起一个假服务端才能验证）。
struct StreamState {
    reasoning: String,
    /// key = item id（缺 id 时用 `output_index`）
    tools: HashMap<String, ToolAcc>,
    /// 工具出现顺序（HashMap 本身无序，emit 顺序必须稳定）
    order: Vec<String>,
    usage: Option<TokenUsage>,
    /// 结算只做一次（`response.completed` 与 `[DONE]` 都会走到）
    stopped: bool,
    /// 工具参数累积期的进度节流器
    progress: ProgressThrottle,
}

impl Default for StreamState {
    fn default() -> Self {
        Self {
            reasoning: String::new(),
            tools: HashMap::new(),
            order: Vec::new(),
            usage: None,
            stopped: false,
            progress: ProgressThrottle::new(TOOL_PROGRESS_INTERVAL_MS),
        }
    }
}

impl StreamState {
    fn new() -> Self {
        Self::default()
    }

    /// 处理一行 `data:` 后的 JSON（或 `[DONE]`）
    ///
    /// `?Sized`：调用方传进来的是 `&mut (dyn FnMut(StreamEvent) + Send)`（provider 回调），
    /// 没有这个约束就只能收具体闭包类型，实参是 trait object 时编译不过。
    fn handle<F: FnMut(StreamEvent) + ?Sized>(&mut self, data: &str, emit: &mut F) {
        if data == "[DONE]" {
            self.finish(emit);
            return;
        }
        let chunk: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return,
        };
        let type_ = chunk.get("type").and_then(Value::as_str).unwrap_or("");
        match type_ {
            "response.output_text.delta" => {
                if let Some(d) = chunk.get("delta").and_then(Value::as_str) {
                    if !d.is_empty() {
                        emit(StreamEvent::TextDelta(d.to_string()));
                    }
                }
            }
            // 思考内容：新版是 `reasoning_summary_text`（要求请求里带 `reasoning.summary`），
            // 旧版 / 兼容实现可能直接发 `reasoning_text`
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(d) = chunk.get("delta").and_then(Value::as_str) {
                    if !d.is_empty() {
                        self.reasoning.push_str(d);
                        emit(StreamEvent::ReasoningContentChange(self.reasoning.clone()));
                    }
                }
            }
            "response.output_item.added" => {
                if let Some(item) = chunk.get("item") {
                    if item.get("type").and_then(Value::as_str) == Some("function_call") {
                        let key = Self::item_key(item, &chunk);
                        self.register(key, item);
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                let key = chunk
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let delta = chunk
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(acc) = self.tools.get_mut(&key) {
                    acc.args.push_str(&delta);
                    if self.progress.allow(crate::telemetry::now_ms()) {
                        let chars = acc.args.chars().count();
                        let name = acc.name.clone();
                        let index = self.order.iter().position(|k| *k == key).unwrap_or(0);
                        emit(StreamEvent::ToolArgsProgress { index, name, chars });
                    }
                }
            }
            // 不带增量的一次性参数（个别实现只发 done）
            "response.function_call_arguments.done" => {
                let key = chunk
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let (Some(acc), Some(args)) = (
                    self.tools.get_mut(&key),
                    chunk.get("arguments").and_then(Value::as_str),
                ) {
                    acc.args = args.to_string();
                }
            }
            "response.output_item.done" => {
                if let Some(item) = chunk.get("item") {
                    if item.get("type").and_then(Value::as_str) == Some("function_call") {
                        let key = Self::item_key(item, &chunk);
                        // item.done 可能先于 added 到达（快模型 / 兜底实现）→ 现场登记
                        if !self.tools.contains_key(&key) {
                            self.register(key.clone(), item);
                        }
                        if let Some(acc) = self.tools.get_mut(&key) {
                            if let Some(args) = item
                                .get("arguments")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                            {
                                acc.args = args.to_string();
                            }
                            if let Some(name) = item
                                .get("name")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                            {
                                acc.name = name.to_string();
                            }
                            if let Some(cid) = item
                                .get("call_id")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                            {
                                acc.call_id = cid.to_string();
                            }
                        }
                        self.emit_tool(&key, emit);
                    }
                }
            }
            "response.completed" | "response.incomplete" => {
                if let Some(usage) = chunk
                    .get("response")
                    .and_then(|r| r.get("usage"))
                    .filter(|u| !u.is_null())
                {
                    self.usage = Some(responses_usage(usage));
                }
                self.finish(emit);
            }
            "response.failed" | "response.error" | "error" => {
                let msg = chunk
                    .get("response")
                    .and_then(|r| r.get("error"))
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        chunk
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(Value::as_str)
                    })
                    .or_else(|| chunk.get("message").and_then(Value::as_str))
                    .unwrap_or("Responses API error");
                emit(StreamEvent::Error(msg.to_string()));
            }
            _ => {}
        }
    }

    /// item 的稳定 key：优先 `item.id`，退到 `output_index`
    fn item_key(item: &Value, chunk: &Value) -> String {
        item.get("id")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| {
                chunk
                    .get("output_index")
                    .and_then(Value::as_i64)
                    .map(|i| format!("idx-{}", i))
            })
            .unwrap_or_else(|| "idx-0".to_string())
    }

    fn register(&mut self, key: String, item: &Value) {
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
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
        if !self.order.contains(&key) {
            self.order.push(key.clone());
        }
        self.tools.insert(
            key,
            ToolAcc {
                call_id,
                name,
                args,
                emitted: false,
            },
        );
    }

    /// 发出一次 `ToolUse`（同一条只发一次）
    fn emit_tool<F: FnMut(StreamEvent) + ?Sized>(&mut self, key: &str, emit: &mut F) {
        let payload = match self.tools.get_mut(key) {
            Some(acc) if !acc.emitted => {
                acc.emitted = true;
                let input = serde_json::from_str(&acc.args).unwrap_or(Value::Null);
                Some(ToolUseContent {
                    type_: "tool_use".into(),
                    id: acc.call_id.clone(),
                    name: acc.name.clone(),
                    input,
                })
            }
            _ => None,
        };
        if let Some(tool_use) = payload {
            emit(StreamEvent::ToolUse(tool_use));
        }
    }

    /// 结算：补发尚未发出的工具调用 + 一条 `MessageStop`
    fn finish<F: FnMut(StreamEvent) + ?Sized>(&mut self, emit: &mut F) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let keys = self.order.clone();
        for key in keys {
            self.emit_tool(&key, emit);
        }
        emit(StreamEvent::MessageStop {
            reasoning_content: if self.reasoning.is_empty() {
                None
            } else {
                Some(self.reasoning.clone())
            },
            usage: self.usage.clone(),
        });
    }
}

// ==================== Responses Provider ====================

pub struct NativeResponsesProvider {
    api_key: String,
    base_url: String,
    http: reqwest::Client,
    /// 最近一次请求的传输侧事实（引擎取走后清空，见 `Provider::take_request_metrics`）
    metrics: std::sync::Mutex<Option<RequestMetrics>>,
}

impl NativeResponsesProvider {
    pub fn new(_name: &str, api_key: &str, base_url: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
            metrics: std::sync::Mutex::new(None),
        }
    }

    fn store_metrics(&self, metrics: RequestMetrics) {
        *self.metrics.lock().unwrap() = Some(metrics);
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

    /// 构建 Responses 请求体
    ///
    /// 与 Chat Completions 的两个**不能省**的差别：
    /// - `store: false`：历史由本机 SQLite 托管；开存储会让每条消息都上传到服务端留 30 天，
    ///   且我们不用 `previous_response_id`（没有收益，只有隐私面）。
    /// - 助手正文用 `output_text`、助手工具调用是**顶层** `function_call` item：把工具调用塞进
    ///   assistant 消息里会被服务端判成非法 input。
    pub(super) fn build_request(&self, request: &ChatRequest) -> Value {
        let mut input: Vec<Value> = Vec::new();

        for msg in slice_messages(&request.messages) {
            // summary / feedback 角色：转成 user 消息（协议里没有这两个 role）
            if msg.role == "summary" || msg.role == "feedback" {
                input.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": text_of_content(&msg.content) }],
                }));
                continue;
            }

            // 工具交付给模型的图片（`role` 只是持久化载体，界面不渲染）：
            // Responses 的 `function_call_output.output` 只能是字符串，放不下图片，
            // 因此投影成一条独立的 user 消息（紧跟在工具结果之后，语义仍正确）
            if msg.role == VISION_IMAGE_ROLE {
                input.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": responses_user_content(&msg.content),
                }));
                continue;
            }

            if msg.role == "assistant" {
                // 只拼 text 块（与 TS 侧同一口径，见 `Message::text_content`）：
                // `output_text` 只接受纯文本，把块结构原样丢过去会被判非法
                let text = msg.text_content();
                // Responses 的 message content 不允许为空数组 → 没正文就不发这条 item
                if !text.is_empty() {
                    input.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                if let Some(tcs) = &msg.tool_calls {
                    for tc in tcs {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": tc.id,
                            "name": tc.name,
                            "arguments": serde_json::to_string(&tc.input).unwrap_or_default(),
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

            // user：本地图片伪视觉分析结果优先（纯文本模型不带原图）
            let content = match process_vision_content(msg) {
                Some(processed) => responses_user_content(&processed),
                None => responses_user_content(&msg.content),
            };
            input.push(json!({
                "type": "message",
                "role": "user",
                "content": content,
            }));
        }

        let mut body = json!({
            "model": request.model,
            "input": input,
            "stream": request.stream,
            // 见本函数文档：历史本机托管，不用服务端存储
            "store": false,
        });

        if let Some(sp) = &request.system_prompt {
            body["instructions"] = Value::String(sp.clone());
        }
        // temperature / top_p 与 Chat Completions 一样**无条件**下发（两协议同口径：
        // 推理类模型不认这两个参数是服务端的事，两个 provider 一起改才对得上）
        body["temperature"] = json!(request.temperature);
        body["top_p"] = json!(request.top_p);
        if request.max_tokens > 0 {
            body["max_output_tokens"] = json!(request.max_tokens);
        }

        if !request.tools.is_empty() {
            // 工具定义是**平铺**的（没有 `function` 这层）
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

        // 思考控制：`thinking:false` 用 `effort: none` 显式禁用（避免 maxTokens 被思考吃光）；
        // 指定档位时顺带要 `summary: auto` —— 不带它服务端**不产** reasoning summary 事件，
        // 界面上的「思考过程」就永远是空的。
        if request.thinking == Some(false) {
            body["reasoning"] = json!({ "effort": "none" });
        } else if let Some(re) = &request.reasoning_effort {
            body["reasoning"] = json!({ "effort": re, "summary": "auto" });
        }

        body
    }

    /// 解析非流式响应：`output[]` = message / reasoning / function_call 三类 item
    fn parse_response(&self, data: &Value) -> Message {
        let mut message = Message {
            id: uuid::Uuid::new_v4().to_string(),
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

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls: Vec<ToolUseContent> = Vec::new();

        if let Some(items) = data.get("output").and_then(Value::as_array) {
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("message") => {
                        if let Some(parts) = item.get("content").and_then(Value::as_array) {
                            for part in parts {
                                if part.get("type").and_then(Value::as_str) == Some("output_text") {
                                    text.push_str(
                                        part.get("text").and_then(Value::as_str).unwrap_or(""),
                                    );
                                }
                            }
                        }
                    }
                    Some("function_call") => {
                        let id = item
                            .get("call_id")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
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
                            .unwrap_or("{}");
                        tool_calls.push(ToolUseContent {
                            type_: "tool_use".into(),
                            id,
                            name,
                            input: serde_json::from_str(args).unwrap_or(Value::Null),
                        });
                    }
                    Some("reasoning") => {
                        if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                            for part in summary {
                                reasoning.push_str(
                                    part.get("text").and_then(Value::as_str).unwrap_or(""),
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        message.content = Value::String(text);
        if !tool_calls.is_empty() {
            message.tool_calls = Some(tool_calls);
        }
        if !reasoning.is_empty() {
            message.reasoning_content = Some(reasoning);
        }
        if let Some(usage) = data.get("usage").filter(|u| !u.is_null()) {
            message.usage = Some(responses_usage(usage));
        }
        message
    }

    fn endpoint(&self) -> String {
        format!("{}/responses", self.base_url)
    }
}

#[async_trait]
impl Provider for NativeResponsesProvider {
    fn take_request_metrics(&self) -> Option<RequestMetrics> {
        self.metrics.lock().unwrap().take()
    }

    async fn chat(
        &self,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Message, String> {
        let mut body = self.build_request(request);
        body["stream"] = Value::Bool(false);
        let request_bytes = json_body_bytes(&body);

        let started = crate::telemetry::now_ms();
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            r = self.http.post(self.endpoint()).headers(self.headers()).json(&body).send()
                => r.map_err(|e| format!("API Error: {}", e))?,
        };
        let response_start_ms = (crate::telemetry::now_ms() - started).max(1);

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read the response: {}", e))?;
        // 非流式只能拿到「收完整个响应」的时刻，首字节无法与读取耗时分开 → 不采集
        self.store_metrics(RequestMetrics {
            request_bytes,
            response_start_ms: Some(response_start_ms),
            first_byte_ms: None,
        });
        if !status.is_success() {
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }
        let data: Value =
            serde_json::from_str(&text).map_err(|e| format!("Failed to parse the response: {}", e))?;
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
        let request_bytes = json_body_bytes(&body);

        let started = crate::telemetry::now_ms();
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err("cancelled".into()),
            r = self.http.post(self.endpoint()).headers(self.headers()).json(&body).send()
                => r.map_err(|e| format!("API Error: {}", e))?,
        };
        let response_start_ms = (crate::telemetry::now_ms() - started).max(1);
        let status = resp.status();
        if !status.is_success() {
            let text = resp
                .text()
                .await
                .map_err(|e| format!("Failed to read the error response: {}", e))?;
            return Err(format!("API Error ({}): {}", status.as_u16(), text));
        }

        let mut state = StreamState::new();
        let mut first_byte_ms: Option<i64> = None;

        let result = read_sse_lines(resp, cancel, &mut |item: SseItem| {
            let line = match item {
                SseItem::Idle => {
                    // 静默期心跳（与 openai 同一口径，见 `provider/sse.rs`）
                    on_event(StreamEvent::Idle);
                    return true;
                }
                SseItem::Line(l) => {
                    if first_byte_ms.is_none() {
                        first_byte_ms = Some((crate::telemetry::now_ms() - started).max(1));
                    }
                    l
                }
            };
            let trimmed = line.trim();
            if !trimmed.starts_with("data:") {
                return true;
            }
            state.handle(trimmed[5..].trim(), on_event);
            true
        })
        .await;

        self.store_metrics(RequestMetrics {
            request_bytes,
            response_start_ms: Some(response_start_ms),
            first_byte_ms,
        });
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(messages: Vec<Message>) -> ChatRequest {
        ChatRequest {
            model: "gpt-5".into(),
            messages,
            system_prompt: Some("SYS".into()),
            tools: Vec::new(),
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: 100,
            stream: false,
            tool_choice: String::new(),
            reasoning_effort: None,
            thinking: None,
        }
    }

    fn msg(role: &str, content: Value) -> Message {
        Message {
            role: role.into(),
            content,
            ..Default::default()
        }
    }

    fn provider() -> NativeResponsesProvider {
        NativeResponsesProvider::new("p", "k", "https://api.openai.test/v1/")
    }

    /// 系统提示走 `instructions`、user 正文包成 `input_text`、`store:false` 必须在
    #[test]
    fn build_request_uses_instructions_and_input_items() {
        let body = provider().build_request(&request(vec![msg("user", json!("hi"))]));
        assert_eq!(body["instructions"], json!("SYS"));
        assert_eq!(body["store"], json!(false));
        assert_eq!(body["model"], json!("gpt-5"));
        assert_eq!(body["max_output_tokens"], json!(100));
        let input = body["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[0]["role"], json!("user"));
        assert_eq!(
            input[0]["content"][0],
            json!({ "type": "input_text", "text": "hi" })
        );
    }

    /// assistant 的工具调用是**顶层** `function_call` item，工具结果是 `function_call_output`
    #[test]
    fn build_request_lifts_tool_calls_to_top_level_items() {
        let assistant = Message {
            tool_calls: Some(vec![ToolUseContent {
                type_: "tool_use".into(),
                id: "call_1".into(),
                name: "read_file".into(),
                input: json!({ "path": "a.txt" }),
            }]),
            ..msg("assistant", json!("看看"))
        };
        let tool = Message {
            tool_call_id: Some("call_1".into()),
            ..msg("tool", json!("内容"))
        };
        let body = provider().build_request(&request(vec![assistant, tool]));
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[0]["role"], json!("assistant"));
        assert_eq!(input[0]["content"][0]["type"], json!("output_text"));
        assert_eq!(input[1]["type"], json!("function_call"));
        assert_eq!(input[1]["call_id"], json!("call_1"));
        assert_eq!(input[1]["name"], json!("read_file"));
        assert_eq!(input[1]["arguments"], json!("{\"path\":\"a.txt\"}"));
        assert_eq!(input[2]["type"], json!("function_call_output"));
        assert_eq!(input[2]["call_id"], json!("call_1"));
        assert_eq!(input[2]["output"], json!("内容"));
    }

    /// 工具定义平铺（没有 `function` 嵌套层）
    #[test]
    fn build_request_flattens_tool_definitions() {
        use super::super::super::types::{ToolDefinition, ToolParameters};
        let mut req = request(vec![msg("user", json!("hi"))]);
        req.tools = vec![ToolDefinition {
            name: "read_file".into(),
            label: None,
            description: "读文件".into(),
            parameters: ToolParameters {
                type_: "object".into(),
                properties: json!({ "path": { "type": "string" } }),
                required: vec!["path".into()],
                one_of: None,
                extra: Default::default(),
            },
        }];
        let body = provider().build_request(&req);
        assert_eq!(body["tools"][0]["type"], json!("function"));
        assert_eq!(body["tools"][0]["name"], json!("read_file"));
        assert!(body["tools"][0].get("function").is_none());
    }

    /// 图片块映射成 `input_image`（`image_url` 是字符串）
    #[test]
    fn build_request_maps_image_block() {
        let body = provider().build_request(&request(vec![msg(
            "user",
            json!([
                { "type": "text", "text": "看图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            ]),
        )]));
        let content = &body["input"][0]["content"];
        assert_eq!(content[0]["type"], json!("input_text"));
        assert_eq!(content[1]["type"], json!("input_image"));
        assert_eq!(content[1]["image_url"], json!("data:image/png;base64,AAA"));
    }

    /// 推理档位走 `reasoning.effort`，并带上 `summary:auto`（否则没有思考内容事件）
    #[test]
    fn build_request_maps_reasoning_effort_and_summary() {
        let mut req = request(vec![msg("user", json!("hi"))]);
        req.reasoning_effort = Some("high".into());
        let body = provider().build_request(&req);
        assert_eq!(body["reasoning"], json!({ "effort": "high", "summary": "auto" }));

        // thinking:false 优先于 reasoningEffort，且不要求 summary
        let mut off = request(vec![msg("user", json!("hi"))]);
        off.reasoning_effort = Some("high".into());
        off.thinking = Some(false);
        let body = provider().build_request(&off);
        assert_eq!(body["reasoning"], json!({ "effort": "none" }));
    }

    /// 喂一串 SSE data 行，收集产生的事件（闭包只在单次调用内借用 `events`，避免长命借用）
    fn drive(state: &mut StreamState, lines: &[&str]) -> Vec<StreamEvent> {
        let mut events: Vec<StreamEvent> = Vec::new();
        for line in lines {
            state.handle(line, &mut |e| events.push(e));
        }
        events
    }

    /// 流式：正文增量 / 思考增量 / 工具调用（arguments 分片）都要正确投影
    #[test]
    fn stream_accumulates_text_reasoning_and_tool_calls() {
        let mut state = StreamState::new();
        let events = drive(
            &mut state,
            &[
                r#"{"type":"response.reasoning_summary_text.delta","delta":"想"}"#,
                r#"{"type":"response.output_text.delta","delta":"你"}"#,
                r#"{"type":"response.output_item.added","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_9","name":"read_file","arguments":""}}"#,
                r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":"}"#,
                r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\"a.txt\"}"}"#,
                r#"{"type":"response.output_item.done","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_9","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}"#,
                r#"{"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13,"input_tokens_details":{"cached_tokens":4}}}}"#,
                // 之后的 [DONE] 不得再结算一次
                "[DONE]",
            ],
        );

        let tool = events
            .iter()
            .find_map(|e| match e {
                StreamEvent::ToolUse(t) => Some(t.clone()),
                _ => None,
            })
            .expect("必须发出 ToolUse");
        assert_eq!(tool.id, "call_9");
        assert_eq!(tool.name, "read_file");
        assert_eq!(tool.input, json!({ "path": "a.txt" }));

        // 工具调用只发一次
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, StreamEvent::ToolUse(_)))
                .count(),
            1
        );

        let stop = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::MessageStop {
                    reasoning_content,
                    usage,
                } => Some((reasoning_content.clone(), usage.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(stop.len(), 1, "[DONE] 不得重复结算");
        assert_eq!(stop[0].0.as_deref(), Some("想"));
        let usage = stop[0].1.as_ref().expect("usage");
        assert_eq!(usage.prompt_tokens, 10);
        assert_eq!(usage.completion_tokens, 3);
        assert_eq!(usage.cached_tokens, Some(4));
    }

    /// 失败事件要把服务端的原因带出来
    #[test]
    fn stream_reports_failure_message() {
        let mut state = StreamState::new();
        let events = drive(
            &mut state,
            &[r#"{"type":"response.failed","response":{"error":{"message":"model not found"}}}"#],
        );
        assert!(matches!(&events[0], StreamEvent::Error(m) if m == "model not found"));
    }

    /// 工具参数不是合法 JSON（截断 / 分片异常）→ `input` 给 `null`。
    ///
    /// ⚠️ 与 TS `responses.ts::emitTool` 逐字同口径（铁律 1）：两侧给工具执行器的输入必须相同。
    #[test]
    fn stream_invalid_tool_arguments_become_null() {
        let mut state = StreamState::new();
        let events = drive(
            &mut state,
            &[
                r#"{"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\"path\":"}}"#,
            ],
        );
        let tool = events
            .iter()
            .find_map(|e| match e {
                StreamEvent::ToolUse(t) => Some(t.clone()),
                _ => None,
            })
            .expect("必须发出 ToolUse");
        assert!(tool.input.is_null(), "非法 JSON 要给 null，实际: {:?}", tool.input);
    }

    /// 非流式：output[] 里三类 item 都要解析
    #[test]
    fn parse_response_reads_output_items() {
        let data = json!({
            "output": [
                { "type": "reasoning", "summary": [{ "type": "summary_text", "text": "思考" }] },
                { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "答" }] },
                { "type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "{\"path\":\"a\"}" }
            ],
            "usage": { "input_tokens": 5, "output_tokens": 2, "total_tokens": 7 }
        });
        let m = provider().parse_response(&data);
        assert_eq!(m.text_content(), "答");
        assert_eq!(m.reasoning_content.as_deref(), Some("思考"));
        let tc = m.tool_calls.as_ref().expect("tool_calls");
        assert_eq!(tc[0].id, "call_1");
        assert_eq!(tc[0].input, json!({ "path": "a" }));
        assert_eq!(m.usage.as_ref().unwrap().total_tokens, 7);
    }

    /// 端点不能重复斜杠（base_url 末尾 `/` 已在构造时剥掉）
    #[test]
    fn endpoint_has_no_double_slash() {
        assert_eq!(
            provider().endpoint(),
            "https://api.openai.test/v1/responses"
        );
    }
}
