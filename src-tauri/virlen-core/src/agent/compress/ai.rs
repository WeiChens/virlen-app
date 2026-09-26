//! `ai` 模式 —— 一次非流式模型调用生成摘要
//!
//! 为什么走 `Provider::chat`（非流式）而不是 `chat_stream`：摘要是一次性的短输出，不需要增量渲染，也不进
//! 对话消息列表（只记用量账本）。
//!
//! ⚠️ `tool_choice = "none"`：压缩请求不允许模型发起工具调用（它只该输出摘要文本）。

use crate::agent::cancellation::CancellationToken;
use crate::agent::prompts;
use crate::agent::provider::Provider;
use crate::agent::types::{ChatRequest, Message, Session, TokenUsage, ToolDefinition};
use crate::agent::compress::DEFAULT_SUMMARY_MAX_TOKENS;
use serde_json::Value;

/// 摘要调用结果
#[derive(Debug, Clone)]
pub struct AiSummary {
    /// 摘要正文
    pub content: String,
    /// 用量：优先 provider 回报的真实值，缺失时为本地估算
    pub usage: TokenUsage,
    /// `usage` 是否来自本地估算
    pub estimated: bool,
    /// 本次请求的墙钟耗时（含首字延迟）—— 供用量账本算 tok/s
    pub duration_ms: i64,
}

/// 消息 content → 参与 token 估算的文本（对齐 TS `estimateRequestTokens`）
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// 粗估一次请求的 prompt token（仅在 provider 不回报 usage 时兜底）
///
/// 口径与 TS `estimateRequestTokens` 一致：systemPrompt + 各消息正文 + 工具 schema
/// （工具 schema 随请求一起发出去，实打实占 prompt token）。
fn estimate_request_tokens(request: &ChatRequest) -> i64 {
    let mut parts: Vec<String> = Vec::new();
    if let Some(sp) = &request.system_prompt {
        parts.push(sp.clone());
    }
    for m in &request.messages {
        parts.push(content_text(&m.content));
    }
    if !request.tools.is_empty() {
        parts.push(serde_json::to_string(&request.tools).unwrap_or_default());
    }
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    crate::agent::compress::estimate_tokens_concat(&refs)
}

/// 摘要请求的 `max_tokens`。
///
/// 会话值落在 `(0, DEFAULT_SUMMARY_MAX_TOKENS]` 时用它，否则退到默认摘要上限。
/// 为什么不能直接用 `session.params.max_tokens`：GUI 会话默认是 `2000000`
/// （`DEFAULT_SESSION_PARAMS`，语义是「不限制输出」，聊天时由全局 `settings.maxTokens`
/// 另行覆盖），原样下发会被模型以 `Invalid max_tokens value, the valid range ...`（400）拒绝。
/// 摘要是一次短输出，钳到合理上限即可。
pub(super) fn summary_max_tokens(session_max: i64) -> i64 {
    if session_max > 0 && session_max <= DEFAULT_SUMMARY_MAX_TOKENS {
        session_max
    } else {
        DEFAULT_SUMMARY_MAX_TOKENS
    }
}

/// 生成摘要（不发流式、不落库、不记账 —— 记账由调用方做）
pub async fn summarize(
    session: &Session,
    messages: &[Message],
    tool_defs: &[ToolDefinition],
    provider: &dyn Provider,
    cancel: &CancellationToken,
) -> Result<AiSummary, String> {
    // 与 TS 同一条校验：会话上没有模型 / Provider 就直接报错（否则请求必然打不通）
    if session.model_id.trim().is_empty() || session.provider_config_id.trim().is_empty() {
        return Err("会话没有配置模型或 Provider".to_string());
    }

    // 摘要指令作为**最后一条 user 消息**追加（与 TS 一致）
    let mut req_messages = messages.to_vec();
    req_messages.push(Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: Value::String(prompts::COMPRESS_CONTEXT.to_string()),
        timestamp: crate::telemetry::now_ms(),
        ..Default::default()
    });

    let request = ChatRequest {
        model: session.model_id.clone(),
        messages: req_messages,
        system_prompt: Some(session.system_prompt.clone()),
        tools: tool_defs.to_vec(),
        temperature: session.params.temperature,
        top_p: session.params.top_p,
        // max_tokens：TS 传 undefined（用 provider 默认）；这里必须给**正数**
        //（provider 会无条件写进请求体），但**不能**直接用 `session.params.max_tokens` ——
        // GUI 会话默认 2000000，会被模型拒掉（400，见 [`summary_max_tokens`]）。
        max_tokens: summary_max_tokens(session.params.max_tokens),
        stream: false,
        tool_choice: "none".to_string(),
        reasoning_effort: None,
        // 压缩与 TS 同语义：不禁用思考（摘要本就是长输出）
        thinking: None,
    };

    let started = crate::telemetry::now_ms();
    let response = provider.chat(&request, cancel).await?;
    let duration_ms = crate::telemetry::now_ms() - started;

    let content = match &response.content {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };

    // 用量优先取 provider 的**真实值**（非流式响应三种协议都带 usage）；
    // 只有极少数兼容实现不返回时才退到本地估算 —— 那时才标 estimated。
    let (usage, estimated) = match response.usage {
        Some(u) => (u, false),
        None => {
            let prompt = estimate_request_tokens(&request);
            let completion = crate::agent::compress::estimate_tokens(&content);
            (
                TokenUsage {
                    prompt_tokens: prompt,
                    completion_tokens: completion,
                    total_tokens: prompt + completion,
                    cached_tokens: None,
                },
                true,
            )
        }
    };

    Ok(AiSummary {
        content,
        usage,
        estimated,
        duration_ms,
    })
}
