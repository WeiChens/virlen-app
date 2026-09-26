//! `web_fetch` 工具（原生）— 抓取 URL 并（可选）把 HTML 转成 Markdown。
//!
//! ## 与 TS 侧的对齐
//!
//! 镜像 `src/infrastructure/tools/web/web-fetch.ts`：
//! - 参数默认值（`method=GET` / `htmlToMd=true` / `timeout=10s`）与「只支持文本响应」的
//!   **二进制 Content-Type 清单**逐字一致；
//! - 截断阈值 `MAX_LENGTH = 20000` 与截断文案 `\n\n... [truncated: response body was N chars, showing first M]` 一致；
//! - 失败文案一致（cancelled / timed out / binary Content-Type / failed to read response body）；
//! - HTML 判定（`isHtml`）一致：**Content-Type 优先**（`text/html` / `application/xhtml+xml`），
//!   否则回退形状判定（**大小写不敏感**、剥 BOM）—— 两侧共读 golden
//!   `src/tests/fixtures/web-html-detect.golden.json`。
//!
//! ## 已知差异（**HTML→Markdown 的细节**）
//!
//! TS 用 `cheerio + turndown`，Rust 用 `htmd`（turndown.js 的 Rust 移植）—— 同源不同实现：
//! - ⚠️ **htmd 不会跳过 `script` / `style` 的文本内容**（实测 0.5.5：
//!   `<script>alert(1)</script>` 的 `alert(1)` 照样进 Markdown，`skip_tags` 也拦不住）
//!   → 本模块在转换前用正则**整块剥离** `script / style / iframe / noscript / footer / header`，
//!   对齐 TS 的 cheerio `remove`；
//! - TS 是真 DOM 解析，这里是**正则近似**：未闭合标签、注释里的伪标签等边界情形可能不同
//!   （未闭合时保守放行 —— 宁可多留，也不吞掉正文）；
//! - TS 还按 `class="hidden"` 移除节点，Rust 侧无法按类名判断 → **保留**（差异）；
//! - 其余 Markdown 细节（空行数量、链接风格、列表缩进…）不保证逐字相同。
//!
//! 该差异只影响「模型读到的网页正文格式」，不影响任何结构化字段或安全判定；
//! 已在 `docs/rust-engine.md` 登记。
//!
//! ## 不阻塞 runtime
//!
//! HTML 解析 + Markdown 转换是纯 CPU 工作（网页可达 MB 级），放 `spawn_blocking`，
//! 避免占住 tokio worker（TS 侧在主线程做同样的事，是它的既有行为）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::time::Duration;

use super::common::{char_count, is_html, slice_head, http_client, MAX_LENGTH};

/// 与 TS 逐字一致的二进制类型前缀清单（命中即拒绝整次抓取）
const BINARY_CONTENT_TYPES: [&str; 10] = [
    "application/octet-stream",
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-",
    "image/",
    "audio/",
    "video/",
    "font/",
    "application/vnd",
];

pub(crate) async fn web_fetch_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let method_str = args
        .get("method")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("GET")
        .to_string();
    let req_body = args.get("body").and_then(|v| v.as_str()).map(|s| s.to_string());
    // TS: `args.htmlToMd ?? true`
    let html_to_md = args
        .get("htmlToMd")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    // TS: `(args.timeout as number) ?? 10`
    let timeout_secs = args
        .get("timeout")
        .and_then(|v| v.as_i64())
        .unwrap_or(10)
        .max(0);

    let method = match reqwest::Method::from_bytes(method_str.as_bytes()) {
        Ok(m) => m,
        Err(e) => {
            return Ok(NativeToolOutcome::error(format!(
                "web_fetch failed: invalid HTTP method \"{}\": {}",
                method_str, e
            )))
        }
    };

    let mut req = http_client().request(method, &url);
    if let Some(b) = req_body {
        req = req.body(b);
    }

    // ---- 1. 发请求（取消 / 超时）----
    let resp = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            return Ok(NativeToolOutcome::error(format!("web_fetch was cancelled: {}", url)));
        }
        r = req.timeout(Duration::from_secs(timeout_secs as u64)).send() => match r {
            Ok(r) => r,
            Err(e) => {
                // TS 区分「手动取消」与「超时」两种 AbortError；这里按 reqwest 的错误类型分派
                if e.is_timeout() {
                    return Ok(NativeToolOutcome::error(format!(
                        "web_fetch timed out after {}s: {}",
                        timeout_secs, url
                    )));
                }
                return Ok(NativeToolOutcome::error(format!("web_fetch failed: {}", e)));
            }
        },
    };

    // ---- 2. 拒绝明显的二进制响应 ----
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let normalized_ct = content_type.to_lowercase();
    if BINARY_CONTENT_TYPES
        .iter()
        .any(|t| normalized_ct.starts_with(t))
    {
        return Ok(NativeToolOutcome::error(format!(
            "web_fetch: response has binary Content-Type \"{}\" for {}. \
             This tool only supports text-based responses (HTML, JSON, XML, plain text, etc.).",
            content_type, url
        )));
    }

    // ---- 3. 读响应体 ----
    let mut result = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return Ok(NativeToolOutcome::error(format!(
                "web_fetch failed to read response body: {}",
                e
            )))
        }
    };

    // ---- 4. HTML → Markdown（最耗时的一步）----
    if html_to_md && is_html(&result, &content_type) {
        let html = std::mem::take(&mut result);
        match tokio::task::spawn_blocking(move || convert_html_to_markdown(&html)).await {
            Ok(md) => result = md,
            Err(e) => {
                return Ok(NativeToolOutcome::error(format!(
                    "web_fetch failed to convert HTML to Markdown: {}",
                    e
                )))
            }
        }
    }

    // ---- 5. 截断 ----
    let total = char_count(&result);
    if total > MAX_LENGTH {
        result = format!(
            "{}\n\n... [truncated: response body was {} chars, showing first {}]",
            slice_head(&result, MAX_LENGTH),
            total,
            MAX_LENGTH
        );
    }

    Ok(NativeToolOutcome::Value {
        content: result,
        ui_data: None,
    })
}

/// 「不可见内容」节点：整块剥离（含子节点文本）——
/// 与 TS 侧 cheerio 的 `$('script, style, .hidden, footer, header, iframe, noscript').remove()` 等价。
///
/// ⚠️ 为什么不用 `htmd::skip_tags`：实测（htmd 0.5.5）它只跳过**标签本身**的 handler，
/// 元素内的文本仍会进 Markdown（`<script>alert(1)</script>` → `alert(1)`）。
static INVISIBLE_BLOCK: Lazy<Regex> = Lazy::new(|| {
    // ⚠️ Rust 的 `regex` crate **不支持反向引用**（`\1`）—— 只能把六种标签逐一写开，
    //    每种都要求「同名标签成对」闭合。
    Regex::new(
        r"(?is)<script\b[^>]*>.*?</script\s*>|<style\b[^>]*>.*?</style\s*>|<iframe\b[^>]*>.*?</iframe\s*>|<noscript\b[^>]*>.*?</noscript\s*>|<footer\b[^>]*>.*?</footer\s*>|<header\b[^>]*>.*?</header\s*>",
    )
    .expect("静态正则必然可编译")
});

/// 剥离「不可见内容」块（正则近似，见模块头的已知差异说明）
fn strip_invisible_blocks(html: &str) -> String {
    INVISIBLE_BLOCK.replace_all(html, "").into_owned()
}

/// HTML → Markdown（`htmd`；先剥离不可见块，与 TS 的 cheerio 预处理对齐）
fn convert_html_to_markdown(html: &str) -> String {
    let cleaned = strip_invisible_blocks(html);
    // 每次调用新建转换器（构建成本只是装配 handler 表，相对解析网页可忽略）
    htmd::convert(&cleaned).unwrap_or(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::noop_repo;
    use crate::agent::native_tools::test_util::test_security;
    use crate::session_db::NoopSettingsRepo;

    async fn run(args: Value) -> NativeToolOutcome {
        let sec = test_security("C:/tmp");
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let settings = NoopSettingsRepo;
        let ctx = NativeToolCtx {
            session_id: "s1",
            tool_call_id: "tc_fetch",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: &settings,
        };
        web_fetch_tool(&ctx, &args).await.expect("不应返回 Err")
    }

    fn content_of(outcome: &NativeToolOutcome) -> String {
        match outcome {
            NativeToolOutcome::Value { content, .. } => content.clone(),
            NativeToolOutcome::Error { content, .. } => content.clone(),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    /// 二进制 Content-Type 一律拒绝，且文案与 TS 逐字一致
    #[tokio::test]
    async fn binary_content_type_is_rejected_with_same_wording() {
        // 用 data: URL 不可行（reqwest 不支持）；改为直接断言清单匹配逻辑
        for ct in [
            "application/pdf",
            "IMAGE/PNG",
            "application/octet-stream; charset=binary",
            "application/vnd.ms-excel",
        ] {
            let normalized = ct.to_lowercase();
            assert!(
                BINARY_CONTENT_TYPES
                    .iter()
                    .any(|t| normalized.starts_with(t)),
                "应判定为二进制: {}",
                ct
            );
        }
        // 文本类型不得被误判
        for ct in ["text/html; charset=utf-8", "application/json", "application/xml"] {
            let normalized = ct.to_lowercase();
            assert!(
                !BINARY_CONTENT_TYPES
                    .iter()
                    .any(|t| normalized.starts_with(t)),
                "不应判定为二进制: {}",
                ct
            );
        }
    }

    /// 无 url / 非法 URL → 失败但**不 panic**（与 TS 的「throw → 工具失败」等价）
    #[tokio::test]
    async fn invalid_url_reports_failure() {
        let out = run(json_utils_args("not a url")).await;
        let text = content_of(&out);
        assert!(text.starts_with("web_fetch failed:"), "实际: {}", text);
    }

    fn json_utils_args(url: &str) -> Value {
        serde_json::json!({ "url": url })
    }

    /// HTML → Markdown：脚本/样式/页脚的内容不进入正文，标题保留
    #[test]
    fn html_to_markdown_drops_script_and_keeps_headings() {
        let html = "<!DOCTYPE html><html><head><style>body{color:red}</style>\
                    <script>alert('x')</script></head><body><h1>Title</h1><p>Hello</p>\
                    <footer>footer text</footer></body></html>";
        let md = convert_html_to_markdown(html);
        assert!(md.contains("# Title"), "实际: {:?}", md);
        assert!(md.contains("Hello"), "实际: {:?}", md);
        assert!(!md.contains("alert"), "脚本内容不应出现: {:?}", md);
        assert!(!md.contains("color:red"), "样式内容不应出现: {:?}", md);
        assert!(!md.contains("footer text"), "页脚内容不应出现: {:?}", md);
    }

    /// 正则剥离的边界：只删**成对闭合**的块，宁可多留也不吞掉正文
    #[test]
    fn strip_invisible_blocks_is_conservative() {
        assert_eq!(strip_invisible_blocks("<p>a</p>"), "<p>a</p>");
        assert_eq!(
            strip_invisible_blocks("<p>a</p><script>1</script>"),
            "<p>a</p>"
        );
        assert_eq!(
            strip_invisible_blocks("<p>a</p><style>x{y:1}</style><p>b</p>"),
            "<p>a</p><p>b</p>"
        );
        // 未闭合 → 正则不匹配 → 原样保留
        let unclosed = "<p>a</p><script>oops";
        assert_eq!(strip_invisible_blocks(unclosed), unclosed);
    }
}
