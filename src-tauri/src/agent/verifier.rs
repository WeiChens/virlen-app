//! LLMVerifier — 使用同一模型验证执行结果是否达标
//!
//! 移植自 `src/domain/engine/verifier.ts`。

use super::cancellation::CancellationToken;
use super::provider::Provider;
use super::types::{ChatRequest, Goal, Message, Session, VerificationIssue, VerificationResult};
use serde_json::Value;

const DEFAULT_VERIFY_MAX_TOKENS: i64 = 4096;
const VERIFY_PROMPT_TEMPLATE: &str = include_str!("prompts/verify-prompt.md");

/// 构建验证 prompt
fn build_verify_prompt(goal: &Goal, messages: &[Message]) -> String {
    let trace = build_execution_trace(messages);
    VERIFY_PROMPT_TEMPLATE
        .replace("{{goal}}", &goal.description)
        .replace("{{trace}}", &trace)
}

/// 从消息列表构建执行轨迹摘要
fn build_execution_trace(messages: &[Message]) -> String {
    let mut parts: Vec<String> = Vec::new();

    for msg in messages {
        match msg.role.as_str() {
            "assistant" => {
                let text = msg.text_content();
                if !text.is_empty() {
                    let cut: String = text.chars().take(500).collect();
                    parts.push(format!("[Assistant] {}", cut));
                }
                if let Some(tcs) = &msg.tool_calls {
                    for tc in tcs {
                        let input_str =
                            serde_json::to_string(&tc.input).unwrap_or_default();
                        let cut: String = input_str.chars().take(300).collect();
                        parts.push(format!("[Tool Call] {}({})", tc.name, cut));
                    }
                }
            }
            "tool" => {
                let text = msg.text_content();
                let status = if msg.is_error.unwrap_or(false) { " (失败)" } else { "" };
                let cut: String = text.chars().take(500).collect();
                parts.push(format!("[Tool Result{}] {}", status, cut));
            }
            _ => {}
        }
    }

    if parts.is_empty() {
        "(无执行轨迹)".to_string()
    } else {
        parts.join("\n")
    }
}

/// 解析 LLM 响应为 VerificationResult
fn parse_verification_result(raw: &str) -> VerificationResult {
    // 尝试直接解析 JSON
    if let Ok(parsed) = serde_json::from_str::<Value>(raw.trim()) {
        return normalize_result(&parsed);
    }
    // 尝试从文本中提取 JSON 块
    if let Some(start) = raw.find('{') {
        if let Some(end) = raw.rfind('}') {
            if end > start {
                if let Ok(parsed) = serde_json::from_str::<Value>(&raw[start..=end]) {
                    return normalize_result(&parsed);
                }
            }
        }
    }

    // 兜底：无法解析时返回"需要人工判断"
    VerificationResult {
        passed: false,
        summary: "无法解析验证结果，请人工判断".to_string(),
        issues: vec![VerificationIssue {
            severity: "warning".to_string(),
            description: "验证器返回了无法解析的响应".to_string(),
            suggestion: "请人工检查执行结果是否符合预期".to_string(),
        }],
    }
}

/// 规范化解析结果
fn normalize_result(raw: &Value) -> VerificationResult {
    let passed = raw.get("passed").and_then(Value::as_bool).unwrap_or(false);
    let summary = raw
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let issues: Vec<VerificationIssue> = raw
        .get("issues")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|i| {
                    let severity = i
                        .get("severity")
                        .and_then(Value::as_str)
                        .unwrap_or("warning");
                    let severity = if ["error", "warning", "info"].contains(&severity) {
                        severity
                    } else {
                        "warning"
                    };
                    Some(VerificationIssue {
                        severity: severity.to_string(),
                        description: i
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        suggestion: i
                            .get("suggestion")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    VerificationResult {
        passed,
        summary,
        issues,
    }
}

/// 验证执行结果是否达到目标
pub async fn verify(
    provider: &dyn Provider,
    session: &Session,
    goal: &Goal,
    messages: &[Message],
    cancel: &CancellationToken,
) -> Result<VerificationResult, String> {
    let verify_prompt = build_verify_prompt(goal, messages);

    let verify_messages = vec![Message {
        id: "verify_user".to_string(),
        role: "user".to_string(),
        content: Value::String(verify_prompt),
        timestamp: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    }];

    let request = ChatRequest {
        model: session.model_id.clone(),
        messages: verify_messages,
        system_prompt: Some("你是一个精确的任务验证器。只输出 JSON。".to_string()),
        temperature: 0.1,
        top_p: 1.0,
        max_tokens: DEFAULT_VERIFY_MAX_TOKENS,
        stream: false,
        tool_choice: "none".to_string(),
        reasoning_effort: None,
        tools: Vec::new(),
    };

    let response = provider.chat(&request, cancel).await?;
    let raw_text = response.text_content();
    Ok(parse_verification_result(&raw_text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_direct_json() {
        let r = parse_verification_result(
            r#"{"passed": true, "summary": "ok", "issues": []}"#,
        );
        assert!(r.passed);
        assert_eq!(r.summary, "ok");
    }

    #[test]
    fn parse_wrapped_json() {
        let r = parse_verification_result(
            "好的，结果如下：\n{\"passed\": false, \"summary\": \"bad\", \"issues\": [{\"severity\": \"error\", \"description\": \"d\", \"suggestion\": \"s\"}]}",
        );
        assert!(!r.passed);
        assert_eq!(r.summary, "bad");
        assert_eq!(r.issues.len(), 1);
        assert_eq!(r.issues[0].severity, "error");
    }

    #[test]
    fn parse_fallback() {
        let r = parse_verification_result("无法解析的内容");
        assert!(!r.passed);
        assert!(r.summary.contains("人工判断"));
    }

    #[test]
    fn normalize_severity() {
        let raw = json!({
            "passed": false,
            "summary": "x",
            "issues": [
                { "severity": "invalid", "description": "a", "suggestion": "b" },
                { "severity": "info", "description": "c", "suggestion": "d" }
            ]
        });
        let r = normalize_result(&raw);
        assert_eq!(r.issues[0].severity, "warning");
        assert_eq!(r.issues[1].severity, "info");
    }

    #[test]
    fn trace_builds() {
        let msgs = vec![
            Message {
                id: "1".into(),
                role: "assistant".into(),
                content: Value::String("你好".into()),
                timestamp: 0,
                ..Default::default()
            },
            Message {
                id: "2".into(),
                role: "tool".into(),
                content: Value::String("结果".into()),
                timestamp: 0,
                ..Default::default()
            },
        ];
        let trace = build_execution_trace(&msgs);
        assert!(trace.contains("[Assistant] 你好"));
        assert!(trace.contains("[Tool Result] 结果"));
    }
}
