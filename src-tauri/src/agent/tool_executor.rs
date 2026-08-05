//! Tool 执行器 — 逐步骤执行 tool calls（通过 JS 桥）、处理用户交互、管理 result 消息
//!
//! 移植自 `src/domain/engine/tool-executor.ts`。
//! 工具本体仍由 JS 侧 `toolRegistry` 提供，Rust 通过双向桥请求执行。

use super::bridge::{
    AgentBridgeState, BridgeInteractionResult, BridgeToolResult,
};
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::llm_round::now_ms;
use super::native_tools;
use super::native_tools::NativeToolCtx;
use super::run_state::{find_next_step, run_to_snapshot};
use super::storm_breaker::check_tool_call_storm;
use super::types::{
    AgentEvent, Message, NativeToolSecurity, Run, ToolCallContext, ToolStep, ToolStepStatus,
};
use serde_json::{json, Value};

/// 从 tool call 上下文创建 Run
pub fn create_run(session_id: &str, ctx: &ToolCallContext) -> Run {
    Run {
        id: format!("run_{}", ctx.assistant_message.id),
        session_id: session_id.to_string(),
        assistant_message_id: ctx.assistant_message.id.clone(),
        steps: ctx
            .tool_uses
            .iter()
            .map(|tc| ToolStep {
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                input: tc.input.clone(),
                status: ToolStepStatus::Pending,
                result: None,
                error: None,
                started_at: None,
                ui_data: None,
            })
            .collect(),
        created_at: now_ms(),
        paused: false,
        round: 0,
    }
}

/// 逐步骤执行 run 中的工具调用。
/// 从第一个非 completed 的 step 开始，遇到暂停时保存进度并返回 false。
pub async fn execute_tool_steps(
    run: &mut Run,
    cancel: &CancellationToken,
    sink: &dyn EventSink,
    bridge: &AgentBridgeState,
    skills: Option<Vec<String>>,
    security: Option<NativeToolSecurity>,
    persist_snapshot: Option<&(dyn Fn(&Run) + Sync + Send)>,
) -> (bool, Vec<Message>) {
    let session_id = run.session_id.clone();
    let start_index = find_next_step(run);
    let mut tool_result_messages: Vec<Message> = Vec::new();

    for i in start_index..run.steps.len() {
        if cancel.is_cancelled() {
            return (false, tool_result_messages);
        }

        let tool_result;
        {
            let step = &mut run.steps[i];
            step.status = ToolStepStatus::Running;
            step.started_at = Some(now_ms());

            notify_step_start(step, sink, &session_id);
            tool_result = execute_single_step(
                &session_id,
                step,
                cancel,
                sink,
                bridge,
                skills.clone(),
                security.clone(),
            )
            .await;
        }

        // 检查是否被暂停
        if tool_result == "__SHELVED__" {
            run.paused = true;
            if let Some(p) = persist_snapshot {
                p(run);
            }
            sink.emit_agent_event(
                &session_id,
                &AgentEvent::new(
                    "stream_end",
                    json!({
                        "paused": true,
                        "snapshot": run_to_snapshot(run),
                    }),
                ),
            );
            return (false, tool_result_messages);
        }

        let tool_result_msg = handle_tool_result(&mut run.steps[i], &tool_result, sink, &session_id);
        tool_result_messages.push(tool_result_msg);

        if cancel.is_cancelled() {
            return (false, tool_result_messages);
        }
        if let Some(p) = persist_snapshot {
            p(run);
        }
    }

    (true, tool_result_messages)
}

/// 通知 UI 当前步骤开始执行
fn notify_step_start(step: &ToolStep, sink: &dyn EventSink, session_id: &str) {
    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "tool_call",
            json!({
                "type": "tool_use",
                "id": step.tool_call_id,
                "name": step.tool_name,
                "input": step.input,
            }),
        ),
    );
}

/// 执行单个 tool step，返回结果字符串或特殊标记 "__SHELVED__"
/// 高价值工具原生 Rust 执行（无 JS 桥往返），其余工具走 JS 桥。
async fn execute_single_step(
    session_id: &str,
    step: &mut ToolStep,
    cancel: &CancellationToken,
    sink: &dyn EventSink,
    bridge: &AgentBridgeState,
    skills: Option<Vec<String>>,
    security: Option<NativeToolSecurity>,
) -> String {
    // StormBreaker: 检测工具调用循环
    if check_tool_call_storm(session_id, &step.tool_name, &step.input) {
        step.status = ToolStepStatus::Failed;
        step.error = Some("检测到工具调用循环，已自动拦截".to_string());
        return "[StormBreaker] 工具 \"".to_string()
            + &step.tool_name
            + "\" 在最近几次调用中重复出现，已自动拦截。请重新思考策略，尝试不同的方法或直接给出最终回答。";
    }

    // ===== 原生工具优先（P2：execute-command / 文件 / 搜索 / 知识库） =====
    if let Some(sec) = &security {
        if native_tools::is_native_tool(&step.tool_name) {
            let ctx = NativeToolCtx {
                session_id,
                tool_call_id: &step.tool_call_id,
                cancel,
                sink,
                bridge,
                security: sec,
            };
            let args = step.input.clone();
            return match native_tools::execute_native_tool(&ctx, &step.tool_name, &args).await {
                Ok(native_tools::NativeToolOutcome::Value { content, ui_data }) => {
                    step.status = ToolStepStatus::Completed;
                    step.result = Some(content.clone());
                    step.ui_data = ui_data;
                    content
                }
                Ok(native_tools::NativeToolOutcome::Error(msg)) => {
                    step.status = ToolStepStatus::Failed;
                    step.error = Some(msg.clone());
                    msg
                }
                Ok(native_tools::NativeToolOutcome::Shelved) => "__SHELVED__".to_string(),
                Ok(native_tools::NativeToolOutcome::Interaction {
                    interaction_type,
                    interaction_data,
                }) => {
                    handle_user_interaction(
                        session_id,
                        step,
                        &interaction_type,
                        interaction_data,
                        sink,
                        bridge,
                    )
                    .await
                }
                Err(e) => {
                    step.status = ToolStepStatus::Failed;
                    step.error = Some(e.clone());
                    format!("error: {}", e)
                }
            };
        }
    }

    let payload = match bridge
        .request_tool(
            sink,
            session_id,
            &step.tool_call_id,
            &step.tool_name,
            step.input.clone(),
            skills,
        )
        .await
    {
        Ok(p) => p,
        Err(e) => {
            step.status = ToolStepStatus::Failed;
            step.error = Some(e.clone());
            return format!("error: {}", e);
        }
    };

    match BridgeToolResult::parse(&payload) {
        BridgeToolResult::Value { content, ui_data } => {
            step.status = ToolStepStatus::Completed;
            step.result = Some(content.clone());
            step.ui_data = ui_data;
            content
        }
        BridgeToolResult::Error(msg) => {
            step.status = ToolStepStatus::Failed;
            step.error = Some(msg.clone());
            msg
        }
        BridgeToolResult::Interaction {
            interaction_type,
            interaction_data,
        } => {
            handle_user_interaction(
                session_id,
                step,
                &interaction_type,
                interaction_data,
                sink,
                bridge,
            )
            .await
        }
    }
}

/// 处理用户交互（等待 / 暂存 / 取消）— 通过 JS 桥弹窗
async fn handle_user_interaction(
    session_id: &str,
    step: &mut ToolStep,
    interaction_type: &str,
    interaction_data: Value,
    sink: &dyn EventSink,
    bridge: &AgentBridgeState,
) -> String {
    let mut data = interaction_data.clone();
    if let Value::Object(map) = &mut data {
        map.insert("toolCallId".into(), Value::String(step.tool_call_id.clone()));
    }

    match bridge
        .request_user_interaction(sink, session_id, interaction_type, data)
        .await
    {
        Ok(payload) => match BridgeInteractionResult::parse(&payload) {
            BridgeInteractionResult::Value { content, ui_data } => {
                step.status = ToolStepStatus::Completed;
                step.result = Some(content.clone());
                step.ui_data = ui_data;
                content
            }
            BridgeInteractionResult::Error(msg) => {
                step.status = ToolStepStatus::Failed;
                step.error = Some(msg.clone());
                msg
            }
            BridgeInteractionResult::Shelved => "__SHELVED__".to_string(),
            BridgeInteractionResult::Cancelled => {
                let result = "[User cancelled]".to_string();
                step.status = ToolStepStatus::Failed;
                step.result = Some(result.clone());
                result
            }
        },
        Err(e) => {
            step.status = ToolStepStatus::Failed;
            step.error = Some(e.clone());
            format!("error: {}", e)
        }
    }
}

/// tool step 完成后推送最终输出并插入 tool_result 消息
fn handle_tool_result(
    step: &mut ToolStep,
    tool_result: &str,
    sink: &dyn EventSink,
    session_id: &str,
) -> Message {
    let elapsed_ms = step.started_at.map(|s| now_ms() - s);

    let tool_result_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "tool".to_string(),
        content: Value::String(tool_result.to_string()),
        tool_call_id: Some(step.tool_call_id.clone()),
        is_error: Some(step.status == ToolStepStatus::Failed),
        elapsed_ms,
        ui_data: step.ui_data.clone(),
        timestamp: now_ms(),
        ..Default::default()
    };

    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "tool_result_created",
            json!({ "message": tool_result_message }),
        ),
    );

    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "tool_call",
            json!({
                "type": "tool_use",
                "id": step.tool_call_id,
                "name": step.tool_name,
                "input": step.input,
                "result": tool_result,
            }),
        ),
    );

    tool_result_message
}
