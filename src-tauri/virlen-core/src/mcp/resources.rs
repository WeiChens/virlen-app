//! MCP 资源（`resources/list` / `resources/read`）—— 结果投影（模型文本 + 界面块）。
//!
//! 为什么资源要单独一套投影：`tools/call` 的结果是「这一次调用的返回值」，而资源是
//! **服务器长期声明的可读数据**（文件、数据库行、文档）。模型必须先拿到 `uri` 才能读正文，
//! 所以列表的排版第一要素是 uri，其次才是名字 / mime / 大小。
//!
//! ⚠️ 三条纪律（与 `results.rs` 同口径）：
//! 1. 资源正文同样是**不可信外部文本**（服务器完全可控），一律当纯文本，绝不解释成标记；
//! 2. 二进制（`blob`）**绝不进模型上下文**：只给一行诊断 + 界面块，base64 连界面都不下发；
//! 3. 总长 60 KB 截断（复用 `results::truncate_result`，全项目只有一条截断策略）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::client::{McpResource, ReadResourceResult};
use super::results::{base64_len, truncate_chars, truncate_result, MAX_RESULT_CHARS};

/// 一台服务器的资源清单（失败也带着服务器名 —— 模型必须知道是哪台出的问题）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceListing {
    /// 服务器命名空间（= 配置里的 `name`，也是公开工具名中间那一段）
    pub server: String,
    /// 查询那一刻的运行态（`ready` / `connecting` / `failed` …，与 `McpServerState` 同词表）
    pub state: String,
    pub resources: Vec<McpResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpResourceListing {
    /// 查不了时的结论（连接断了 / 没声明 resources 能力 / 协议报错）
    pub fn failed(server: &str, state: &str, error: impl Into<String>) -> Self {
        Self {
            server: server.to_string(),
            state: state.to_string(),
            resources: Vec::new(),
            error: Some(error.into()),
        }
    }
}

/// `resources/read` 的投影结果。
///
/// 二进制只留字节数：真把 base64 放进上下文既浪费 token 又没用（模型看不到图），
/// 而界面侧也没必要持有一份几十 MB 的字符串。
#[derive(Debug, Clone, PartialEq)]
pub struct McpResourceRead {
    /// 请求的 uri（回显给界面 / 失败文案）
    pub uri: String,
    /// 第一段内容的 mime（多段时够用了：卡片只显示一个）
    pub mime_type: Option<String>,
    /// 所有文本段按协议顺序拼接；纯二进制资源为 `None`
    pub text: Option<String>,
    /// 二进制段的总字节数（base64 解码后的估算）
    pub blob_bytes: usize,
    /// 协议返回了几段内容（一个 uri 可能对应多段）
    pub content_count: usize,
}

impl McpResourceRead {
    /// 原始结果 → 投影（文本拼接 + 二进制只计数）
    pub fn from_client(uri: &str, result: ReadResourceResult) -> Self {
        let mut texts: Vec<String> = Vec::new();
        let mut blob_bytes = 0usize;
        let mut mime_type: Option<String> = None;
        for content in &result.contents {
            if let Some(text) = &content.text {
                if !text.is_empty() {
                    texts.push(text.clone());
                }
            }
            if let Some(blob) = &content.blob {
                blob_bytes += base64_len(Some(blob));
            }
            if mime_type.is_none() {
                mime_type = content.mime_type.clone();
            }
        }
        Self {
            uri: result
                .contents
                .first()
                .map(|content| content.uri.clone())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| uri.to_string()),
            mime_type,
            text: (!texts.is_empty()).then(|| texts.join("\n")),
            blob_bytes,
            content_count: result.contents.len(),
        }
    }
}

/// 列表 → (给模型的文本, 给界面的 `uiData`)。
pub fn project_listing(listings: &[McpResourceListing]) -> (String, Value) {
    let rendered = render_listing(listings);
    let (content, truncated) = truncate_result(&rendered);
    let mut ui = json!({ "type": "mcp_resources", "servers": listings });
    if truncated {
        ui["truncated"] = json!(true);
    }
    (content, ui)
}

/// 读取结果 → (给模型的文本, 给界面的 `uiData`)。
pub fn project_read(server: &str, read: &McpResourceRead) -> (String, Value) {
    let rendered = render_read(read);
    let (content, truncated) = truncate_result(&rendered);
    let mut ui = json!({
        "type": "mcp_resource",
        "server": server,
        "uri": read.uri,
        "bytes": read.blob_bytes,
        "contents": read.content_count,
    });
    if let Some(mime) = &read.mime_type {
        ui["mimeType"] = json!(mime);
    }
    if let Some(text) = &read.text {
        // 界面与模型用同一条截断策略（否则大资源会把 IPC 与 DOM 一起拖死）
        ui["text"] = json!(truncate_chars(text, MAX_RESULT_CHARS));
    }
    if truncated {
        ui["truncated"] = json!(true);
    }
    (content, ui)
}

/// 列表排版：服务器 → 资源逐条（uri 第一要素，描述缩进一行）。
fn render_listing(listings: &[McpResourceListing]) -> String {
    if listings.is_empty() {
        return "No connected MCP server exposes resources.".to_string();
    }
    let total: usize = listings.iter().map(|item| item.resources.len()).sum();
    let mut lines: Vec<String> = vec![format!(
        "MCP resources ({} server(s), {total} resource(s))",
        listings.len()
    )];
    for listing in listings {
        if let Some(error) = &listing.error {
            lines.push(format!(
                "\nserver \"{}\" ({}): {error}",
                listing.server, listing.state
            ));
            continue;
        }
        lines.push(format!(
            "\nserver \"{}\" — {} resource(s)",
            listing.server,
            listing.resources.len()
        ));
        if listing.resources.is_empty() {
            lines.push("  (none)".to_string());
            continue;
        }
        for resource in &listing.resources {
            let mut line = format!("- {}", resource.uri);
            if !resource.name.is_empty() {
                line.push_str(" | ");
                line.push_str(&resource.name);
            }
            if let Some(title) = &resource.title {
                line.push_str(" | ");
                line.push_str(title);
            }
            if let Some(mime) = &resource.mime_type {
                line.push_str(" | ");
                line.push_str(mime);
            }
            if let Some(size) = resource.size {
                line.push_str(&format!(" | {size} B"));
            }
            lines.push(line);
            if let Some(description) = &resource.description {
                // 描述压成一行：多行描述会把「一个资源一行」的清单排版打散
                lines.push(format!("  {}", description.replace('\n', " ")));
            }
        }
    }
    lines.join("\n")
}

/// 读取排版：文本原样；二进制只给诊断行（与 `results.rs` 的 embedded resource 同文案）。
fn render_read(read: &McpResourceRead) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(text) = &read.text {
        if !text.is_empty() {
            parts.push(text.clone());
        }
    }
    if read.blob_bytes > 0 {
        parts.push(format!(
            "[resource: {} ({}, binary {} bytes — not shown)]",
            read.uri,
            read.mime_type.as_deref().unwrap_or("unknown"),
            read.blob_bytes
        ));
    }
    if parts.is_empty() {
        return "(no content)".to_string();
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::client::ResourceContent;

    fn resource(uri: &str, name: &str) -> McpResource {
        McpResource {
            uri: uri.to_string(),
            name: name.to_string(),
            title: None,
            description: None,
            mime_type: Some("text/markdown".to_string()),
            size: Some(12),
        }
    }

    #[test]
    fn listing_renders_uri_first_and_keeps_errors() {
        let listings = vec![
            McpResourceListing {
                server: "fs".into(),
                state: "ready".into(),
                resources: vec![resource("file:///a.md", "a")],
                error: None,
            },
            McpResourceListing::failed("db", "connecting", "MCP server \"db\" is not connected"),
        ];
        let (content, ui) = project_listing(&listings);
        assert!(content.contains("file:///a.md | a | text/markdown | 12 B"), "{content}");
        assert!(content.contains("server \"fs\" — 1 resource(s)"), "{content}");
        assert!(content.contains("server \"db\" (connecting): MCP server"), "{content}");
        assert_eq!(ui["type"], "mcp_resources");
        assert_eq!(ui["servers"].as_array().unwrap().len(), 2);
        assert_eq!(ui["servers"][0]["resources"][0]["mimeType"], "text/markdown");
    }

    /// 一台都没有时给一句明确结论（模型不该以为「工具成功了但结果为空」）
    #[test]
    fn empty_listing_says_so() {
        let (content, ui) = project_listing(&[]);
        assert_eq!(content, "No connected MCP server exposes resources.");
        assert_eq!(ui["servers"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn read_projects_text_and_ui_shape() {
        let read = McpResourceRead::from_client(
            "file:///a.md",
            ReadResourceResult {
                contents: vec![ResourceContent {
                    uri: "file:///a.md".into(),
                    mime_type: Some("text/markdown".into()),
                    text: Some("# hi".into()),
                    blob: None,
                }],
            },
        );
        let (content, ui) = project_read("fs", &read);
        assert_eq!(content, "# hi");
        assert_eq!(ui["type"], "mcp_resource");
        assert_eq!(ui["server"], "fs");
        assert_eq!(ui["uri"], "file:///a.md");
        assert_eq!(ui["mimeType"], "text/markdown");
        assert_eq!(ui["bytes"], 0);
        assert_eq!(ui["contents"], 1);
        assert_eq!(ui["text"], "# hi");
    }

    /// 二进制只报字节数（4 个 base64 字符 ≈ 3 字节），绝不把 base64 灌进上下文或界面
    #[test]
    fn binary_resource_is_a_diagnostic_only() {
        let read = McpResourceRead::from_client(
            "file:///b.bin",
            ReadResourceResult {
                contents: vec![ResourceContent {
                    uri: "file:///b.bin".into(),
                    mime_type: Some("application/octet-stream".into()),
                    text: None,
                    blob: Some("AAAA".into()),
                }],
            },
        );
        let (content, ui) = project_read("fs", &read);
        assert!(content.contains("binary 3 bytes — not shown"), "{content}");
        assert!(!content.contains("AAAA"));
        assert_eq!(ui["bytes"], 3);
        assert!(ui.get("text").is_none(), "二进制不该有正文块");
    }

    /// 大资源在模型侧与界面侧都按同一条策略截断
    #[test]
    fn oversized_text_is_truncated_everywhere() {
        let huge = "x".repeat(MAX_RESULT_CHARS + 100);
        let read = McpResourceRead::from_client(
            "file:///big.txt",
            ReadResourceResult {
                contents: vec![ResourceContent {
                    uri: "file:///big.txt".into(),
                    mime_type: None,
                    text: Some(huge),
                    blob: None,
                }],
            },
        );
        let (content, ui) = project_read("fs", &read);
        assert!(content.chars().count() <= MAX_RESULT_CHARS + 80);
        assert!(content.contains("chars omitted"));
        assert_eq!(ui["truncated"], true);
        assert!(ui["text"].as_str().unwrap().chars().count() <= MAX_RESULT_CHARS + 60);
    }

    /// 多段内容按协议顺序拼接；uri 缺失时回退到请求的 uri
    #[test]
    fn multiple_contents_are_joined() {
        let read = McpResourceRead::from_client(
            "db://q",
            ReadResourceResult {
                contents: vec![
                    ResourceContent {
                        uri: String::new(),
                        mime_type: None,
                        text: Some("row 1".into()),
                        blob: None,
                    },
                    ResourceContent {
                        uri: "db://q".into(),
                        mime_type: Some("text/plain".into()),
                        text: Some("row 2".into()),
                        blob: None,
                    },
                ],
            },
        );
        assert_eq!(read.uri, "db://q");
        assert_eq!(read.content_count, 2);
        let (content, _) = project_read("db", &read);
        assert_eq!(content, "row 1\nrow 2");
    }
}
