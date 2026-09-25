//! 迭代控制器 — 编排 LLM调用→工具执行→验证→反馈 的循环
//!
//! 移植自 `src/domain/engine/iteration-controller.ts`。

use super::bridge::AgentBridgeState;
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::host::HostEnv;
use super::llm_loop::{execute_llm_round, ExecuteLlmRoundParams};
use super::llm_round::now_ms;
use super::provider::Provider;
use super::types::{
    AgentEvent, Goal, Message, NativeToolSecurity, Run, Session, ToolDefinition, VerificationResult,
};
use super::verifier::verify;
use crate::session_db::SessionRepo;
use serde_json::json;

pub struct RunIterationParams<'a> {
    pub goal: &'a Goal,
    pub session: &'a Session,
    pub provider: &'a dyn Provider,
    pub tool_defs: &'a [ToolDefinition],
    pub current_messages: &'a [Message],
    pub session_id: &'a str,
    pub cancel: &'a CancellationToken,
    pub sink: &'a dyn EventSink,
    pub bridge: &'a AgentBridgeState,
    pub skills: Option<Vec<String>>,
    /// 原生工具安全配置（None 时工具全部走 JS 桥）
    pub security: Option<NativeToolSecurity>,
    pub effective_max_tokens: i64,
    pub reasoning_effort: Option<String>,
    pub max_iterations: i64,
    /// 消息持久化仓库（直接 SQLite 直落，用于执行过程中增量保存）
    pub repo: &'a dyn SessionRepo,
    /// 宿主环境（原生工具 `vision_analyze` 需要「模型文件在哪」）
    pub host: &'a dyn HostEnv,
    /// Provider 类型（openai / anthropic / gemini），仅用于用量记账
    pub provider_type: &'a str,
    /// Provider 配置 id，仅用于用量记账
    pub provider_config_id: &'a str,
    pub persist_snapshot: Option<&'a (dyn Fn(&str, &Run) + Sync + Send)>,
    pub clear_snapshot: Option<&'a (dyn Fn(&str) + Sync + Send)>,
}

/// 运行迭代循环
/// Ok(true) = 目标达成；Ok(false) = 被暂停/取消
pub async fn run_iteration(
    params: RunIterationParams<'_>,
) -> Result<(bool, Vec<Message>), String> {
    let RunIterationParams {
        goal,
        session,
        provider,
        tool_defs,
        current_messages,
        session_id,
        cancel,
        sink,
        bridge,
        skills,
        security,
        effective_max_tokens,
        reasoning_effort,
        max_iterations,
        repo,
        host,
        provider_type,
        provider_config_id,
        persist_snapshot,
        clear_snapshot,
    } = params;

    let max_iterations = max_iterations.max(1);
    let mut current_iteration: i64 = 0;
    let mut verification_history: Vec<VerificationResult> = Vec::new();

    sink.emit_agent_event(
        session_id,
        &AgentEvent::new("iteration_start", json!({ "maxIterations": max_iterations })),
    );

    let mut messages = current_messages.to_vec();

    while current_iteration < max_iterations {
        current_iteration += 1;

        if cancel.is_cancelled() {
            return Ok((false, messages));
        }

        // 轮次边界：上一批工具的 tool_result 已合并、下一次 LLM 请求尚未发出。
        // 注入「AI 回复期间用户已应用的任务清单变更」（与 execute_tool_loop 同一时机，
        // 也与 TS 引擎 iteration-controller 同一时机 —— 铁律 1）。
        super::bridge::inject_round_boundary_messages(bridge, sink, repo, session_id, &mut messages)
            .await;

        // ===== 1. LLM Round + 工具执行 =====
        let result = execute_llm_round(ExecuteLlmRoundParams {
            session,
            provider,
            tool_defs,
            messages: &messages,
            session_id,
            cancel,
            sink,
            bridge,
            skills: skills.clone(),
            security: security.clone(),
            effective_max_tokens,
            reasoning_effort: reasoning_effort.clone(),
            persist_snapshot,
            clear_snapshot,
            repo,
            host,
            provider_type,
            provider_config_id,
            round: current_iteration,
        })
        .await?;

        // 本轮落库：ctx=Some（有 tool calls）时 assistant/tool 已在执行途中增量直落
        // （llm_loop 落 assistant、tool_executor 逐条落 tool 结果），无需重复写；
        // 仅 ctx=None（纯文本回答 / 取消的部分回答）未落库，这里兜底补写一次。
        // ⚠️ 均不刷新会话时间（AI 发言不是用户发言）
        if result.ctx.is_none() {
            if let Err(e) = repo
                .append_messages_if_alive(session_id, &[result.assistant_message.clone()])
                .await
            {
                eprintln!("[session_db] 写入迭代纯文本回答失败: {}", e);
            }
        }

        messages.push(result.assistant_message);
        messages.extend(result.tool_result_messages);

        if result.paused {
            return Ok((false, messages));
        }

        // ===== 2. 验证 =====
        sink.emit_agent_event(
            session_id,
            &AgentEvent::new(
                "iteration_verify_start",
                json!({ "iteration": current_iteration }),
            ),
        );

        let verify_started_ms = crate::telemetry::now_ms();
        let verify_result: VerificationResult = match verify(
            provider,
            session,
            goal,
            &messages,
            cancel,
        )
        .await
        {
            Ok(outcome) => {
                // 验证是真实 LLM 调用，但不产生消息 → 必须显式记账，否则这笔消费就漏了
                crate::agent::usage::record_usage(
                    repo,
                    session_id,
                    session,
                    provider_type,
                    provider_config_id,
                    "verify",
                    Some(current_iteration),
                    None,
                    outcome.usage,
                    Some(crate::telemetry::now_ms() - verify_started_ms),
                )
                .await;
                outcome.result
            }
            Err(e) => {
                if cancel.is_cancelled() {
                    return Ok((false, messages));
                }
                VerificationResult {
                    passed: false,
                    summary: format!("Verification call failed: {}", e),
                    issues: vec![super::types::VerificationIssue {
                        severity: "error".to_string(),
                        description: format!("Verification LLM call failed: {}", e),
                        suggestion: "Check the provider configuration or network connection and try again".to_string(),
                    }],
                }
            }
        };

        if cancel.is_cancelled() {
            return Ok((false, messages));
        }

        sink.emit_agent_event(
            session_id,
            &AgentEvent::new(
                "iteration_verify_end",
                json!({ "iteration": current_iteration }),
            ),
        );

        verification_history.push(verify_result.clone());

        if verify_result.passed {
            sink.emit_agent_event(
                session_id,
                &AgentEvent::new(
                    "iteration_verify_pass",
                    json!({
                        "iteration": current_iteration,
                        "result": verify_result,
                    }),
                ),
            );
            sink.emit_agent_event(
                session_id,
                &AgentEvent::new(
                    "iteration_end",
                    json!({
                        "iteration": current_iteration,
                        "maxIterations": max_iterations,
                        "summary": format!("Goal achieved after {} iteration(s)", current_iteration),
                    }),
                ),
            );
            return Ok((true, messages));
        }

        // ===== 3. 验证未通过：注入反馈 =====
        sink.emit_agent_event(
            session_id,
            &AgentEvent::new(
                "iteration_verify_fail",
                json!({
                    "iteration": current_iteration,
                    "result": verify_result,
                }),
            ),
        );

        let feedback_msg = build_feedback_message(&verify_result);
        messages.push(feedback_msg.clone());
        // 反馈消息也落库（与 TS 引擎路径通过事件持久化行为一致）
        if let Err(e) = repo
            .append_messages_if_alive(session_id, &[feedback_msg.clone()])
            .await
        {
            eprintln!("[session_db] 写入验证反馈消息失败: {}", e);
        }
        sink.emit_agent_event(
            session_id,
            &AgentEvent::new(
                "assistant_message_created",
                json!({ "message": feedback_msg }),
            ),
        );
    }

    // 超出最大迭代次数
    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "iteration_max_exceeded",
            json!({
                "iteration": current_iteration,
                "maxIterations": max_iterations,
            }),
        ),
    );
    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "iteration_end",
            json!({
                "iteration": current_iteration,
                "maxIterations": max_iterations,
                "summary": format!("Exceeded the maximum number of iterations ({}); the goal was not fully achieved", max_iterations),
            }),
        ),
    );

    // 生成失败报告
    let failure_report = build_failure_report(
        &goal.description,
        current_iteration,
        max_iterations,
        &verification_history,
    );
    messages.push(failure_report.clone());
    // 失败报告落库（正常结束也保证最终回答可恢复）
    if let Err(e) = repo
        .append_messages_if_alive(session_id, &[failure_report.clone()])
        .await
    {
        eprintln!("[session_db] 写入迭代失败报告失败: {}", e);
    }
    sink.emit_agent_event(
        session_id,
        &AgentEvent::new(
            "assistant_message_created",
            json!({ "message": failure_report }),
        ),
    );

    Ok((true, messages))
}

/// 构建注入到对话中的验证反馈消息（以 user 角色注入）
pub fn build_feedback_message(result: &VerificationResult) -> Message {
    let issue_lines: Vec<String> = result
        .issues
        .iter()
        .enumerate()
        .map(|(i, issue)| {
            format!(
                "{}. [{}] {}\n   Suggestion: {}",
                i + 1,
                issue.severity,
                issue.description,
                issue.suggestion
            )
        })
        .collect();

    let mut content = format!(
        "[Verification feedback]\n\nResult: {}\nSummary: {}\n",
        if result.passed { "✅ Passed" } else { "❌ Not passed" },
        result.summary
    );
    if !result.issues.is_empty() {
        content.push_str("\nIssues found:\n");
        content.push_str(&issue_lines.join("\n"));
        content.push_str("\n\nPlease fix the issues above and try again.");
    }

    Message {
        id: format!("feedback_{}", now_ms()),
        role: "feedback".to_string(),
        content: serde_json::Value::String(content),
        timestamp: now_ms(),
        ..Default::default()
    }
}

/// 构建失败报告消息
fn build_failure_report(
    goal_desc: &str,
    current_iteration: i64,
    max_iterations: i64,
    history: &[VerificationResult],
) -> Message {
    let history_summary: Vec<String> = history
        .iter()
        .enumerate()
        .map(|(i, v)| {
            format!(
                "Attempt {}: {} {}",
                i + 1,
                if v.passed { "✅" } else { "❌" },
                v.summary
            )
        })
        .collect();

    let content = format!(
        "[Iteration end report]\n\nGoal: {}\nTotal iterations: {}/{}\nFinal status: ❌ Not fully achieved\n\nVerification result per round:\n{}\n\nThe maximum number of iterations has been reached. Review the results and consider:\n1. Making the goal description more specific\n2. Completing the remaining steps manually\n3. Raising the max iterations and retrying",
        goal_desc,
        current_iteration,
        max_iterations,
        history_summary.join("\n")
    );

    Message {
        id: format!("failure_report_{}", now_ms()),
        role: "assistant".to_string(),
        content: serde_json::Value::String(content),
        timestamp: now_ms(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::{VerificationIssue};

    #[test]
    fn feedback_message_shape() {
        let r = VerificationResult {
            passed: false,
            summary: "目标未完成".into(),
            issues: vec![VerificationIssue {
                severity: "error".into(),
                description: "文件不存在".into(),
                suggestion: "检查路径".into(),
            }],
        };
        let m = build_feedback_message(&r);
        assert_eq!(m.role, "feedback");
        assert!(m.text_content().contains("文件不存在"));
        assert!(m.text_content().contains("检查路径"));
    }
}
