//! 会话标题生成 —— 用 LLM 基于对话内容生成简短标题（**Rust 侧唯一实现**）
//!
//! 与 TS `src/domain/engine/generate-title.ts` 同语义（铁律 1）。调用方：
//! - GUI：命令 `cmd_generate_title`（`virlen-app/src/commands/agent.rs`）
//! - CLI：`chat` 新会话首回合结束后（`virlen-cli/src/session_rt`）
//!
//! 本模块只做「算出标题 + 那次调用的记账信息」这一件事 —— **不落库、不记账**
//! （记账由调用方按 [`TitleOutput::usage`] 写用量账本，`kind = "title"`）。
//!
//! ## 为什么要清洗上下文（与 TS 同一条理由）
//!
//! 标题请求只截取对话开头的几轮、**不携带工具结果消息**。若上下文里带进
//! `assistant(content=null, toolCalls=[...])` 这种轮次，Provider 转成 API 报文后会渲染出
//! 孤立 `tool_calls`（没有后续 `role='tool'` 应答），OpenAI 兼容 API 会直接拒绝：
//! `An assistant message with 'tool_calls' must be followed by tool messages`。
//! 因此 [`sanitize_title_context`] 丢弃非对话角色、剥离 assistant 的工具字段。

use crate::agent::cancellation::CancellationToken;
use crate::agent::prompts;
use crate::agent::provider::Provider;
use crate::agent::types::{ChatRequest, Message, Session, TokenUsage};
use serde_json::Value;

/// 标题最大长度（超过则截断并追加省略号）—— 与 TS `MAX_TITLE_LENGTH` 同值
pub const MAX_TITLE_LENGTH: usize = 30;

/// 标题请求的 `max_tokens` —— 与 TS 同值（一次短输出）
pub const TITLE_MAX_TOKENS: i64 = 40;

/// 标题请求的温度 —— 与 TS `temperature: 0.3` 同值
pub const TITLE_TEMPERATURE: f64 = 0.3;

/// 标题生成结果
#[derive(Debug, Clone)]
pub struct TitleOutput {
    /// 清洗后的标题（保证非空）
    pub title: String,
    /// 那次模型调用的用量；provider 未回报时为 `None`
    /// （TS 同样只在 `response.usage` 存在时记账，缺了就是不记）
    pub usage: Option<TokenUsage>,
    /// 本次请求的墙钟耗时（含首字延迟）—— 供用量账本算 tok/s
    pub duration_ms: i64,
}

/// 从 `content` 提取纯文本（容错：字符串直取；块数组只取 `text` 块并以空格连接；其余空串）
///
/// 与 TS `extractTitleText` 逐字对齐（数组用 `' '` 连接）。
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .map(|b| b.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// 「装饰符号」集合 —— 与 TS `sanitizeTitle` 的字符类一致（首尾去掉）；`\s` 由 `is_whitespace`
/// 覆盖。
fn is_decor(c: char) -> bool {
    matches!(
        c,
        '"' | '\''
            | '“' | '”' | '‘' | '’'
            | '《' | '》' | '「' | '」' | '【' | '】'
            | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
            | '：' | ':' | '，' | ',' | '。' | '.'
    ) || c.is_whitespace()
}

/// 清洗 AI 生成的标题 —— 与 TS `sanitizeTitle` 同语义：
/// 1. 去首尾空白；
/// 2. 去**行首** markdown 装饰（`#` / `-` / `*` 与空白）；
/// 3. 去首尾装饰符号（引号 / 书名号 / 括号 / 标点 / 空白）；
/// 4. 压缩连续空白为单个空格；
/// 5. 超长按**字符（码点）**截断到 [`MAX_TITLE_LENGTH`] 并追加 `...`。
///
/// ⚠️ 第 5 步的单位差异（TS 按 UTF-16 码元 + 代理对保护，Rust 按码点）：阈值附近可能有
/// ±1 字符差异；Rust 侧不可能切出半个字符（孤立代理）。
pub fn sanitize_title(raw: &str) -> String {
    // ①② 去首尾空白 + 行首 markdown 装饰
    let after_md = raw
        .trim()
        .trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c.is_whitespace());
    // ③ 去首尾装饰符号（含空白）
    let decor = after_md.trim_matches(is_decor);
    // ④ 压缩连续空白为单个空格
    let mut collapsed = String::with_capacity(decor.len());
    let mut prev_space = false;
    for c in decor.chars() {
        if c.is_whitespace() {
            if !prev_space {
                collapsed.push(' ');
                prev_space = true;
            }
        } else {
            collapsed.push(c);
            prev_space = false;
        }
    }
    let collapsed = collapsed.trim();
    // ⑤ 超长按码点截断 + `...`
    if collapsed.chars().count() > MAX_TITLE_LENGTH {
        let head: String = collapsed.chars().take(MAX_TITLE_LENGTH).collect();
        format!("{}...", head)
    } else {
        collapsed.to_string()
    }
}

/// 标题生成上下文清洗 —— 只保留「有正文的 user / assistant」纯文本轮次。
///
/// 与 TS `sanitizeTitleContext` 同语义：丢弃 tool / summary / feedback 等非对话角色，
/// 剥离 assistant 的 `tool_calls` / `tool_call_id` / `reasoning_content` / `usage` / `uiData`
/// 等与请求无关的重字段；`content` 为空（如纯工具调用轮次）的整条丢弃。
pub fn sanitize_title_context(messages: &[Message]) -> Vec<Message> {
    let mut out = Vec::new();
    for m in messages {
        if m.role != "user" && m.role != "assistant" {
            continue;
        }
        if content_text(&m.content).trim().is_empty() {
            continue;
        }
        out.push(Message {
            id: m.id.clone(),
            role: m.role.clone(),
            content: m.content.clone(),
            timestamp: m.timestamp,
            ..Default::default()
        });
    }
    out
}

/// 基于会话内容生成标题（**不落库、不记账**）。
///
/// 流程（与 TS 一致）：
/// 1. 取第一条 user 消息（+ 其后的首条 assistant，若存在）作为上下文并清洗；
/// 2. 追加标题指令（`prompts::GENERATE_TITLE`）作为最后一条 user 消息；
/// 3. 非流式调用 LLM（`temperature=0.3` / `max_tokens=40` / `tool_choice="none"`）；
/// 4. 清洗后返回；模型没产出有效标题则 `Err`（调用方回退到「首行截取」）。
pub async fn generate_title(
    session: &Session,
    messages: &[Message],
    provider: &dyn Provider,
    cancel: &CancellationToken,
) -> Result<TitleOutput, String> {
    let first_user_idx = messages
        .iter()
        .position(|m| m.role == "user")
        .ok_or_else(|| "没有用户消息，无法生成标题".to_string())?;
    if session.model_id.trim().is_empty() || session.provider_config_id.trim().is_empty() {
        return Err("会话没有配置模型或 Provider".to_string());
    }

    let first_user = &messages[first_user_idx];
    let first_assistant = messages[first_user_idx + 1..]
        .iter()
        .find(|m| m.role == "assistant");

    // 上下文：首条 user +（若存在）其后的首条 assistant
    let mut context: Vec<Message> = vec![first_user.clone()];
    if let Some(a) = first_assistant {
        context.push(a.clone());
    }
    let mut req_messages = sanitize_title_context(&context);
    req_messages.push(Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: Value::String(prompts::GENERATE_TITLE.to_string()),
        timestamp: crate::telemetry::now_ms(),
        ..Default::default()
    });

    let request = ChatRequest {
        model: session.model_id.clone(),
        messages: req_messages,
        // 与 TS `systemPrompt: undefined` 一致：标题请求不带系统提示词
        system_prompt: None,
        tools: Vec::new(),
        temperature: TITLE_TEMPERATURE,
        top_p: session.params.top_p,
        max_tokens: TITLE_MAX_TOKENS,
        stream: false,
        tool_choice: "none".to_string(),
        reasoning_effort: None,
    };

    let started = crate::telemetry::now_ms();
    let response = provider.chat(&request, cancel).await?;
    let duration_ms = crate::telemetry::now_ms() - started;

    let raw = match &response.content {
        Value::String(s) => s.clone(),
        other => content_text(other),
    };
    let title = sanitize_title(&raw);
    if title.is_empty() {
        return Err("AI 未生成有效标题".to_string());
    }

    Ok(TitleOutput {
        title,
        usage: response.usage,
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::{SessionParams, StreamEvent};
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    fn msg(role: &str, content: Value) -> Message {
        Message {
            id: format!("m-{}-{}", role, uuid::Uuid::new_v4()),
            role: role.into(),
            content,
            timestamp: 0,
            ..Default::default()
        }
    }

    fn session() -> Session {
        Session {
            id: "s1".into(),
            title: String::new(),
            messages: Vec::new(),
            provider_config_id: "p1".into(),
            model_id: "deepseek-chat".into(),
            system_prompt: "SYS".into(),
            params: SessionParams {
                temperature: 0.7,
                top_p: 0.9,
                max_tokens: 4096,
                stream: true,
                reasoning_effort: None,
            },
            created_at: 0,
            updated_at: 0,
            pinned: false,
            tags: Vec::new(),
            workspace: None,
            agent_id: None,
            allowed_tools: None,
            skills: None,
            system_prompt_manually_edited: None,
        }
    }

    // ==================== 清洗 ====================

    #[test]
    fn sanitize_title_strips_decor_and_collapses() {
        assert_eq!(sanitize_title("「你好世界」"), "你好世界");
        assert_eq!(sanitize_title("## 标题"), "标题");
        assert_eq!(sanitize_title("- * 标题"), "标题");
        assert_eq!(sanitize_title("  多   空白\n换行  "), "多 空白 换行");
        assert_eq!(sanitize_title("\"引号标题\""), "引号标题");
        assert_eq!(sanitize_title(""), "");
        assert_eq!(sanitize_title("「」"), "");
    }

    #[test]
    fn sanitize_title_truncates_by_chars() {
        let long = "标".repeat(40);
        let t = sanitize_title(&long);
        assert_eq!(t.chars().count(), MAX_TITLE_LENGTH + 3, "30 字符 + ...");
        assert!(t.ends_with("..."));
        // 恰好等于上限不截断
        let exact = "标".repeat(MAX_TITLE_LENGTH);
        assert_eq!(sanitize_title(&exact), exact);
    }

    #[test]
    fn content_text_handles_string_and_blocks() {
        assert_eq!(content_text(&Value::String(" hi ".into())), " hi ");
        let blocks = serde_json::json!([
            { "type": "text", "text": "a" },
            { "type": "image_url", "image_url": "x" },
            { "type": "text", "text": "b" }
        ]);
        assert_eq!(content_text(&blocks), "a b");
        assert_eq!(content_text(&Value::Null), "");
    }

    #[test]
    fn sanitize_title_context_drops_non_dialog_and_empty() {
        let messages = vec![
            msg("user", Value::String("你好".into())),
            // 纯工具调用轮次（正文 null）→ 整条丢弃
            msg("assistant", Value::Null),
            msg("tool", Value::String("工具结果".into())),
            msg("summary", Value::String("摘要".into())),
            msg("assistant", Value::String("在的".into())),
        ];
        let out = sanitize_title_context(&messages);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].role, "user");
        assert_eq!(out[1].role, "assistant");
        // 只保留 id / role / content / timestamp（其余字段被剥离）
        assert!(out[0].tool_calls.is_none());
        assert!(out[0].usage.is_none());
        assert!(out[0].ui_data.is_none());
    }

    // ==================== generate_title（含请求形状断言） ====================

    /// 记录收到的请求，返回固定回复
    struct CapturingProvider {
        reply: Value,
        usage: Option<TokenUsage>,
        seen: Arc<Mutex<Option<ChatRequest>>>,
    }

    #[async_trait]
    impl Provider for CapturingProvider {
        async fn chat(
            &self,
            request: &ChatRequest,
            _cancel: &CancellationToken,
        ) -> Result<Message, String> {
            *self.seen.lock().unwrap() = Some(request.clone());
            Ok(Message {
                id: "resp".into(),
                role: "assistant".into(),
                content: self.reply.clone(),
                usage: self.usage.clone(),
                timestamp: 0,
                ..Default::default()
            })
        }

        async fn chat_stream(
            &self,
            _request: &ChatRequest,
            _cancel: &CancellationToken,
            _on_event: &mut (dyn FnMut(StreamEvent) + Send),
        ) -> Result<(), String> {
            unreachable!("标题生成只走非流式 chat")
        }
    }

    fn provider(reply: &str, seen: Arc<Mutex<Option<ChatRequest>>>) -> CapturingProvider {
        CapturingProvider {
            reply: Value::String(reply.into()),
            usage: Some(TokenUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                cached_tokens: None,
            }),
            seen,
        }
    }

    #[tokio::test]
    async fn generate_title_returns_sanitized_and_sets_request_shape() {
        let seen = Arc::new(Mutex::new(None));
        let p = provider("「对话主题」", seen.clone());
        let messages = vec![
            msg("user", Value::String("帮我写个排序".into())),
            msg("assistant", Value::String("好的".into())),
        ];
        let out = generate_title(&session(), &messages, &p, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(out.title, "对话主题");
        assert!(out.usage.is_some());

        let req = seen.lock().unwrap().clone().expect("必须发出请求");
        assert_eq!(req.temperature, TITLE_TEMPERATURE);
        assert_eq!(req.max_tokens, TITLE_MAX_TOKENS);
        assert_eq!(req.tool_choice, "none");
        assert!(!req.stream);
        assert!(req.system_prompt.is_none());
        assert!(req.tools.is_empty());
        assert_eq!(req.top_p, 0.9, "top_p 取会话值");
        // 末条是标题指令
        assert_eq!(
            req.messages.last().unwrap().content,
            Value::String(prompts::GENERATE_TITLE.to_string())
        );
    }

    #[tokio::test]
    async fn generate_title_without_user_message_errors() {
        let seen = Arc::new(Mutex::new(None));
        let p = provider("x", seen.clone());
        let messages = vec![msg("assistant", Value::String("只有助手".into()))];
        let err = generate_title(&session(), &messages, &p, &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("用户消息"));
        assert!(seen.lock().unwrap().is_none(), "不该发出请求");
    }

    #[tokio::test]
    async fn generate_title_rejects_empty_model_output() {
        let seen = Arc::new(Mutex::new(None));
        // 只输出装饰符号 → 清洗后为空 → 报错（调用方回退首行截取）
        let p = provider("「」", seen);
        let messages = vec![msg("user", Value::String("你好".into()))];
        let err = generate_title(&session(), &messages, &p, &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("有效标题"));
    }

    #[tokio::test]
    async fn generate_title_works_with_only_user_message() {
        let seen = Arc::new(Mutex::new(None));
        let p = provider("排序算法", seen.clone());
        let messages = vec![msg("user", Value::String("帮我写个排序".into()))];
        let out = generate_title(&session(), &messages, &p, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(out.title, "排序算法");
        // 没有 assistant 时上下文只有首条 user + 指令
        let req = seen.lock().unwrap().clone().unwrap();
        assert_eq!(req.messages.len(), 2);
    }
}
