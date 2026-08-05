//! LLM 轮次编排 — 合并「LLM 调用 → 工具执行」为一个共享步骤
//!
//! 移植自 `src/domain/engine/llm-loop.ts`。

use super::bridge::AgentBridgeState;
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::llm_round::{do_llm_round, finalize_assistant_message};
use super::provider::Provider;
use super::tool_executor::{create_run, execute_tool_steps};
use super::types::{Message, NativeToolSecurity, Run, Session, ToolCallContext, ToolDefinition};

pub struct ExecuteLlmRoundParams<'a> {
    pub session: &'a Session,
    pub provider: &'a dyn Provider,
    pub tool_defs: &'a [ToolDefinition],
    pub messages: &'a [Message],
    pub session_id: &'a str,
    pub cancel: &'a CancellationToken,
    pub sink: &'a dyn EventSink,
    pub bridge: &'a AgentBridgeState,
    pub skills: Option<Vec<String>>,
    /// 原生工具安全配置（None 时工具全部走 JS 桥）
    pub security: Option<NativeToolSecurity>,
    pub effective_max_tokens: i64,
    pub reasoning_effort: Option<String>,
    pub persist_snapshot: Option<&'a (dyn Fn(&str, &Run) + Sync + Send)>,
    pub clear_snapshot: Option<&'a (dyn Fn(&str) + Sync + Send)>,
}

pub struct ExecuteLlmRoundResult {
    /// 非 None 表示本轮有 tool calls
    pub ctx: Option<ToolCallContext>,
    pub assistant_message: Message,
    pub tool_result_messages: Vec<Message>,
    /// 是否被暂停（用户暂存）或取消
    pub paused: bool,
}

/// 执行一轮「LLM 调用 →（如有 tool calls）执行工具」。
pub async fn execute_llm_round(
    params: ExecuteLlmRoundParams<'_>,
) -> Result<ExecuteLlmRoundResult, String> {
    let ExecuteLlmRoundParams {
        session,
        provider,
        tool_defs,
        messages,
        session_id,
        cancel,
        sink,
        bridge,
        skills,
        security,
        effective_max_tokens,
        reasoning_effort,
        persist_snapshot,
        clear_snapshot,
    } = params;

    let model = session.model_id.clone();

    let output = do_llm_round(
        session,
        provider,
        tool_defs,
        messages,
        cancel,
        sink,
        session_id,
        Some(effective_max_tokens),
        reasoning_effort.as_deref(),
    )
    .await?;

    // 没有 tool calls：LLM 直接给出文字回答
    let ctx = match output.ctx {
        None => {
            return Ok(ExecuteLlmRoundResult {
                ctx: None,
                assistant_message: output.assistant_message,
                tool_result_messages: Vec::new(),
                paused: false,
            })
        }
        Some(ctx) => ctx,
    };

    // 有 tool calls：结束 streaming 标记
    finalize_assistant_message(&ctx.assistant_message, &model, sink, session_id);

    let mut run = create_run(session_id, &ctx);
    if let Some(p) = persist_snapshot {
        p(session_id, &run);
    }

    let persist_closure: Option<Box<dyn Fn(&Run) + Sync + Send>> = persist_snapshot.map(|p| {
        let c = move |r: &Run| {
            p(session_id, r);
        };
        Box::new(c) as Box<dyn Fn(&Run) + Sync + Send>
    });
    let persist_ref: Option<&(dyn Fn(&Run) + Sync + Send)> = persist_closure.as_deref();

    let (completed, tool_result_messages) = execute_tool_steps(
        &mut run,
        cancel,
        sink,
        bridge,
        skills,
        security,
        persist_ref,
    )
    .await;

    if !completed {
        // 被暂停（用户暂存）或取消 — 快照保留，供断点恢复
        return Ok(ExecuteLlmRoundResult {
            ctx: Some(ctx.clone()),
            assistant_message: ctx.assistant_message.clone(),
            tool_result_messages,
            paused: true,
        });
    }

    if let Some(c) = clear_snapshot {
        c(session_id);
    }
    Ok(ExecuteLlmRoundResult {
        ctx: Some(ctx.clone()),
        assistant_message: ctx.assistant_message.clone(),
        tool_result_messages,
        paused: false,
    })
}
