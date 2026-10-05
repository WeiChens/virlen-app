//! `ai` 模式 —— 一次非流式模型调用生成摘要
//!
//! 为什么走 `Provider::chat`（非流式）而不是 `chat_stream`：摘要是一次性的短输出，不需要增量渲染，也不进
//! 对话消息列表（只记用量账本）。
//!
//! ## ⚠️ `tool_choice` 必须是 `auto`，绝不能用 `none`（2026-10-04 修订）
//!
//! 原实现用 `tool_choice = "none"` 表达「禁止模型发起工具调用」，**代价是前缀缓存**：
//! 服务端对 `tool_choice = "none"` 的请求**不渲染 tools 段落**，于是压缩请求的 prompt 从系统提示词
//! 之后立刻与聊天请求分歧 —— 自动前缀缓存（DeepSeek / OpenAI）与 GLM 的 `prompt_tokens_details`
//! 永远接不上，每次压缩都按输入价**全额重算**整段上下文。
//!
//! 实测（同一会话、相距数十秒的一次聊天与一次压缩）：
//! - `tool_choice = "none"`（旧）：压缩只命中 54.2%（且命中的 512 token ≈ 系统提示词那一小段），
//!   输入体量也只有聊天请求的 ~1/8（少了 tools 那一整段）；
//! - `tool_choice = "auto"`（现）：压缩命中 **98%+**，输入体量回到与聊天同一量级。
//!
//! 因此这里与聊天请求**同构**（同样 `auto` + 同样 `tools`），改用**契约护栏**兜住「模型真的发起
//! 工具调用 / 返回空正文」：见 [`AiSummary::contract_violation`]，由调用方（[`super::compress`]）
//! 回退 `raw` 模式 —— 既不吃缓存亏，也不让一次跑偏的输出污染摘要。

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
    /// `None` = 正常拿到摘要正文；`Some` = 模型违反「只输出摘要文本」的契约。
    ///
    /// 出现 `Some` 时 `content` **不可用**（空、或与工具调用混在一起），调用方应回退 `raw` 模式，
    /// 并用本次 `usage` / `duration_ms` 照常记账（调用真发生了，钱已经花掉）。
    pub contract_violation: Option<ContractViolation>,
}

/// AI 摘要的**契约违反**类型 —— 模型没按「只输出摘要文本」办。
///
/// 为什么需要它：`tool_choice = "auto"` 是**为了前缀缓存**（见模块头）才不得不用，代价是模型理论上
/// 仍可发起工具调用。压缩请求不在工具执行链路里（没人回填 tool 结果），真发生了只能丢弃这次输出。
/// 但**不能当硬错误**：调用方要回退 `raw` 并照常记账。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractViolation {
    /// 模型发起了工具调用（这轮输出不可用）
    ToolCalls,
    /// 正文为空 —— 把它当摘要会**清空整个历史**，必须回退
    EmptyContent,
}

impl ContractViolation {
    /// 埋点用的稳定短名（**不含任何正文**，见 `utils/telemetry` 的脱敏口径）
    pub fn as_str(self) -> &'static str {
        match self {
            ContractViolation::ToolCalls => "tool_calls",
            ContractViolation::EmptyContent => "empty_content",
        }
    }
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
        // ⚠️ 必须 `auto`：`none` 会让服务端不渲染 tools 段落 → 前缀缓存永远接不上（见模块头）。
        // 代价（模型真发起工具调用）由下面的契约护栏兜住。
        tool_choice: "auto".to_string(),
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

    // 契约护栏（见模块头）：`auto` 是换取前缀缓存的前提，这里把它兜住。
    // 顺序有意义 —— 「发起了工具调用」比「正文为空」更具体，优先报它（便于定位）。
    let contract_violation = if response
        .tool_calls
        .as_ref()
        .is_some_and(|calls| !calls.is_empty())
    {
        Some(ContractViolation::ToolCalls)
    } else if content.trim().is_empty() {
        Some(ContractViolation::EmptyContent)
    } else {
        None
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
                    cache_write_tokens: None,
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
        contract_violation,
    })
}
