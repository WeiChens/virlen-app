//! 迭代控制器 — 编排 LLM调用→工具执行→验证→反馈 的循环
//!
//! 移植自 `src/domain/engine/iteration-controller.ts`。

use super::bridge::AgentBridgeState;
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::llm_loop::{execute_llm_round, ExecuteLlmRoundParams};
use super::provider::Provider;
use super::types::{
    AgentEvent, Goal, Message, NativeToolSecurity, Run, Session, ToolDefinition, VerificationResult,
};
use super::verifier::verify;
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
        })
        .await?;

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

        let verify_result: VerificationResult = match verify(
            provider,
            session,
            goal,
            &messages,
            cancel,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                if cancel.is_cancelled() {
                    return Ok((false, messages));
                }
                VerificationResult {
                    passed: false,
                    summary: format!("验证调用失败: {}", e),
                    issues: vec![super::types::VerificationIssue {
                        severity: "error".to_string(),
                        description: format!("验证 LLM 调用失败: {}", e),
                        suggestion: "请检查 provider 配置或网络连接后重试".to_string(),
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
                        "summary": format!("目标在第 {} 次迭代后达成", current_iteration),
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
                "summary": format!("超出最大迭代次数 ({})，目标未完全达成", max_iterations),
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
                "{}. [{}] {}\n   建议: {}",
                i + 1,
                issue.severity,
                issue.description,
                issue.suggestion
            )
        })
        .collect();

    let mut content = format!(
        "【验证反馈】\n\n验证结果: {}\n摘要: {}\n",
        if result.passed { "✅ 通过" } else { "❌ 未通过" },
        result.summary
    );
    if !result.issues.is_empty() {
        content.push_str("\n发现的问题:\n");
        content.push_str(&issue_lines.join("\n"));
        content.push_str("\n\n请修正以上问题后重新尝试。");
    }

    Message {
        id: format!("feedback_{}", chrono::Utc::now().timestamp_millis()),
        role: "feedback".to_string(),
        content: serde_json::Value::String(content),
        timestamp: chrono::Utc::now().timestamp_millis(),
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
                "第 {} 次: {} {}",
                i + 1,
                if v.passed { "✅" } else { "❌" },
                v.summary
            )
        })
        .collect();

    let content = format!(
        "【迭代结束报告】\n\n目标: {}\n总迭代次数: {}/{}\n最终状态: ❌ 未完全达成\n\n各轮验证结果:\n{}\n\n已达到最大迭代次数限制。请检查执行结果，考虑：\n1. 调整目标描述，使其更具体明确\n2. 手动完成剩余步骤\n3. 增加最大迭代次数后重试",
        goal_desc,
        current_iteration,
        max_iterations,
        history_summary.join("\n")
    );

    Message {
        id: format!("failure_report_{}", chrono::Utc::now().timestamp_millis()),
        role: "assistant".to_string(),
        content: serde_json::Value::String(content),
        timestamp: chrono::Utc::now().timestamp_millis(),
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
