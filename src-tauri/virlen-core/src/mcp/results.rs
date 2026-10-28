//! `tools/call` 结果投影 —— MCP 的 content block → 「模型看得懂的文本」+「界面画得出的块」。
//!
//! 为什么单独一个文件：投影规则是**跨语言契约**（前端 `McpToolMessage` 按 `ui_data.blocks[]` 渲染，
//! 与 `execute_command` 的 `uiData` 同一分工 —— 模型侧英文、界面按语言重建），
//! 且每条规则都对应一个真实服务器行为（filesystem 回 text、playwright 回 image、
//! 带 outputSchema 的回 structuredContent）。
//!
//! ⚠️ 三条纪律：
//! 1. **绝不让结果无限长**：总长 60 KB 截断（参数侧 256 KB 在调用前挡，见 `connection`）。
//! 2. `isError:true` 原样上报为失败（红色卡片），绝不渲染成绿色成功。
//! 3. 二进制块**不进模型上下文**：只给一行诊断文本 + 界面块（模型对着 base64 既浪费又无用）。

use serde_json::{json, Map, Value};

use super::client::CallToolResult;
use super::host::McpCallOutcome;

/// 单次结果正文上限（字符数；与方案 §4.4 一致）
pub const MAX_RESULT_CHARS: usize = 60 * 1024;

/// `structuredContent` 追加进模型正文的上限（结构化结果通常很短，超了只给诊断）
const MAX_STRUCTURED_CHARS: usize = 8 * 1024;

/// 把一次 `tools/call` 的原始结果投影成「模型 + 界面」双份。
///
/// `server` / `raw_name` 只用于 `ui_data` 与失败文案（这里已经知道它们，不必再解公开名）。
pub fn project(server: &str, public_name: &str, raw_name: &str, result: CallToolResult) -> McpCallOutcome {
    let mut parts: Vec<String> = Vec::new();
    let mut blocks: Vec<Value> = Vec::new();
    let mut plain_text: Vec<String> = Vec::new();

    for block in &result.content {
        match block.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" => {
                let text = block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if text.is_empty() {
                    continue;
                }
                plain_text.push(text.clone());
                blocks.push(json!({ "type": "text", "text": text }));
            }
            "image" => {
                let media_type = block
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png");
                let bytes = base64_len(block.get("data").and_then(Value::as_str));
                parts.push(format!("[image: {media_type} {} KB]", kb(bytes)));
                // ⚠️ 图片本体的「落附件 → vision_image 注入队列」在 P2 做（需要会话附件库）；
                // 这里先给界面块，卡片能显示「有图 / 多大」，模型拿到的是一行诊断。
                blocks.push(json!({
                    "type": "image",
                    "mediaType": media_type,
                    "bytes": bytes,
                }));
            }
            "audio" => {
                let media_type = block
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("audio/*");
                let bytes = base64_len(block.get("data").and_then(Value::as_str));
                parts.push(format!(
                    "[audio unavailable: {media_type}, {} bytes]",
                    bytes
                ));
                blocks.push(json!({
                    "type": "unsupported",
                    "mediaType": media_type,
                    "bytes": bytes,
                }));
            }
            "resource_link" => {
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("(unnamed)");
                let uri = block.get("uri").and_then(Value::as_str).unwrap_or("");
                let mime = block
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                parts.push(format!("[resource_link: {name} {uri} ({mime})]"));
                blocks.push(json!({
                    "type": "resource_link",
                    "name": name,
                    "uri": uri,
                    "mimeType": mime,
                }));
            }
            "resource" => {
                let resource = block.get("resource").cloned().unwrap_or(Value::Null);
                let uri = resource.get("uri").and_then(Value::as_str).unwrap_or("");
                let mime = resource
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                match resource.get("text").and_then(Value::as_str) {
                    Some(text) => {
                        plain_text.push(text.to_string());
                        blocks.push(json!({
                            "type": "resource",
                            "uri": uri,
                            "mimeType": mime,
                            "text": text,
                        }));
                    }
                    None => {
                        let bytes = base64_len(resource.get("blob").and_then(Value::as_str));
                        parts.push(format!(
                            "[resource: {uri} ({mime}, binary {} bytes — not shown)]",
                            bytes
                        ));
                        blocks.push(json!({
                            "type": "resource",
                            "uri": uri,
                            "mimeType": mime,
                            "bytes": bytes,
                        }));
                    }
                }
            }
            other => {
                // 未知块类型：如实说不知道，比整条结果失败好（服务器可能用了新版本的类型）
                parts.push(format!("[unsupported content block: {other}]"));
                blocks.push(json!({ "type": "unsupported", "blockType": other }));
            }
        }
    }

    // 文本块按协议顺序拼接（块间一个换行），二进制/链接诊断排在后面 ——
    // 保留原始顺序会让人读不懂（诊断行夹在正文中间），而正文的先后才是模型要的顺序
    let mut text_parts = plain_text;
    text_parts.extend(parts);

    if let Some(structured) = &result.structured {
        let rendered = serde_json::to_string_pretty(structured).unwrap_or_default();
        let rendered = truncate_chars(&rendered, MAX_STRUCTURED_CHARS);
        text_parts.push(format!("[structured]\n{rendered}"));
        blocks.push(json!({ "type": "json", "value": structured }));
    }

    let joined = if text_parts.is_empty() {
        "(no content)".to_string()
    } else {
        text_parts.join("\n")
    };
    let (content, truncated) = truncate_result(&joined);

    let mut ui = Map::new();
    ui.insert("type".into(), json!("mcp_tool"));
    ui.insert("server".into(), json!(server));
    ui.insert("rawName".into(), json!(raw_name));
    // 卡片标题直接用它，不必在前端反解（名字可能被哈希归一化过）
    ui.insert("name".into(), json!(public_name));
    ui.insert("blocks".into(), Value::Array(blocks));
    if let Some(structured) = &result.structured {
        ui.insert("structured".into(), structured.clone());
    }
    if truncated {
        ui.insert("truncated".into(), json!(true));
    }
    let ui_data = Value::Object(ui);

    if result.is_error {
        McpCallOutcome {
            content,
            ui_data: Some(ui_data),
            is_error: true,
        }
    } else {
        McpCallOutcome::value(content, Some(ui_data))
    }
}

/// base64 的解码后字节数（不真的解码 —— 结果里可能是几十 MB 的图片）
pub(crate) fn base64_len(data: Option<&str>) -> usize {
    let Some(data) = data else {
        return 0;
    };
    let trimmed = data.trim_end_matches('=');
    trimmed.len() * 3 / 4
}

fn kb(bytes: usize) -> usize {
    bytes.div_ceil(1024).max(1)
}

/// 按字符截断（不切坏 UTF-8）
pub(crate) fn truncate_chars(input: &str, max: usize) -> String {
    let total = input.chars().count();
    if total <= max {
        return input.to_string();
    }
    let head: String = input.chars().take(max).collect();
    format!("{head}\n…[truncated, {} chars omitted]", total - max)
}

/// 结果总长上限（超了截断 + 标记；返回是否真的截断过）
pub(crate) fn truncate_result(input: &str) -> (String, bool) {
    let total = input.chars().count();
    if total <= MAX_RESULT_CHARS {
        return (input.to_string(), false);
    }
    let head: String = input.chars().take(MAX_RESULT_CHARS).collect();
    let omitted = total - MAX_RESULT_CHARS;
    (format!("{head}\n… [truncated, {omitted} chars omitted]"), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(content: Vec<Value>, structured: Option<Value>, is_error: bool) -> CallToolResult {
        CallToolResult {
            content,
            structured,
            is_error,
        }
    }

    #[test]
    fn text_blocks_keep_protocol_order() {
        let outcome = project(
            "fs",
            "mcp__fs__read",
            "read",
            result(
                vec![
                    json!({ "type": "text", "text": "line 1" }),
                    json!({ "type": "text", "text": "line 2" }),
                ],
                None,
                false,
            ),
        );
        assert_eq!(outcome.content, "line 1\nline 2");
        assert!(!outcome.is_error);
        let blocks = &outcome.ui_data.unwrap()["blocks"];
        assert_eq!(blocks.as_array().unwrap().len(), 2);
    }

    #[test]
    fn empty_content_says_so() {
        let outcome = project("fs", "mcp__fs__noop", "noop", result(vec![], None, false));
        assert_eq!(outcome.content, "(no content)");
    }

    /// 图片不进模型上下文（只给一行诊断），界面拿到结构化块
    #[test]
    fn images_become_diagnostics_not_base64() {
        // 4 个 base64 字符 ≈ 3 字节
        let outcome = project(
            "px",
            "mcp__px__shot",
            "shot",
            result(
                vec![json!({ "type": "image", "mimeType": "image/png", "data": "AAAA" })],
                None,
                false,
            ),
        );
        assert!(outcome.content.starts_with("[image: image/png"), "{}", outcome.content);
        assert!(!outcome.content.contains("AAAA"), "绝不能把 base64 灌进上下文");
        let block = &outcome.ui_data.unwrap()["blocks"][0];
        assert_eq!(block["type"], "image");
        assert_eq!(block["mediaType"], "image/png");
        assert_eq!(block["bytes"], 3);
    }

    #[test]
    fn audio_and_unknown_blocks_are_reported_as_unavailable() {
        let outcome = project(
            "av",
            "mcp__av__listen",
            "listen",
            result(
                vec![
                    json!({ "type": "audio", "mimeType": "audio/wav", "data": "AAAA" }),
                    json!({ "type": "hologram" }),
                ],
                None,
                false,
            ),
        );
        assert!(outcome.content.contains("[audio unavailable: audio/wav"), "{}", outcome.content);
        assert!(outcome.content.contains("unsupported content block: hologram"));
    }

    #[test]
    fn resource_link_and_embedded_resources() {
        let outcome = project(
            "fs",
            "mcp__fs__res",
            "res",
            result(
                vec![
                    json!({
                        "type": "resource_link",
                        "name": "notes",
                        "uri": "file:///a/notes.md",
                        "mimeType": "text/markdown"
                    }),
                    json!({
                        "type": "resource",
                        "resource": { "uri": "file:///a/b.bin", "mimeType": "application/octet-stream", "blob": "AAAA" }
                    }),
                ],
                None,
                false,
            ),
        );
        assert!(
            outcome.content.contains("[resource_link: notes file:///a/notes.md (text/markdown)]"),
            "{}",
            outcome.content
        );
        assert!(outcome.content.contains("binary 3 bytes — not shown"));
    }

    #[test]
    fn structured_content_is_appended_and_kept_for_ui() {
        let outcome = project(
            "api",
            "mcp__api__q",
            "q",
            result(
                vec![json!({ "type": "text", "text": "ok" })],
                Some(json!({ "count": 2 })),
                false,
            ),
        );
        assert!(outcome.content.starts_with("ok\n[structured]"), "{}", outcome.content);
        let ui = outcome.ui_data.unwrap();
        assert_eq!(ui["structured"]["count"], 2);
        assert_eq!(ui["blocks"].as_array().unwrap().last().unwrap()["type"], "json");
    }

    /// `isError:true` 必须走失败通道（红色卡片），同时仍带结构化 uiData
    #[test]
    fn is_error_maps_to_error_outcome() {
        let outcome = project(
            "fs",
            "mcp__fs__read",
            "read",
            result(
                vec![json!({ "type": "text", "text": "ENOENT: no such file" })],
                None,
                true,
            ),
        );
        assert!(outcome.is_error);
        assert_eq!(outcome.content, "ENOENT: no such file");
        assert!(outcome.ui_data.is_some(), "失败也要有 uiData（界面按语言重建）");
    }

    #[test]
    fn oversized_result_is_truncated_with_a_marker() {
        let huge = "x".repeat(MAX_RESULT_CHARS + 100);
        let outcome = project(
            "fs",
            "mcp__fs__read",
            "read",
            result(vec![json!({ "type": "text", "text": huge })], None, false),
        );
        assert!(outcome.content.chars().count() <= MAX_RESULT_CHARS + 80);
        assert!(outcome.content.contains("chars omitted"));
        assert_eq!(outcome.ui_data.unwrap()["truncated"], true);
    }

    /// 多字节字符只在字符边界截断（不能切出半个 UTF-8）
    #[test]
    fn truncation_respects_char_boundaries() {
        let huge = "汉".repeat(MAX_RESULT_CHARS + 5);
        let outcome = project(
            "fs",
            "mcp__fs__read",
            "read",
            result(vec![json!({ "type": "text", "text": huge })], None, false),
        );
        assert!(outcome.content.is_char_boundary(outcome.content.len()));
        assert!(outcome.content.starts_with('汉'));
    }
}
