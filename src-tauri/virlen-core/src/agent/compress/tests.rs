//! `agent::compress` 单测
//!
//! 覆盖三块：**口径**（[`context_tokens`] 与比例 / 文案）、**切片**（[`compress_slice`]）、
//! **压缩产物**（两种模式的 summary 消息形状）。`raw` 的渲染细节在同目录 `raw.rs` 里单测。

use super::*;
use crate::agent::cancellation::CancellationToken;
use crate::agent::types::{ChatRequest, SessionParams, ToolUseContent};
use async_trait::async_trait;
use serde_json::json;

#[test]
fn summary_max_tokens_caps_absurd_session_values() {
    // 会话值超出合理区间（如 GUI 默认 2000000）→ 退到默认摘要上限，避免模型 400
    assert_eq!(super::ai::summary_max_tokens(0), DEFAULT_SUMMARY_MAX_TOKENS);
    assert_eq!(super::ai::summary_max_tokens(-5), DEFAULT_SUMMARY_MAX_TOKENS);
    assert_eq!(
        super::ai::summary_max_tokens(2_000_000),
        DEFAULT_SUMMARY_MAX_TOKENS
    );
    // 合理的会话值按原值用
    assert_eq!(super::ai::summary_max_tokens(1024), 1024);
    assert_eq!(
        super::ai::summary_max_tokens(DEFAULT_SUMMARY_MAX_TOKENS),
        DEFAULT_SUMMARY_MAX_TOKENS
    );
}

// ==================== 夹具 ====================

fn session() -> Session {
    Session {
        id: "s1".into(),
        title: "t".into(),
        messages: Vec::new(),
        provider_config_id: "p1".into(),
        model_id: "deepseek-chat".into(),
        system_prompt: "SYS".into(),
        params: SessionParams {
            temperature: 0.7,
            top_p: 1.0,
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

fn msg(role: &str, content: &str) -> Message {
    Message {
        id: format!("m-{}", role),
        role: role.into(),
        content: Value::String(content.into()),
        timestamp: 0,
        ..Default::default()
    }
}

fn with_usage(mut m: Message, total: i64) -> Message {
    m.usage = Some(TokenUsage {
        prompt_tokens: total,
        completion_tokens: 0,
        total_tokens: total,
        cached_tokens: None,
    });
    m
}

fn with_ctx(mut m: Message, ctx: i64) -> Message {
    m.ui_data = Some(json!({ "compressMode": "raw", "contextTokens": ctx }));
    m
}

/// 一条「清单快照」消息（模型 `todo_write` 的 tool_result 形态）
fn todo_msg(todos: Value) -> Message {
    let mut m = msg("tool", "");
    m.ui_data = Some(json!({ "type": "todo", "todos": todos }));
    m
}

/// 可控 provider（ai 模式的单测用）
struct MockProvider {
    reply: String,
    usage: Option<TokenUsage>,
}

#[async_trait]
impl Provider for MockProvider {
    async fn chat(
        &self,
        _request: &ChatRequest,
        _cancel: &CancellationToken,
    ) -> Result<Message, String> {
        Ok(Message {
            id: "resp".into(),
            role: "assistant".into(),
            content: Value::String(self.reply.clone()),
            usage: self.usage.clone(),
            timestamp: 0,
            ..Default::default()
        })
    }

    async fn chat_stream(
        &self,
        _request: &ChatRequest,
        _cancel: &CancellationToken,
        _on_event: &mut (dyn FnMut(crate::agent::types::StreamEvent) + Send),
    ) -> Result<(), String> {
        unreachable!("压缩只走非流式 chat")
    }
}

// ==================== 口径 ====================

#[test]
fn context_tokens_prefers_context_tokens_over_usage() {
    // AI 摘要消息的 usage 是**那次摘要调用**的消耗（含压缩前的历史）——
    // 拿它当占用会显示成「压缩后反而更大」，所以带 contextTokens 的消息优先
    let msgs = vec![
        with_usage(msg("assistant", "a"), 150_000),
        with_ctx(with_usage(msg("summary", "s"), 150_000), 12_000),
    ];
    assert_eq!(context_tokens(&msgs), Some(12_000));
}

#[test]
fn context_tokens_falls_back_to_newest_usage() {
    let msgs = vec![
        with_usage(msg("user", "u"), 1_000), // 没有 usage 的用户消息不参与
        with_usage(msg("assistant", "a"), 40_000),
    ];
    assert_eq!(context_tokens(&msgs), Some(40_000));
    // 空会话 / 全是无用量消息 → None（界面上不显示比例，而不是显示 0%）
    assert_eq!(context_tokens(&[]), None);
    assert_eq!(context_tokens(&[msg("user", "u")]), None);
}

#[test]
fn context_tokens_ignores_non_positive_ctx() {
    // contextTokens 为 0（或负数）时不算数，继续往前找 usage
    let msgs = vec![
        with_usage(msg("assistant", "a"), 5_000),
        with_ctx(msg("summary", "s"), 0),
    ];
    assert_eq!(context_tokens(&msgs), Some(5_000));
}

#[test]
fn ratio_percent_and_format_match_ts() {
    assert_eq!(context_ratio(100_000, CONTEXT_WINDOW_TOKENS), 0.5);
    // 超过窗口按 1.0 截断（TS: Math.min(used / MAX, 1)）
    assert_eq!(context_ratio(400_000, CONTEXT_WINDOW_TOKENS), 1.0);
    assert_eq!(context_percent(12_500, CONTEXT_WINDOW_TOKENS), 6); // Math.round(0.0625 * 100)
    assert_eq!(context_percent(100_000, CONTEXT_WINDOW_TOKENS), 50);
    assert_eq!(context_percent(0, CONTEXT_WINDOW_TOKENS), 0);
    // 与 TS formatTokens 同口径
    assert_eq!(format_tokens(999), "999");
    assert_eq!(format_tokens(12_500), "12.5k");
    assert_eq!(format_tokens(200_000), "200k");
}

#[test]
fn window_tokens_come_from_settings() {
    // 缺失 / 非法 / 非正数 → 默认值
    let empty = serde_json::Map::new();
    assert_eq!(window_tokens_from_settings(&empty), CONTEXT_WINDOW_TOKENS);
    let negative = json!({ CONTEXT_WINDOW_KEY: -1 })
        .as_object()
        .cloned()
        .unwrap();
    assert_eq!(window_tokens_from_settings(&negative), CONTEXT_WINDOW_TOKENS);
    // 合法值 → 原样（口径随窗口变化）
    let custom = json!({ CONTEXT_WINDOW_KEY: 100_000 })
        .as_object()
        .cloned()
        .unwrap();
    assert_eq!(window_tokens_from_settings(&custom), 100_000);
    assert_eq!(context_percent(50_000, 100_000), 50);
}

#[test]
fn should_compress_uses_ts_threshold() {
    assert!(!should_compress(None, CONTEXT_WINDOW_TOKENS));
    assert!(!should_compress(Some(79_999), CONTEXT_WINDOW_TOKENS)); // < 40%
    assert!(should_compress(Some(80_000), CONTEXT_WINDOW_TOKENS)); // = 40%
    assert!(should_compress(Some(150_000), CONTEXT_WINDOW_TOKENS));
}

#[test]
fn estimate_tokens_weights_cjk_higher_than_ascii_per_char() {
    // 同样 100 个字符：中文的估算必须显著高于纯 ASCII（TS 的 chars/4 对中文低估 3~4 倍）
    let cjk = estimate_tokens(&"中".repeat(100));
    let ascii = estimate_tokens(&"a".repeat(100));
    assert_eq!(ascii, 25);
    assert_eq!(cjk, 60);
    assert!(cjk > ascii * 2);
    assert_eq!(estimate_tokens(""), 0);
    // 多段拼接 = 先拼再算（与 TS `estimateTokens(...texts)` 同语义）
    assert_eq!(estimate_tokens_concat(&["中", "a"]), estimate_tokens("中a"));
}

// ==================== 切片 ====================

#[test]
fn compress_slice_starts_at_last_summary() {
    let msgs = vec![
        msg("user", "1"),
        msg("summary", "old"),
        msg("assistant", "2"),
        msg("summary", "new"),
        msg("user", "3"),
    ];
    assert_eq!(last_summary_index(&msgs), Some(3));
    let slice = compress_slice(&msgs);
    // 含 summary 本身（上一次摘要要在这次之上叠加，否则它的内容永久丢失）
    assert_eq!(slice.len(), 2);
    assert_eq!(slice[0].content, Value::String("new".into()));

    // 没有 summary → 全量
    let no_summary = vec![msg("user", "1"), msg("assistant", "2")];
    assert_eq!(last_summary_index(&no_summary), None);
    assert_eq!(compress_slice(&no_summary).len(), 2);
}

// ==================== 压缩产物 ====================

fn ctx_and_cancel() -> CancellationToken {
    CancellationToken::new()
}

#[tokio::test]
async fn raw_mode_produces_self_contained_summary_message() {
    let s = session();
    let msgs = vec![
        msg("user", "第一个问题"),
        msg("assistant", "第一个回答"),
        msg("user", "第二个问题"),
    ];
    let out = compress(CompressInput {
        mode: CompressMode::Raw,
        session: &s,
        messages: &msgs,
        tool_defs: &[],
        provider: None, // raw 不需要 provider（传 None 也必须成功）
    }, &ctx_and_cancel())
    .await
    .unwrap();

    assert_eq!(out.mode, CompressMode::Raw);
    assert_eq!(out.message.role, "summary");
    // 正文压缩的产物必须自包含：正文一字不删
    assert!(out.summary.contains("第一个问题"));
    assert!(out.summary.contains("第一个回答"));
    assert_eq!(out.message.content, Value::String(out.summary.clone()));
    // 两个口径：uiData.contextTokens = 压缩后占用；usage 也是它（raw 没有真实调用）
    assert_eq!(
        out.message.ui_data.as_ref().unwrap()["contextTokens"],
        json!(out.context_tokens)
    );
    assert_eq!(out.message.usage.as_ref().unwrap().total_tokens, out.context_tokens);
    assert!(out.llm.is_none(), "raw 模式不发请求、不记账");
    assert!(out.context_tokens > 0);
}

// ==================== 清单保活 ====================

#[test]
fn todo_recap_skips_snapshot_before_last_summary() {
    let msgs = vec![
        todo_msg(json!([{ "id": "1", "content": "A", "status": "pending" }])), // index 0
        msg("summary", "旧摘要"),                                                // index 1
        msg("user", "继续"),
    ];
    // slice 从 index 1 起 → 快照在区间外（上一次压缩已处理）→ 不补
    assert!(todo_recap(&msgs, 1).is_none());
    // slice 从 0 起 → 快照在区间内 → 补
    let recap = todo_recap(&msgs, 0).expect("应补入清单");
    assert!(recap.contains("[Todo list updated]"), "recap: {recap}");
    assert!(recap.contains("A"));
}

#[tokio::test]
async fn raw_keeps_active_todo_in_summary() {
    let s = session();
    let msgs = vec![
        msg("user", "开始"),
        todo_msg(json!([{ "id": "1", "content": "写工具", "status": "in_progress" }])),
    ];
    let out = compress(CompressInput {
        mode: CompressMode::Raw,
        session: &s,
        messages: &msgs,
        tool_defs: &[],
        provider: None,
    }, &ctx_and_cancel())
    .await
    .unwrap();
    // 压缩后模型看不到快照消息本体，但清单已补进摘要正文
    assert!(out.summary.contains("[Todo list updated]"), "summary: {}", out.summary);
    assert!(out.summary.contains("写工具"));
    assert_eq!(out.message.content, Value::String(out.summary.clone()));
}

#[tokio::test]
async fn rejects_when_nothing_to_compress() {
    let s = session();
    let err = compress(CompressInput {
        mode: CompressMode::Raw,
        session: &s,
        messages: &[msg("user", "只有一条")],
        tool_defs: &[],
        provider: None,
    }, &ctx_and_cancel())
    .await
    .unwrap_err();
    assert!(err.contains("至少需要 2 条"), "实际: {err}");

    // 空历史同样是「没得压」
    assert!(compress(CompressInput {
        mode: CompressMode::Raw,
        session: &s,
        messages: &[],
        tool_defs: &[],
        provider: None,
    }, &ctx_and_cancel())
    .await
    .is_err());
}

#[tokio::test]
async fn ai_mode_requires_provider() {
    let s = session();
    let msgs = vec![msg("user", "1"), msg("assistant", "2")];
    let err = compress(CompressInput {
        mode: CompressMode::Ai,
        session: &s,
        messages: &msgs,
        tool_defs: &[],
        provider: None,
    }, &ctx_and_cancel())
    .await
    .unwrap_err();
    assert!(err.contains("AI 摘要需要可用的 Provider"), "实际: {err}");
}

#[tokio::test]
async fn ai_mode_uses_provider_usage_and_keeps_two_accounting_scopes() {
    let s = session();
    let msgs = vec![
        msg("user", &"很长的历史".repeat(100)),
        msg("assistant", &"很长的回答".repeat(100)),
    ];
    let provider = MockProvider {
        reply: "这是摘要".to_string(),
        usage: Some(TokenUsage {
            prompt_tokens: 90_000,
            completion_tokens: 120,
            total_tokens: 90_120,
            cached_tokens: None,
        }),
    };
    let out = compress(CompressInput {
        mode: CompressMode::Ai,
        session: &s,
        messages: &msgs,
        tool_defs: &[],
        provider: Some(&provider),
    }, &ctx_and_cancel())
    .await
    .unwrap();

    assert_eq!(out.mode, CompressMode::Ai);
    assert_eq!(out.summary, "这是摘要");
    // ⚠️ 两个口径不可混用：usage = 这次摘要调用的真实消耗（含压缩前全部历史）；
    //    contextTokens = 压缩后下一轮请求的上下文大小（本地估算，必然更小）
    let usage = out.message.usage.as_ref().unwrap();
    assert_eq!(usage.total_tokens, 90_120);
    assert_eq!(
        out.message.ui_data.as_ref().unwrap()["contextTokens"],
        json!(out.context_tokens)
    );
    assert_eq!(out.message.ui_data.as_ref().unwrap()["compressMode"], json!("ai"));
    assert!(out.context_tokens < usage.total_tokens);
    let llm = out.llm.expect("ai 模式必须回报记账信息");
    assert!(!llm.estimated, "provider 回报了 usage → 不该标 estimated");
    assert_eq!(llm.usage.total_tokens, 90_120);
}

#[tokio::test]
async fn ai_mode_marks_estimated_when_provider_omits_usage() {
    let s = session();
    let msgs = vec![msg("user", "1"), msg("assistant", "2")];
    let provider = MockProvider {
        reply: "摘要".to_string(),
        usage: None,
    };
    let out = compress(CompressInput {
        mode: CompressMode::Ai,
        session: &s,
        messages: &msgs,
        tool_defs: &[],
        provider: Some(&provider),
    }, &ctx_and_cancel())
    .await
    .unwrap();
    let llm = out.llm.unwrap();
    assert!(llm.estimated, "provider 未回报 usage → 必须标 estimated");
    assert!(llm.usage.total_tokens > 0);
    // 兜底估算也要把 systemPrompt 算进去（它是随请求一起发出去的）
    assert!(llm.usage.prompt_tokens >= estimate_tokens("SYS"));
}

#[tokio::test]
async fn ai_mode_rejects_session_without_model() {
    let mut s = session();
    s.model_id = String::new();
    let provider = MockProvider {
        reply: "x".into(),
        usage: None,
    };
    let msgs = vec![msg("user", "1"), msg("assistant", "2")];
    let err = compress(CompressInput {
        mode: CompressMode::Ai,
        session: &s,
        messages: &msgs,
        tool_defs: &[],
        provider: Some(&provider),
    }, &ctx_and_cancel())
    .await
    .unwrap_err();
    assert!(err.contains("没有配置模型"), "实际: {err}");
}

#[tokio::test]
async fn raw_mode_stacks_on_previous_summary() {
    // 第二次压缩：输入是「上一次摘要 + 之后的消息」→ 旧摘要内容必须出现在新摘要里
    let s = session();
    let prev = Message {
        role: "summary".into(),
        content: Value::String("第一轮历史的摘要".into()),
        timestamp: 0,
        ..Default::default()
    };
    let msgs = vec![prev, msg("user", "之后的新消息"), msg("assistant", "新回答")];
    let out = compress(CompressInput {
        mode: CompressMode::Raw,
        session: &s,
        messages: &msgs,
        tool_defs: &[],
        provider: None,
    }, &ctx_and_cancel())
    .await
    .unwrap();
    assert!(out.summary.contains("第一轮历史的摘要"));
    assert!(out.summary.contains("之后的新消息"));
    assert!(out.summary.contains("## Earlier summary"));
}

#[tokio::test]
async fn compress_mode_parse_and_labels() {
    assert_eq!(CompressMode::parse("AI"), Some(CompressMode::Ai));
    assert_eq!(CompressMode::parse(" raw "), Some(CompressMode::Raw));
    assert_eq!(CompressMode::parse("正文"), None);
    assert_eq!(CompressMode::Ai.as_str(), "ai");
    assert_eq!(CompressMode::Raw.as_str(), "raw");
    assert_eq!(CompressMode::Ai.label(), "AI 摘要");
    assert_eq!(CompressMode::Raw.label(), "正文压缩");
    assert_eq!(CompressMode::ALL, [CompressMode::Ai, CompressMode::Raw]);
    // 工具调用参数（`tool_use` 块里带 input）里的 input 是 Value，不是 ToolUseContent
    let tc = ToolUseContent {
        type_: "tool_use".into(),
        id: "c".into(),
        name: "read_file".into(),
        input: json!({ "path": "a" }),
    };
    assert_eq!(tc.name, "read_file");
}
