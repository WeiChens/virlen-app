//! LLM 轮次编排 — 合并「LLM 调用 → 工具执行」为一个共享步骤
//!
//! 移植自 `src/domain/engine/llm-loop.ts`。

use super::bridge::AgentBridgeState;
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::host::HostEnv;
use super::llm_round::{do_llm_round, finalize_assistant_message};
use super::provider::Provider;
use crate::session_db::SessionRepo;
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
    /// 消息持久化仓库（直接 SQLite 直落，用于执行过程中增量保存）
    pub repo: &'a dyn SessionRepo,
    /// 宿主环境（原生工具 `vision_analyze` 需要「模型文件在哪」）
    pub host: &'a dyn HostEnv,
    /// 应用配置仓储（`app_settings`）—— 原生工具 `web_search` 读搜索源配置
    pub settings: &'a dyn crate::session_db::SettingsRepo,
    /// Provider 类型（openai / anthropic / gemini），仅用于用量记账
    pub provider_type: &'a str,
    /// Provider 配置 id，仅用于用量记账
    pub provider_config_id: &'a str,
    pub persist_snapshot: Option<super::PersistSnapshotFn<'a>>,
    pub clear_snapshot: Option<&'a (dyn Fn(&str) + Sync + Send)>,
    /// 当前 LLM 轮次序号（1 基），透传给 engine.round.* 埋点
    pub round: i64,
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
        repo,
        host,
        settings,
        provider_type,
        provider_config_id,
        persist_snapshot,
        clear_snapshot,
        round,
    } = params;

    let model = session.model_id.clone();

    // 计时起点：只包住 LLM 请求（不含工具执行），与 TS 引擎 `llm-round.ts` 的
    // `roundStart → recordUsage` 区间对齐（铁律 1），UI 据此算 tok/s。
    let round_started_ms = crate::telemetry::now_ms();
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
        round,
    )
    .await?;
    let round_duration_ms = crate::telemetry::now_ms() - round_started_ms;

    // 用量记账（kind=chat_round）——与 TS 引擎 `engine.round.end` 处对齐（铁律 1）。
    // 有 tool calls 时用量在 `ctx.assistant_message` 上（ctx 里的消息才是被流式更新过的那条），
    // 无 tool calls 时在返回的 `assistant_message` 上。
    let (ledger_message_id, ledger_usage) = match output.ctx.as_ref() {
        Some(ctx) => (
            ctx.assistant_message.id.clone(),
            ctx.assistant_message.usage.clone(),
        ),
        None => (
            output.assistant_message.id.clone(),
            output.assistant_message.usage.clone(),
        ),
    };
    crate::agent::usage::record_usage(
        repo,
        session_id,
        session,
        provider_type,
        provider_config_id,
        "chat_round",
        Some(round),
        Some(&ledger_message_id),
        ledger_usage,
        false,
        Some(round_duration_ms),
    )
    .await;

    // 没有 tool calls：LLM 直接给出文字回答
    let mut ctx = match output.ctx {
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
    finalize_assistant_message(&mut ctx.assistant_message, &model, sink, session_id);

    // 关键：LLM 已产出 tool_calls → 在执行工具之前立即落库 assistant 消息，
    // 即使后续工具执行中途崩溃/卡死，这条「agent 调用工具」的记录也不丢失。
    // （不刷新会话时间，见 SessionRepo::append_messages）
    if let Err(e) = repo
        .append_messages_if_alive(session_id, &[ctx.assistant_message.clone()])
        .await
    {
        eprintln!("[session_db] 写入助手(tool_call)消息失败: {}", e);
    }

    let mut run = create_run(session_id, &ctx, round);
    if let Some(p) = persist_snapshot {
        p(session_id, &run);
    }

    let persist_closure: Option<super::BoxedPersistSnapshotFn<'_>> = persist_snapshot.map(|p| {
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
        repo,
        host,
        settings,
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
