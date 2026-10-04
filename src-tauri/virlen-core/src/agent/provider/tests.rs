//! provider 模块单测
//!
//! 拆分后不再是 `use super::*` 一把梭：跨子模块用到的名字显式导入，
//! 避免依赖父模块的私有 use 绑定（可读性也更好）。

use super::blocks::process_vision_content;
use super::super::types::{ChatRequest, Message, ToolDefinition, ToolParameters, ToolUseContent};
use super::{NativeAnthropicProvider, NativeOpenAiProvider};
use serde_json::{json, Value};

fn msg(
    role: &str,
    content: Value,
    optimize: Option<bool>,
    result: Option<&str>,
) -> Message {
    Message {
        id: "1".into(),
        role: role.into(),
        content,
        tool_calls: None,
        reasoning_content: None,
        tool_call_id: None,
        is_error: None,
        elapsed_ms: None,
        reasoning_elapsed_ms: None,
        ui_data: None,
        timestamp: 0,
        streaming: None,
        model: None,
        usage: None,
        image_vision_analyze_optimize: optimize,
        image_vision_analyze_result: result.map(String::from),
    }
}

fn chat_request(messages: Vec<Message>) -> ChatRequest {
    ChatRequest {
        model: "m".into(),
        messages,
        system_prompt: None,
        tools: vec![],
        temperature: 0.7,
        top_p: 1.0,
        max_tokens: 100,
        stream: false,
        tool_choice: "none".into(),
        reasoning_effort: None,
        thinking: None,
    }
}

#[test]
fn vision_process_filters_image_and_appends_result() {
    let m = msg(
        "user",
        json!([
            { "type": "text", "text": "看下这张图" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
        ]),
        Some(true),
        Some("用户上传了1张图片\n\n第1张图片\n[分析结果]"),
    );
    let processed = process_vision_content(&m).expect("应返回处理结果");
    let blocks = processed.as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["type"], "text");
    assert_eq!(blocks[0]["text"], "看下这张图");
    assert_eq!(blocks[1]["type"], "text");
    assert!(blocks[1]["text"].as_str().unwrap().contains("分析结果"));
    assert!(!processed.to_string().contains("image_url"));
}

#[test]
fn vision_process_string_content_becomes_blocks() {
    let m = msg("user", json!("看图"), Some(true), Some("分析结果"));
    let processed = process_vision_content(&m).unwrap();
    let blocks = processed.as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["text"], "看图");
    assert!(blocks[1]["text"].as_str().unwrap().contains("分析结果"));
}

#[test]
fn vision_process_skips_non_user_or_unmarked() {
    // 非 user 消息
    let m = msg("assistant", json!("hi"), Some(true), Some("结果"));
    assert!(process_vision_content(&m).is_none());
    // optimize=false
    let m = msg("user", json!("hi"), Some(false), Some("结果"));
    assert!(process_vision_content(&m).is_none());
    // result 为空字符串
    let m = msg("user", json!("hi"), Some(true), Some(""));
    assert!(process_vision_content(&m).is_none());
    // 未标记
    let m = msg("user", json!("hi"), None, None);
    assert!(process_vision_content(&m).is_none());
}

#[test]
fn openai_build_request_injects_vision_result() {
    let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let request = chat_request(vec![msg(
        "user",
        json!([
            { "type": "text", "text": "描述这张图" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
        ]),
        Some(true),
        Some("图中有一只猫"),
    )]);
    let body = p.build_request(&request);
    let body_str = body.to_string();
    assert!(!body_str.contains("image_url"));
    assert!(body_str.contains("图中有一只猫"));
}

#[test]
fn openai_build_request_keeps_image_without_optimize() {
    let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let request = chat_request(vec![msg(
        "user",
        json!([
            { "type": "text", "text": "描述这张图" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
        ]),
        None,
        None,
    )]);
    let body = p.build_request(&request);
    assert!(body.to_string().contains("image_url"));
}

#[test]
fn anthropic_build_request_converts_file_block_to_path_text() {
    let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
    let request = chat_request(vec![msg(
        "user",
        json!([
            { "type": "text", "text": "读一下" },
            { "type": "file", "path": "C:/a/b.ts", "name": "b.ts" },
            { "type": "file", "path": "C:/dir", "isDir": true }
        ]),
        None,
        None,
    )]);
    let body = p.build_request(&request);
    let text = body.to_string();

    // 文件附件降级为文本块，路径必须原样透传给模型（对齐 TS 侧 fileBlockToText）
    // 故意断言字面量：常量被改时会红，提醒同步 TS / Rust 两侧（铁律 1）
    assert!(text.contains("[User attached file] C:/a/b.ts"));
    assert!(text.contains("[User attached folder] C:/dir"));
    // 不能把 file 这种自定义块丢给 Anthropic
    assert!(!text.contains("\"type\":\"file\""));
}

#[test]
fn anthropic_build_request_converts_quote_block_to_text() {
    let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
    let request = chat_request(vec![msg(
        "user",
        json!([
            { "type": "quote", "messageId": "m-1", "role": "assistant", "text": "上一轮的结论" },
            { "type": "text", "text": "继续" }
        ]),
        None,
        None,
    )]);
    let body = p.build_request(&request);
    let text = body.to_string();

    // 引用块降级为文本（发送方 + id + 正文），对齐 TS 侧 quoteBlockToText
    assert!(!text.contains("\"type\":\"quote\""));
    assert!(text.contains("[Quoted message]"));
    assert!(text.contains("Sender: assistant"));
    assert!(text.contains("Message ID: m-1"));
    assert!(text.contains("Content:"));
    assert!(text.contains("上一轮的结论"));
}

#[test]
fn build_request_converts_skill_block_to_full_text() {
    // 技能引用：SKILL.md 全文必须原样带出（OpenAI / Anthropic 两个协议都要降级）
    let blocks = json!([
        {
            "type": "skill",
            "name": "code-reviewer",
            "path": "C:/skills/code-reviewer",
            "content": "# 审查规则\n先看边界。"
        },
        { "type": "text", "text": "用它审查" }
    ]);

    // 故意断言字面量：常量被改时会红，提醒同步 TS / Rust 两侧（铁律 1）
    let openai = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let body = openai.build_request(&chat_request(vec![msg("user", blocks.clone(), None, None)]));
    let text = body.to_string();
    assert!(!text.contains("\"type\":\"skill\""));
    assert!(text.contains("[Skill]"));
    assert!(text.contains("Name: code-reviewer"));
    assert!(text.contains("Directory: C:/skills/code-reviewer"));
    assert!(text.contains("SKILL.md:"));
    assert!(text.contains("先看边界。"));

    let anthropic = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
    let body = anthropic.build_request(&chat_request(vec![msg("user", blocks, None, None)]));
    let text = body.to_string();
    assert!(!text.contains("\"type\":\"skill\""));
    assert!(text.contains("[Skill]"));
    assert!(text.contains("先看边界。"));
}

#[test]
fn openai_build_request_converts_file_and_quote_blocks() {
    let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let request = chat_request(vec![msg(
        "user",
        json!([
            { "type": "quote", "messageId": "m-1", "role": "user", "text": "给我写个函数" },
            { "type": "text", "text": "继续" },
            { "type": "file", "path": "C:/a/b.ts", "name": "b.ts" },
            { "type": "file", "path": "C:/dir", "isDir": true }
        ]),
        None,
        None,
    )]);
    let body = p.build_request(&request);
    let text = body.to_string();

    // OpenAI 兼容协议只有 text / image_url，自定义块必须降级而不能原样透传
    assert!(!text.contains("\"type\":\"file\""));
    assert!(!text.contains("\"type\":\"quote\""));
    assert!(text.contains("[User attached file] C:/a/b.ts"));
    assert!(text.contains("[User attached folder] C:/dir"));
    assert!(text.contains("[Quoted message]"));
    assert!(text.contains("Sender: user"));
    assert!(text.contains("Message ID: m-1"));
}

#[test]
fn openai_build_request_converts_blocks_after_vision() {
    // 图片 + 文件混排且开启视觉优化：vision 重建后的块同样必须降级
    let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let request = chat_request(vec![msg(
        "user",
        json!([
            { "type": "file", "path": "C:/a/b.ts" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
        ]),
        Some(true),
        Some("图中有一只猫"),
    )]);
    let body = p.build_request(&request);
    let text = body.to_string();
    assert!(!text.contains("image_url"));
    assert!(!text.contains("\"type\":\"file\""));
    assert!(text.contains("[User attached file] C:/a/b.ts"));
}

#[test]
fn openai_assistant_empty_content_with_tool_calls_is_null() {
    // assistant 带 tool_calls 且正文为空串 → content 必须为 null
    // （OpenAI strict 模式 / 部分兼容 API 会校验失败）
    let mut m = msg("assistant", json!(""), None, None);
    m.tool_calls = Some(vec![ToolUseContent {
        type_: "tool_use".into(),
        id: "c1".into(),
        name: "read_file".into(),
        input: json!({}),
    }]);
    let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let body = p.build_request(&chat_request(vec![m]));
    assert!(body["messages"][0]["content"].is_null());
}

#[test]
fn anthropic_build_request_injects_vision_result() {
    let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
    let request = chat_request(vec![msg(
        "user",
        json!([
            { "type": "text", "text": "描述这张图" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,xxx" } }
        ]),
        Some(true),
        Some("图中有一只猫"),
    )]);
    let body = p.build_request(&request);
    let body_str = body.to_string();
    assert!(!body_str.contains("image_url"));
    assert!(body_str.contains("图中有一只猫"));
}

#[test]
fn openai_thinking_false_disables_reasoning() {
    // 与 TS `openai.ts` 同语义：thinking === false → `thinking:{type:'disabled'}` +
    // `reasoning_effort:'none'`，且**优先于** request.reasoning_effort
    let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let mut request = chat_request(vec![msg("user", json!("hi"), None, None)]);
    request.thinking = Some(false);
    request.reasoning_effort = Some("high".into()); // 必须被 thinking 覆盖
    let body = p.build_request(&request);
    assert_eq!(body["thinking"], json!({ "type": "disabled" }));
    assert_eq!(body["reasoning_effort"], json!("none"));
}

#[test]
fn openai_without_thinking_keeps_reasoning_effort() {
    // thinking 为 None 时不写 thinking、reasoning_effort 照传（普通聊天路径）
    let p = NativeOpenAiProvider::new("test", "key", "https://api.test.com");
    let mut request = chat_request(vec![msg("user", json!("hi"), None, None)]);
    request.reasoning_effort = Some("high".into());
    let body = p.build_request(&request);
    assert!(body["thinking"].is_null());
    assert_eq!(body["reasoning_effort"], json!("high"));
}

#[test]
fn anthropic_thinking_false_disables_reasoning() {
    let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
    let mut request = chat_request(vec![msg("user", json!("hi"), None, None)]);
    request.thinking = Some(false);
    let body = p.build_request(&request);
    assert_eq!(body["thinking"], json!({ "type": "disabled" }));
    // 不禁用时不得写入该字段
    let plain = p.build_request(&chat_request(vec![msg("user", json!("hi"), None, None)]));
    assert!(plain["thinking"].is_null());
}

// ==================== Anthropic prompt caching（显式缓存断点） ====================
//
// 背景：Anthropic 的前缀缓存**必须显式打断点**，否则 `cache_read_input_tokens` 恒为 0
//（= 每轮按输入价全额重算整段历史）。断点位置策略写死在 `anthropic.rs::build_request`，
// 这三条测试就是它的护栏。

/// 造一条「带工具 + 可选 system」的请求（断点 ①/② 的前提）
fn cache_request(system: Option<&str>, tool_count: usize, messages: Vec<Message>) -> ChatRequest {
    let mut req = chat_request(messages);
    req.system_prompt = system.map(String::from);
    req.tools = (0..tool_count)
        .map(|i| ToolDefinition {
            name: format!("tool_{i}"),
            label: None,
            description: "d".into(),
            parameters: ToolParameters {
                type_: "object".into(),
                properties: json!({}),
                required: vec![],
                one_of: None,
            },
        })
        .collect();
    req
}

/// 数一个 body 里一共打了几个 `cache_control`（用来守「上限 4」）
fn count_breakpoints(v: &Value) -> usize {
    match v {
        Value::Object(map) => {
            let self_hit = usize::from(map.contains_key("cache_control"));
            self_hit + map.values().map(count_breakpoints).sum::<usize>()
        }
        Value::Array(arr) => arr.iter().map(count_breakpoints).sum(),
        _ => 0,
    }
}

#[test]
fn anthropic_marks_three_cache_breakpoints() {
    let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");
    let request = cache_request(
        Some("  你是助手  "), // 故意带空白：断点挂在 trim 后的文本上，与旧实现逐字一致
        3,
        vec![
            msg("user", json!("第一轮"), None, None),
            msg("user", json!("第二轮"), None, None),
        ],
    );
    let body = p.build_request(&request);

    // ① 工具尾：**只有最后一个**工具带断点
    let tools = body["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 3);
    assert!(tools[0]["cache_control"].is_null());
    assert!(tools[1]["cache_control"].is_null());
    assert_eq!(tools[2]["cache_control"], json!({ "type": "ephemeral" }));

    // ② system 由裸字符串改成「带断点的文本块数组」，文本仍按 trim 后下发
    assert_eq!(body["system"][0]["type"], json!("text"));
    assert_eq!(body["system"][0]["text"], json!("你是助手"));
    assert_eq!(body["system"][0]["cache_control"], json!({ "type": "ephemeral" }));

    // ③ 只有**最后一条**消息的**最后一个**块带断点；更早的消息一个都不带
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(count_breakpoints(&msgs[0]), 0, "历史消息不得带断点");
    let tail = msgs[1]["content"].as_array().unwrap().last().unwrap();
    assert_eq!(tail["cache_control"], json!({ "type": "ephemeral" }));

    // 上限 4：这里一共 3 个
    assert_eq!(count_breakpoints(&body), 3);
}

#[test]
fn anthropic_breakpoints_degrade_when_parts_are_missing() {
    let p = NativeAnthropicProvider::new("test", "key", "https://api.test.com");

    // 无工具 + 无 system（标题生成 / 校验这类一次性请求的形状）→ 只剩对话尾一个
    let body = p.build_request(&cache_request(
        None,
        0,
        vec![msg("user", json!("hi"), None, None)],
    ));
    assert!(body["tools"].is_null());
    assert!(body["system"].is_null());
    assert_eq!(count_breakpoints(&body), 1);

    // 末尾块不可缓存（空 content 数组）→ 不硬塞断点，也不 panic
    let body = p.build_request(&cache_request(
        Some("S"),
        0,
        vec![msg("user", json!([]), None, None)],
    ));
    assert_eq!(body["messages"][0]["content"], json!([]));
    assert_eq!(count_breakpoints(&body), 1, "只剩 system 那一个");

    // 空文本块同理：只带 thinking 的 assistant 会拼成 [thinking, text("")]，末尾是空文本
    let mut m = msg("assistant", json!(""), None, None);
    m.reasoning_content = Some("想了很久".into());
    let body = p.build_request(&cache_request(None, 0, vec![m]));
    assert_eq!(body["messages"][0]["content"][0]["type"], json!("thinking"));
    assert!(body["messages"][0]["content"][1]["cache_control"].is_null());
    assert_eq!(count_breakpoints(&body), 0);
}

#[test]
fn mark_tail_block_only_touches_whitelisted_non_empty_blocks() {
    // 白名单内的非空文本 → 打上
    let mut ok = json!({ "role": "user", "content": [{ "type": "text", "text": "x" }] });
    assert!(super::anthropic::mark_tail_block(&mut ok));
    assert_eq!(ok["content"][0]["cache_control"], json!({ "type": "ephemeral" }));

    // thinking 不在白名单：挂上去会被服务端 400 掉整个请求
    let mut thinking = json!({ "role": "assistant", "content": [{ "type": "thinking", "thinking": "…" }] });
    assert!(!super::anthropic::mark_tail_block(&mut thinking));
    assert!(thinking["content"][0].get("cache_control").is_none());

    // 块类型对但内容为空 / 全空白 → 也不挂（不给边界情况再添一个变数）
    for text in ["", "   \n "] {
        let mut m = json!({ "role": "assistant", "content": [{ "type": "text", "text": text }] });
        assert!(!super::anthropic::mark_tail_block(&mut m), "空文本不应打断点");
    }

    // 空数组 / content 不是数组 → 什么都不做（不得 panic）
    let mut empty = json!({ "role": "user", "content": [] });
    assert!(!super::anthropic::mark_tail_block(&mut empty));
    let mut string_content = json!({ "role": "user", "content": "hi" });
    assert!(!super::anthropic::mark_tail_block(&mut string_content));

    // tool_result / tool_use / image 都在白名单里
    for kind in ["tool_result", "tool_use", "image"] {
        let mut m = json!({ "role": "user", "content": [{ "type": kind }] });
        assert!(super::anthropic::mark_tail_block(&mut m), "{kind} 应在白名单里");
    }
}
