//! LLM 轮次处理 — 流式/非流式请求、tool_use 收集
//!
//! 移植自 `src/domain/engine/llm-round.ts`，合并了 llm-loop.ts 中的
//! assistant 消息拦截逻辑（Rust 直接构造并返回最终 assistant 消息）。

use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::provider::Provider;
use super::types::{
    AgentEvent, ChatRequest, Message, Session, StreamEvent, ToolCallContext, ToolDefinition,
    ToolUseContent,
};
use serde_json::json;
use serde_json::Value;

pub struct LlmRoundOutput {
    /// 非 None 表示本轮有 tool calls
    pub ctx: Option<ToolCallContext>,
    /// 本轮最终 assistant 消息
    pub assistant_message: Message,
}

/// 执行一轮 LLM 调用（流式 / 非流式），收集 text + tool_calls
pub async fn do_llm_round(
    session: &Session,
    provider: &dyn Provider,
    tool_defs: &[ToolDefinition],
    current_messages: &[Message],
    cancel: &CancellationToken,
    sink: &dyn EventSink,
    session_id: &str,
    override_max_tokens: Option<i64>,
    reasoning_effort: Option<&str>,
) -> Result<LlmRoundOutput, String> {
    let model = session.model_id.clone();
    let system_prompt = if session.system_prompt.trim().is_empty() {
        "你是一个有用的 AI 助手。".to_string()
    } else {
        session.system_prompt.clone()
    };

    let assistant_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "assistant".to_string(),
        content: Value::String(String::new()),
        timestamp: now_ms(),
        streaming: Some(true),
        ..Default::default()
    };

    // 通知前端创建 assistant 消息（chat-service 会持久化）
    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "assistant_message_created",
            json!({ "message": assistant_message }),
        ),
    );

    let mut ctx = ToolCallContext {
        assistant_message: assistant_message.clone(),
        tool_uses: Vec::new(),
        round_content: String::new(),
        reasoning_content: String::new(),
    };

    // 过滤掉当前 assistant 消息（避免重复）
    let messages: Vec<Message> = current_messages
        .iter()
        .filter(|m| m.id != assistant_message.id)
        .cloned()
        .collect();

    let request = ChatRequest {
        model: model.clone(),
        messages,
        system_prompt: Some(system_prompt),
        tools: tool_defs.to_vec(),
        temperature: session.params.temperature,
        top_p: session.params.top_p,
        max_tokens: override_max_tokens.unwrap_or(session.params.max_tokens),
        stream: session.params.stream,
        tool_choice: "auto".to_string(),
        reasoning_effort: reasoning_effort.map(String::from),
    };

    if session.params.stream {
        handle_streaming(
            provider,
            &request,
            &mut ctx,
            &model,
            cancel,
            sink,
            session_id,
        )
        .await?;
    } else {
        handle_non_streaming(provider, &request, &mut ctx, cancel).await?;
    }

    // 没有 tool calls → 结束循环
    if ctx.tool_uses.is_empty() {
        finalize_assistant_message(&ctx.assistant_message, &model, sink, session_id);
        return Ok(LlmRoundOutput {
            ctx: None,
            assistant_message: ctx.assistant_message,
        });
    }

    Ok(LlmRoundOutput {
        ctx: Some(ctx),
        assistant_message,
    })
}

/// 流式 LLM 调用处理
async fn handle_streaming(
    provider: &dyn Provider,
    request: &ChatRequest,
    ctx: &mut ToolCallContext,
    model: &str,
    cancel: &CancellationToken,
    sink: &dyn EventSink,
    session_id: &str,
) -> Result<(), String> {
    let mut reasoning_start: Option<i64> = None;

    let mut on_event = |event: StreamEvent| match event {
        StreamEvent::TextDelta(delta) => {
            // 首次输出正式内容 = 思考结束
            if let Some(start) = reasoning_start.take() {
                if ctx.assistant_message.reasoning_elapsed_ms.is_none() {
                    ctx.assistant_message.reasoning_elapsed_ms = Some(now_ms() - start);
                    sync_assistant(ctx, model, sink, session_id);
                }
            }
            ctx.round_content.push_str(&delta);
            let current = ctx.assistant_message.text_content();
            ctx.assistant_message.content = Value::String(current + &delta);
            sync_assistant(ctx, model, sink, session_id);
            sink.emit_agent_event(
                session_id,
                &AgentEvent::new(
                    "stream_event",
                    json!({
                        "delta": delta,
                        "fullContent": ctx.assistant_message.text_content(),
                    }),
                ),
            );
        }
        StreamEvent::ToolUse(tool_use) => {
            if collect_tool_use(ctx, tool_use, sink, session_id) {
                sync_assistant(ctx, model, sink, session_id);
            }
        }
        StreamEvent::Error(err) => {
            sink.emit_agent_event(session_id, &AgentEvent::error(err));
        }
        StreamEvent::ReasoningContentChange(rc) => {
            if reasoning_start.is_none() {
                reasoning_start = Some(now_ms());
            }
            ctx.reasoning_content = rc.clone();
            ctx.assistant_message.reasoning_content = Some(rc.clone());
            sync_assistant(ctx, model, sink, session_id);
            sink.emit_agent_event(
                session_id,
                &AgentEvent::new("stream_event", json!({ "reasoningContent": rc })),
            );
        }
        StreamEvent::MessageStop {
            reasoning_content,
            usage,
        } => {
            // 流结束，若思考尚未结算则在此结算
            if let Some(start) = reasoning_start.take() {
                if ctx.assistant_message.reasoning_elapsed_ms.is_none() {
                    ctx.assistant_message.reasoning_elapsed_ms = Some(now_ms() - start);
                    sync_assistant(ctx, model, sink, session_id);
                }
            }
            if let Some(rc) = reasoning_content {
                ctx.reasoning_content = rc.clone();
                ctx.assistant_message.reasoning_content = Some(rc);
                sync_assistant(ctx, model, sink, session_id);
            }
            if let Some(u) = usage {
                ctx.assistant_message.usage = Some(u);
                sync_assistant(ctx, model, sink, session_id);
            }
        }
    };

    provider
        .chat_stream(request, cancel, &mut on_event)
        .await
}

/// 非流式 LLM 调用处理
async fn handle_non_streaming(
    provider: &dyn Provider,
    request: &ChatRequest,
    ctx: &mut ToolCallContext,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let response = provider.chat(request, cancel).await?;
    if let Value::String(s) = &response.content {
        ctx.round_content = s.clone();
        ctx.assistant_message.content = Value::String(s.clone());
    }
    if let Some(tcs) = &response.tool_calls {
        ctx.tool_uses.extend(tcs.clone());
        ctx.assistant_message.tool_calls = Some(tcs.clone());
    }
    Ok(())
}

/// 收集 tool_use，去重并同步到 assistant 消息。
/// 返回 true 表示 assistant 消息新增了 tool_call（需要触发 sync 事件）
fn collect_tool_use(
    ctx: &mut ToolCallContext,
    tool_use: ToolUseContent,
    sink: &dyn EventSink,
    session_id: &str,
) -> bool {
    let exists = ctx.tool_uses.iter().any(|t| t.id == tool_use.id);
    if !exists {
        ctx.tool_uses.push(tool_use.clone());
    }
    let already_in_assistant = ctx
        .assistant_message
        .tool_calls
        .as_ref()
        .map_or(false, |tcs| tcs.iter().any(|t| t.id == tool_use.id));
    let needs_sync = if !already_in_assistant {
        ctx.assistant_message
            .tool_calls
            .get_or_insert_with(Vec::new)
            .push(tool_use.clone());
        true
    } else {
        false
    };
    sink.emit_agent_event(session_id, &AgentEvent::new("tool_call", json!(tool_use)));
    needs_sync
}

/// 同步 assistant 消息增量到前端
fn sync_assistant(ctx: &ToolCallContext, model: &str, sink: &dyn EventSink, session_id: &str) {
    let msg = &ctx.assistant_message;
    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "assistant_message_updated",
            json!({
                "messageId": msg.id,
                "patch": {
                    "content": msg.content,
                    "streaming": msg.streaming.unwrap_or(false),
                    "toolCalls": msg.tool_calls,
                    "reasoningContent": msg.reasoning_content,
                    "reasoningElapsedMs": msg.reasoning_elapsed_ms,
                    "usage": msg.usage,
                    "model": model,
                }
            }),
        ),
    );
}

/// 收到 tool calls 后结束 assistant 消息的 streaming 状态（通过事件通知）
pub fn finalize_assistant_message(
    assistant_message: &Message,
    model: &str,
    sink: &dyn EventSink,
    session_id: &str,
) {
    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "assistant_message_updated",
            json!({
                "messageId": assistant_message.id,
                "patch": {
                    "content": assistant_message.content,
                    "streaming": false,
                    "toolCalls": assistant_message.tool_calls,
                    "reasoningContent": assistant_message.reasoning_content,
                    "reasoningElapsedMs": assistant_message.reasoning_elapsed_ms,
                    "usage": assistant_message.usage,
                    "model": model,
                }
            }),
        ),
    );
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
