//! 正文压缩（本地渲染）
//!
//! 只砍信息密度最低的部分：① 深度思考（`reasoningContent`）整段丢弃（过程性内容，对后续对话价值最
//! 低）；② 工具调用参数 / 工具结果超长则省略（工具输出通常占历史里绝大部分 token）；③ 图片块进不了
//! 文本 → 降级为占位，该消息做过本地视觉分析则保留分析文本。
//!
//! 用户 / 助手正文一字不删。
//!
//! ⚠️ 产物必须自包含：请求组装会丢掉最后一个 summary 之前的全部消息
//! （`provider::blocks::slice_messages`），所以这里把整段历史渲染成一段纯文本。截断按字符（码点）计
//! （TS 按 UTF-16 码元 → 阈值附近可能差 ±1 字符）；按码点切分不会切出非法字符。

use crate::agent::provider::{file_block_to_text, quote_block_to_text, skill_block_to_text};
use crate::agent::types::Message;
use serde_json::Value;
use std::collections::HashMap;

/// 工具调用参数超过该长度即省略尾部（参数是结构化的，保留头部可读性最好）
const TOOL_ARGS_MAX_CHARS: usize = 300;
/// 工具结果超过该长度即省略中间
const TOOL_RESULT_MAX_CHARS: usize = 800;
/// 工具结果省略时保留的头部 / 尾部长度（尾部常带报错、汇总等结论）
const TOOL_RESULT_HEAD_CHARS: usize = 500;
const TOOL_RESULT_TAIL_CHARS: usize = 200;

/// 图片块占位（图片本身进不了文本上下文）
const IMAGE_PLACEHOLDER: &str = "[Image]";

/// 压缩结果
#[derive(Debug, Clone)]
pub struct RawCompressResult {
    /// 压缩后的历史文本（写入 summary 消息的 content）
    pub summary: String,
    /// 被省略的总字符数（供 UI 提示说明）
    pub omitted_chars: usize,
}

/// 省略标记 —— 模型可读的非 UI 文案（英文，与 TS `omitMark` 逐字一致）：
/// 必须显式告诉模型「这里被裁掉了多少」，否则它会以为内容本就这么短。
fn omit_mark(chars: usize) -> String {
    format!("…({} characters omitted)", chars)
}

/// 角色标题（模型可读）—— 与 TS `ROLE_HEADERS` 逐字一致
fn role_header(role: &str) -> String {
    match role {
        "user" => "## User".to_string(),
        "assistant" => "## Assistant".to_string(),
        "summary" => "## Earlier summary".to_string(),
        "feedback" => "## Verification feedback".to_string(),
        other => format!("## {}", other),
    }
}

/// 按**字符**计长（避免按字节切出半个 UTF-8 字符）
fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// 取前 `n` 个字符
fn take_head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 取后 `n` 个字符
fn take_tail(s: &str, n: usize) -> String {
    let total = char_len(s);
    s.chars().skip(total.saturating_sub(n)).collect()
}

/// 截断尾部：保留前 `max` 个字符
fn truncate_tail(text: &str, max: usize) -> (String, usize) {
    let len = char_len(text);
    if len <= max {
        return (text.to_string(), 0);
    }
    let omitted = len - max;
    (format!("{}\n{}", take_head(text, max), omit_mark(omitted)), omitted)
}

/// 截断中间：保留头 `head` + 尾 `tail` 个字符
fn truncate_middle(text: &str, max: usize, head: usize, tail: usize) -> (String, usize) {
    let len = char_len(text);
    if len <= max {
        return (text.to_string(), 0);
    }
    let omitted = len.saturating_sub(head + tail);
    (
        format!(
            "{}\n{}\n{}",
            take_head(text, head),
            omit_mark(omitted),
            take_tail(text, tail)
        ),
        omitted,
    )
}

/// 参数对象 → JSON 字符串（非序列化值兜底，**不能**因压缩失败而中断）
fn safe_stringify(input: Option<&Value>) -> String {
    match input {
        None | Some(Value::Null) => "{}".to_string(),
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| v.to_string()),
    }
}

/// 文本块取值（`{type:"text", text}`）
fn block_text(block: &Value) -> Option<&str> {
    block.get("text").and_then(Value::as_str)
}

/// 消息 content → 纯文本（对齐 TS `contentToText`）
///
/// 正文（text 块）一字不删；file / quote / skill 块复用协议层共用的降级函数，
/// 保证「压缩后的历史」与「消息直接发给模型时」看到同一套文本形式。
fn content_to_text(msg: &Message) -> String {
    let parts: Vec<String> = match &msg.content {
        Value::String(s) => return s.clone(),
        Value::Array(blocks) => {
            let mut parts: Vec<String> = Vec::new();
            // 视觉分析结果属于消息级、不该在多张图片时重复膨胀，只挂在第一张图上
            let mut vision_used = false;
            let vision_text = msg.image_vision_analyze_result.as_deref().unwrap_or("");
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => parts.push(block_text(block).unwrap_or("").to_string()),
                    Some("file") => parts.push(file_block_to_text(block)),
                    Some("quote") => parts.push(quote_block_to_text(block)),
                    Some("skill") => parts.push(skill_block_to_text(block)),
                    Some("tool_result") => {
                        parts.push(block.get("content").and_then(Value::as_str).unwrap_or("").to_string())
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                        parts.push(format!(
                            "- [tool call] {}: {}",
                            name,
                            safe_stringify(block.get("input"))
                        ));
                    }
                    Some("image_url") => {
                        if !vision_text.is_empty() && !vision_used {
                            vision_used = true;
                            parts.push(format!("{}\n{}", IMAGE_PLACEHOLDER, vision_text));
                        } else {
                            parts.push(IMAGE_PLACEHOLDER.to_string());
                        }
                    }
                    // 未知块类型：TS 的 switch 无 default → 同样跳过
                    _ => {}
                }
            }
            parts
        }
        _ => Vec::new(),
    };
    parts
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 是否有图片块（决定要不要加占位说明）
fn has_image_block(messages: &[Message]) -> bool {
    messages.iter().any(|m| match &m.content {
        Value::Array(blocks) => blocks
            .iter()
            .any(|b| b.get("type").and_then(Value::as_str) == Some("image_url")),
        _ => false,
    })
}

/// `toolCallId` → 工具名。
///
/// 工具结果消息只带 `toolCallId` 不带工具名；映射后摘要里能写出
/// `## Tool result: read_file` 而不是一串无意义 id，模型可读性显著更好。
fn collect_tool_names(messages: &[Message]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for msg in messages {
        for tc in msg.tool_calls.iter().flatten() {
            if !tc.id.is_empty() {
                map.insert(tc.id.clone(), tc.name.clone());
            }
        }
    }
    map
}

/// 头部说明：告诉模型这段历史被怎么处理过（省略量显式写出）—— 与 TS `buildPreamble` 逐字一致
fn build_preamble(has_image: bool, omitted_chars: usize) -> String {
    let mut notes = vec![
        "Locally compressed historical context: reasoning content removed; user and assistant messages kept verbatim; oversized tool arguments and results truncated.".to_string(),
    ];
    if has_image {
        notes.push("Images are represented as placeholders (analysis text kept when available).".to_string());
    }
    if omitted_chars > 0 {
        notes.push(format!("Truncated {} characters in total.", omitted_chars));
    }
    format!(
        "# Conversation history\n\n{}",
        notes
            .iter()
            .map(|n| format!("> {}", n))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

/// 把历史消息渲染成一段自包含的纯文本（正文压缩的核心）
///
/// `messages` 应是**已切片**的压缩输入（调用方先用 `compress::compress_slice` 取
/// 「最后一个 summary 起算」的区间）。
pub fn build_raw_summary(messages: &[Message]) -> RawCompressResult {
    let tool_names = collect_tool_names(messages);
    let mut blocks: Vec<String> = Vec::new();
    let mut omitted_chars = 0usize;

    for msg in messages {
        // 工具结果：只保留头尾，中间省略（工具输出占了历史里的大头）
        if msg.role == "tool" {
            let name = msg
                .tool_call_id
                .as_deref()
                .and_then(|id| tool_names.get(id))
                .map(String::as_str);
            let (text, omitted) = truncate_middle(
                &content_to_text(msg),
                TOOL_RESULT_MAX_CHARS,
                TOOL_RESULT_HEAD_CHARS,
                TOOL_RESULT_TAIL_CHARS,
            );
            omitted_chars += omitted;
            let header = format!(
                "## Tool result{}{}",
                name.map(|n| format!(": {}", n)).unwrap_or_default(),
                if msg.is_error == Some(true) { " (error)" } else { "" }
            );
            blocks.push(if text.is_empty() {
                header
            } else {
                format!("{}\n{}", header, text)
            });
            continue;
        }

        let mut lines = vec![role_header(&msg.role)];
        let body = content_to_text(msg);
        if !body.is_empty() {
            lines.push(body);
        }

        // 助手发起的工具调用：保留「调用了哪个工具 + 参数」，参数超长只截尾部。
        // 深度思考（reasoning_content）按需求**整段丢弃**，连占位都不写（头部说明已交代）。
        for tc in msg.tool_calls.iter().flatten() {
            let (args, omitted) = truncate_tail(&safe_stringify(Some(&tc.input)), TOOL_ARGS_MAX_CHARS);
            omitted_chars += omitted;
            lines.push(format!("- [tool call] {}: {}", tc.name, args));
        }

        blocks.push(lines.join("\n"));
    }

    let summary = std::iter::once(build_preamble(has_image_block(messages), omitted_chars))
        .chain(blocks)
        .collect::<Vec<_>>()
        .join("\n\n");

    RawCompressResult {
        summary,
        omitted_chars,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(role: &str, content: Value) -> Message {
        Message {
            id: "m".into(),
            role: role.into(),
            content,
            timestamp: 0,
            ..Default::default()
        }
    }

    /// 正文一字不删 —— 这是正文压缩与「删掉历史」的根本区别
    #[test]
    fn keeps_user_and_assistant_text_verbatim() {
        let out = build_raw_summary(&[
            msg("user", json!("请解释 E:/a/b 这个目录")),
            msg("assistant", json!("它是一段很长的正文……")),
        ]);
        assert!(out.summary.contains("## User\n请解释 E:/a/b 这个目录"));
        assert!(out.summary.contains("## Assistant\n它是一段很长的正文……"));
        assert_eq!(out.omitted_chars, 0);
        assert!(out.summary.starts_with("# Conversation history"));
    }

    /// 深度思考整段丢弃（连占位都不写）
    #[test]
    fn drops_reasoning_content_entirely() {
        let mut m = msg("assistant", json!("正文"));
        m.reasoning_content = Some("很长很长的思考过程".repeat(50));
        let out = build_raw_summary(&[m]);
        assert!(!out.summary.contains("思考过程"));
        assert!(out.summary.contains("正文"));
    }

    /// 工具结果只留头尾，且省略量必须显式写出来（否则模型以为内容本就这么短）
    #[test]
    fn truncates_tool_result_middle() {
        let mut tool = msg("tool", json!("H".repeat(5000)));
        tool.tool_call_id = Some("c1".into());
        let mut assistant = msg("assistant", json!(""));
        assistant.tool_calls = Some(vec![crate::agent::types::ToolUseContent {
            type_: "tool_use".into(),
            id: "c1".into(),
            name: "read_file".into(),
            input: json!({ "path": "a.txt" }),
        }]);

        let out = build_raw_summary(&[assistant, tool]);
        // 工具名从 tool_calls 映射出来（否则摘要里只有一串无意义 id）
        assert!(out.summary.contains("## Tool result: read_file"));
        assert!(out.summary.contains("characters omitted"));
        assert_eq!(out.omitted_chars, 5000 - 500 - 200);
        assert!(out.summary.contains("Truncated 4300 characters in total."));
    }

    /// 工具参数超长只截尾部
    #[test]
    fn truncates_long_tool_args_tail() {
        let mut m = msg("assistant", json!("ok"));
        m.tool_calls = Some(vec![crate::agent::types::ToolUseContent {
            type_: "tool_use".into(),
            id: "c1".into(),
            name: "write_file".into(),
            input: json!({ "content": "x".repeat(1000) }),
        }]);
        let out = build_raw_summary(&[m]);
        assert!(out.omitted_chars > 0);
        assert!(out.summary.contains("- [tool call] write_file: "));
    }

    /// 工具结果出错时带上 (error) 标记
    #[test]
    fn marks_error_tool_result() {
        let mut tool = msg("tool", json!("boom"));
        tool.is_error = Some(true);
        let out = build_raw_summary(&[tool]);
        assert!(out.summary.contains("## Tool result (error)"));
    }

    /// 图片块 → 占位；做过本地视觉分析则保留分析文本，且只挂第一张图
    #[test]
    fn images_become_placeholders_with_vision_text_once() {
        let mut m = msg(
            "user",
            json!([
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,BBB" } }
            ]),
        );
        m.image_vision_analyze_result = Some("图里有一只猫".into());
        let out = build_raw_summary(&[m]);
        assert_eq!(out.summary.matches("[Image]").count(), 2);
        assert_eq!(out.summary.matches("图里有一只猫").count(), 1);
        assert!(out.summary.contains("Images are represented as placeholders"));
    }

    /// file / quote / skill 块复用协议层降级函数（保证两侧文本形式一致）
    #[test]
    fn reuses_protocol_block_text() {
        let m = msg(
            "user",
            json!([
                { "type": "file", "path": "E:/a/b.txt", "isDir": false },
                { "type": "skill", "name": "s1", "path": "E:/s", "content": "SKILL 正文" }
            ]),
        );
        let out = build_raw_summary(&[m]);
        assert!(out.summary.contains("[User attached file] E:/a/b.txt"));
        assert!(out.summary.contains("[Skill]\nName: s1"));
        assert!(out.summary.contains("SKILL 正文"));
    }

    /// 多轮之间用空行分隔，且段落顺序与输入一致（模型读起来像一段按时间排的历史）
    #[test]
    fn joins_blocks_in_order_with_blank_line() {
        let out = build_raw_summary(&[msg("user", json!("一")), msg("assistant", json!("二"))]);
        let user = out.summary.find("## User").unwrap();
        let assistant = out.summary.find("## Assistant").unwrap();
        assert!(user < assistant);
        assert!(out.summary.contains("一\n\n## Assistant"));
    }
}
