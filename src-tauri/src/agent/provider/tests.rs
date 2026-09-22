//! provider 模块单测
//!
//! 拆分后不再是 `use super::*` 一把梭：跨子模块用到的名字显式导入，
//! 避免依赖父模块的私有 use 绑定（可读性也更好）。

use super::blocks::process_vision_content;
use super::super::types::{ChatRequest, Message, ToolUseContent};
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
