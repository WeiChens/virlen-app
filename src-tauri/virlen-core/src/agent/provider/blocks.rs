//! 内容块降级与视觉处理 — OpenAI / Anthropic 两协议共用的「块 → 文本」逻辑
//!
//! 这里同时是「附件 / 引用 / 技能」标签常量的唯一落点：文案必须与 TS 侧
//! `src/types/index.ts` 的同名常量逐字一致（铁律 1：双引擎同语义），改文案要两边一起改。

use super::super::types::Message;
use serde_json::{json, Value};

// ==================== 附件块标签（模型可读文本） ====================

/// 文件 / 文件夹附件块降级成文本时、打在路径前面的标记。
///
/// 与 TS 侧 `src/types/index.ts` 的同名常量必须逐字一致（铁律 1：双引擎同语义），
/// 改文案要两边一起改。这是给模型看的提示文本、不是 UI 文案，所以不进 i18n。
const ATTACHED_FILE_LABEL: &str = "[User attached file]";
const ATTACHED_DIR_LABEL: &str = "[User attached folder]";

/// 引用消息块降级成文本时使用的标签。
///
/// 与 TS 侧 `src/types/index.ts` 的同名常量必须逐字一致（铁律 1），
/// 同时与 TS `quoteBlockToText` 的拼接格式保持一致：
///
/// ```text
/// [Quoted message]
/// Sender: user
/// Message ID: <id>
/// Content:
/// <正文>
/// ```
const QUOTED_MESSAGE_LABEL: &str = "[Quoted message]";
const QUOTE_SENDER_LABEL: &str = "Sender";
const QUOTE_MESSAGE_ID_LABEL: &str = "Message ID";
const QUOTE_CONTENT_LABEL: &str = "Content";

/// 技能引用块降级成文本时使用的标签。
///
/// 与 TS 侧 `src/types/index.ts` 的同名常量必须逐字一致（铁律 1），
/// 同时与 TS `skillBlockToText` 的拼接格式保持一致：
///
/// ```text
/// [Skill]
/// Name: my-skill
/// Directory: <技能目录绝对路径>
/// SKILL.md:
/// <SKILL.md 全文>
/// ```
///
/// ⚠️ 四个字段恒定输出（缺失时为空值），不做条件拼接 —— 条件分支最容易
/// 让 TS / Rust 两侧的输出产生一个换行的差异。
const SKILL_BLOCK_LABEL: &str = "[Skill]";
const SKILL_NAME_LABEL: &str = "Name";
const SKILL_DIR_LABEL: &str = "Directory";
const SKILL_CONTENT_LABEL: &str = "SKILL.md";

// ==================== 通用工具 ====================

/// 找到最后一个 summary 消息的下标（返回其后的消息参与请求）
pub(super) fn last_summary_index(messages: &[Message]) -> usize {
    let mut index = messages.len();
    for (i, m) in messages.iter().enumerate() {
        if m.role == "summary" {
            index = i;
        }
    }
    // TS: index === -1 ? all : slice(lastSummaryMessageIndex)
    if index == messages.len() {
        0
    } else {
        index
    }
}

pub(super) fn slice_messages(messages: &[Message]) -> &[Message] {
    let start = last_summary_index(messages);
    if start == 0 {
        messages
    } else {
        &messages[start..]
    }
}

/// 文件 / 文件夹附件块 → 文本（对齐 TS `fileBlockToText`）
pub(super) fn file_block_to_text(block: &Value) -> String {
    let path = block.get("path").and_then(Value::as_str).unwrap_or("");
    let is_dir = block.get("isDir").and_then(Value::as_bool).unwrap_or(false);
    let label = if is_dir {
        ATTACHED_DIR_LABEL
    } else {
        ATTACHED_FILE_LABEL
    };
    format!("{} {}", label, path)
}

/// 引用消息块 → 文本（对齐 TS `quoteBlockToText`）
pub(super) fn quote_block_to_text(block: &Value) -> String {
    let role = block.get("role").and_then(Value::as_str).unwrap_or("");
    let message_id = block.get("messageId").and_then(Value::as_str).unwrap_or("");
    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
    format!(
        "{}\n{}: {}\n{}: {}\n{}:\n{}",
        QUOTED_MESSAGE_LABEL,
        QUOTE_SENDER_LABEL,
        role,
        QUOTE_MESSAGE_ID_LABEL,
        message_id,
        QUOTE_CONTENT_LABEL,
        text
    )
}

/// 技能引用块 → 文本（对齐 TS `skillBlockToText`）
///
/// SKILL.md 全文原样带出（这就是「引用技能」的语义），目录行让模型能
/// 顺着 `Directory` 用文件工具读取脚本等其它资源。
pub(super) fn skill_block_to_text(block: &Value) -> String {
    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
    let path = block.get("path").and_then(Value::as_str).unwrap_or("");
    let content = block.get("content").and_then(Value::as_str).unwrap_or("");
    format!(
        "{}\n{}: {}\n{}: {}\n{}:\n{}",
        SKILL_BLOCK_LABEL,
        SKILL_NAME_LABEL,
        name,
        SKILL_DIR_LABEL,
        path,
        SKILL_CONTENT_LABEL,
        content
    )
}

/// content 块数组 → OpenAI 兼容块
///
/// OpenAI 协议只有 text / image_url：file（附件）/ quote（引用）/ skill（技能引用）
/// 没有对应结构，统一降级为文本（只带路径 / 带发送方 + id + 正文 / 带 SKILL.md 全文）。
/// 其余块原样透传。行为需与 TS 侧 `openai.ts::toOpenAiBlocks` 一致（铁律 1）。
pub(super) fn openai_blocks(blocks: &[Value]) -> Vec<Value> {
    blocks
        .iter()
        .map(|block| match block.get("type").and_then(Value::as_str) {
            Some("file") => json!({ "type": "text", "text": file_block_to_text(block) }),
            Some("quote") => json!({ "type": "text", "text": quote_block_to_text(block) }),
            Some("skill") => json!({ "type": "text", "text": skill_block_to_text(block) }),
            _ => block.clone(),
        })
        .collect()
}

/// 消息 content → OpenAI 兼容的 content 字段（对齐 TS `openai.ts::buildRequest`）
///
/// - string：assistant 带 tool_calls 且正文为空串时必须给 null，
///   否则部分 OpenAI 兼容 API 会校验失败
/// - 数组：逐块降级（file / quote → 文本）
pub(super) fn openai_content(msg: &Message, content: &Value) -> Value {
    match content {
        Value::String(s) => {
            let has_tool_calls = msg
                .tool_calls
                .as_ref()
                .map(|tcs| !tcs.is_empty())
                .unwrap_or(false);
            if msg.role == "assistant" && has_tool_calls && s.is_empty() {
                Value::Null
            } else {
                Value::String(s.clone())
            }
        }
        Value::Array(arr) => Value::Array(openai_blocks(arr)),
        other => other.clone(),
    }
}

/// content 块数组 → Anthropic 内容块
///
/// file（附件）/ quote（引用）/ skill（技能引用）在 Anthropic 协议里没有对应结构，
/// 统一降级为文本。行为需与 TS 侧 `anthropic.ts::toAnthropicBlocks` 一致（铁律 1）。
pub(super) fn anthropic_blocks(blocks: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => out.push(json!({
                "type": "text",
                "text": block.get("text").and_then(Value::as_str).unwrap_or(""),
            })),
            Some("file") => {
                out.push(json!({ "type": "text", "text": file_block_to_text(block) }))
            }
            Some("quote") => {
                out.push(json!({ "type": "text", "text": quote_block_to_text(block) }))
            }
            Some("skill") => {
                out.push(json!({ "type": "text", "text": skill_block_to_text(block) }))
            }
            Some("image_url") => {
                let url = block
                    .get("image_url")
                    .and_then(|i| i.get("url"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(rest) = url.strip_prefix("data:") {
                    let data = rest.split(',').nth(1).unwrap_or(rest);
                    out.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": data,
                        }
                    }));
                } else {
                    out.push(json!({
                        "type": "image",
                        "source": { "type": "url", "url": url },
                    }));
                }
            }
            _ => {}
        }
    }
    out
}

pub(super) fn text_of_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        _ => serde_json::to_string(content).unwrap_or_default(),
    }
}

/// 本地图片伪视觉分析 — 处理消息 content（对齐 TS `visionInject.ts processVisionContent`）
///
/// 当 user 消息标记了 `imageVisionAnalyzeOptimize=true` 且带 `imageVisionAnalyzeResult` 时：
/// - 移除 image_url 块（不把原始 base64 图片发给纯文本 LLM）
/// - 追加 `\n\n{分析结果}` 文本块
///
/// 否则返回 None（content 原样发送）
pub(super) fn process_vision_content(msg: &Message) -> Option<Value> {
    let result = msg.image_vision_analyze_result.as_deref().unwrap_or("");
    if msg.role != "user"
        || msg.image_vision_analyze_optimize != Some(true)
        || result.is_empty()
    {
        return None;
    }

    // 确保 content 是数组格式
    let mut blocks: Vec<Value> = match &msg.content {
        Value::Array(arr) => arr.clone(),
        Value::String(s) if !s.is_empty() => vec![json!({ "type": "text", "text": s })],
        _ => Vec::new(),
    };

    // 过滤掉 image_url 块
    blocks.retain(|b| b.get("type").and_then(Value::as_str) != Some("image_url"));

    // 追加分析结果文本（已由前端按多图格式组装好）
    blocks.push(json!({ "type": "text", "text": format!("\n\n{}", result) }));

    Some(Value::Array(blocks))
}
