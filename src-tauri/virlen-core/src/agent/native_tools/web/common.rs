//! web — 网络分类公共函数（分类 id: web）
//!
//! 供 `web_fetch` / `web_search` 复用的纯函数与常量。
//!
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/web/common.ts` 逐字对齐（铁律 1）：
//! `formatSearchResults` 的输出会直接进模型上下文，两侧任何一字之差都会造成「默认引擎与回退
//! 引擎给模型的搜索结果格式不同」。收敛靠两侧共读的 golden：
//! `src/tests/fixtures/web-search-format.golden.json`（TS `tests/infrastructure/web-*.test.ts`
//! ↔ Rust 本文件的 `golden_matches_ts_implementation`）。
//!
//! 已知的字符计数口径差异：TS 的 `String.length` 是 UTF-16 码元数，Rust 的 `chars().count()`
//! 是 Unicode 标量数（emoji 在 TS 里算 2、在 Rust 里算 1）。只影响「截断阈值」附近的行为，
//! 不影响正常内容；截断本身两侧都按字符边界切，不会产生非法字节/孤立代理。

use serde_json::Value;

/// `web_fetch` 返回内容的最大字符数（与 TS `MAX_LENGTH` 一致）
pub(crate) const MAX_LENGTH: usize = 20_000;

/// 搜索结果单条（Rust 内部表示 —— 由各搜索源适配成统一形状）
#[derive(Debug, Clone, Default)]
pub(crate) struct SearchItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub icon: Option<String>,
    /// 全文内容（仅部分供应商返回）
    pub content: Option<String>,
    pub published_date: Option<String>,
    pub source: Option<String>,
    pub score: Option<f64>,
}

/// `is_html` 用的 ASCII 空白集合（**显式列出**，与 TS 侧同一集合）。
///
/// 不用 `char::is_whitespace`：Rust 的空白属性含 `U+0085`、JS 的 `\s` 含 `U+FEFF`，
/// 两侧 Unicode 空白定义并不等价，显式枚举才能保证逐字一致。
const ASCII_WHITESPACE: [char; 6] = [' ', '\t', '\n', '\r', '\x0B', '\x0C'];

/// 剥掉首尾 BOM（`U+FEFF`）。
///
/// JS 的 `trim()` 把 `U+FEFF` 当空白、Rust 的 `trim()` **不**当 —— 两侧都显式剥，避免分叉。
fn strip_bom(s: &str) -> &str {
    s.trim_matches('\u{FEFF}')
}

/// `lower` 是否以 `prefix` 开头，且其后是**标签边界**（结尾 / `>` / ASCII 空白）。
///
/// 用于避免 `<htmlfoo` 这类假前缀被误判成 HTML 根标签。
fn starts_with_tag_boundary(lower: &str, prefix: &str) -> bool {
    match lower.strip_prefix(prefix) {
        None => false,
        Some(rest) => match rest.chars().next() {
            None => true,
            Some(c) => c == '>' || ASCII_WHITESPACE.contains(&c),
        },
    }
}

/// 判断响应体是否应按 HTML 处理（即调用方的 `htmlToMd` 是否生效）。
///
/// 判定顺序（⚠️ 与 TS `isHtml` 逐字对齐，契约见
/// `src/tests/fixtures/web-html-detect.golden.json`，两侧共读）：
///
/// 1. Content-Type 优先：媒体类型为 `text/html` / `application/xhtml+xml` 时直接认定；
/// 2. 否则回退形状判定（大小写不敏感）：剥 BOM + `trim()` 后，要求以 `<!doctype html…` 或
///    `<html…` 开头（后接标签边界）且以 `</html>` 结尾。
///
/// 为什么要有 Content-Type 这一层：真实站点普遍返回小写 `<!doctype html>`，旧实现只认大写 →
/// 大量网页被判成「非 HTML」，`htmlToMd` 形同虚设。
pub(crate) fn is_html(content: &str, content_type: &str) -> bool {
    // ① Content-Type 优先：媒体类型大小写不敏感，参数（`; charset=…`）不参与判定
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if media_type == "text/html" || media_type == "application/xhtml+xml" {
        return true;
    }

    // ② 回退形状判定（大小写不敏感）
    let lower = strip_bom(content).trim().to_lowercase();
    if !lower.ends_with("</html>") {
        return false;
    }
    starts_with_tag_boundary(&lower, "<!doctype html")
        || starts_with_tag_boundary(&lower, "<html")
}

/// 取前 `max` 个字符（按字符边界切，等价于 TS `sliceHead` 的「不切开代理对」）
pub(crate) fn slice_head(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// 字符数（用于截断判定与截断文案）
pub(crate) fn char_count(text: &str) -> usize {
    text.chars().count()
}

/// 进程级复用的 HTTP 客户端（连接池复用；超时由各调用方按工具语义设定）。
pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
        reqwest::Client::builder()
            .build()
            .expect("构建 HTTP 客户端失败")
    });
    &CLIENT
}

/// 格式化搜索结果供 LLM 阅读 —— **逐字镜像 TS `formatSearchResults`**。
///
/// 形状（与 TS 完全一致，含缩进与空行）：
/// ```text
/// 🔍 Search results for "q" (via Provider) in 123ms:
///
/// [1] Title
///     URL: https://…
///     snippet
///     Published: …
///     Source: …
///     Relevance: 87%
///     Content: …
///
/// --- End of search results (N items) ---
/// ```
pub(crate) fn format_search_results(
    items: &[SearchItem],
    query: &str,
    provider_name: &str,
    elapsed_ms: Option<u64>,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    // JS: `${elapsedMs ? ` in ${elapsedMs}ms` : ''}` —— 0 / undefined 都不显示
    let elapsed_part = match elapsed_ms {
        Some(ms) if ms != 0 => format!(" in {}ms", ms),
        _ => String::new(),
    };
    lines.push(format!(
        "🔍 Search results for \"{}\" (via {}){}:",
        query, provider_name, elapsed_part
    ));
    lines.push(String::new());

    for (i, item) in items.iter().enumerate() {
        lines.push(format!("[{}] {}", i + 1, item.title));
        lines.push(format!("    URL: {}", item.url));
        lines.push(format!("    {}", item.snippet));

        // JS 的 `if (item.publishedDate)`：空串也是 falsy → 同样不显示
        if let Some(d) = item.published_date.as_deref() {
            if !d.is_empty() {
                lines.push(format!("    Published: {}", d));
            }
        }
        if let Some(s) = item.source.as_deref() {
            if !s.is_empty() {
                lines.push(format!("    Source: {}", s));
            }
        }
        // JS: `if (item.score !== undefined)` —— 0 也要显示（与 publishedDate 不同）
        if let Some(score) = item.score {
            // JS `(score * 100).toFixed(0)`：四舍五入到整数
            lines.push(format!("    Relevance: {}%", (score * 100.0).round() as i64));
        }

        if let Some(content) = item.content.as_deref() {
            if !content.is_empty() {
                const MAX_CONTENT_LEN: usize = 2000;
                let shown = if char_count(content) > MAX_CONTENT_LEN {
                    format!("{}... [truncated]", slice_head(content, MAX_CONTENT_LEN))
                } else {
                    content.to_string()
                };
                lines.push(format!("    Content: {}", shown));
            }
        }

        lines.push(String::new());
    }
    lines.push(format!(
        "--- End of search results ({} items) ---",
        items.len()
    ));
    lines.join("\n")
}

/// 搜索结果 → `uiData.items`（与 TS 侧同形：`title / url / snippet / icon`）
pub(crate) fn items_to_ui(items: &[SearchItem]) -> Vec<Value> {
    items
        .iter()
        .map(|it| {
            serde_json::json!({
                "title": it.title,
                "url": it.url,
                "snippet": it.snippet,
                "icon": it.icon,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_html_content_type_takes_priority() {
        // Content-Type 命中 → 不看正文形状
        assert!(is_html("{\"ok\":true}", "text/html; charset=utf-8"));
        assert!(is_html("", "text/html"));
        assert!(is_html("<p>x</p>", "Application/XHTML+XML"));
        assert!(is_html("{a:1}", "  text/html  ; charset=utf-8"));
        // 未命中 → 回退形状判定
        assert!(is_html("<!doctype html><html></html>", "text/plain"));
        assert!(!is_html("{\"ok\":true}", "application/json"));
    }

    /// golden 契约：`isHtml` 判定必须与 TS 侧**完全一致**（fixture 两侧共读）
    #[test]
    fn golden_html_detect_matches_ts() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src/tests/fixtures/web-html-detect.golden.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取 golden 失败 {}: {}", path.display(), e));
        let cases: Vec<Value> = serde_json::from_str(&raw).expect("golden 不是合法 JSON");
        assert!(!cases.is_empty(), "golden 不应为空");

        for case in &cases {
            let name = case["name"].as_str().unwrap_or("(unnamed)");
            let content = case["content"].as_str().unwrap_or("");
            // fixture 里 `contentType: null` 表示「响应头未提供」
            let content_type = case["contentType"].as_str().unwrap_or("");
            let expected = case["expected"].as_bool().unwrap_or(false);
            assert_eq!(
                is_html(content, content_type),
                expected,
                "golden 用例不一致: {}",
                name
            );
        }
    }

    #[test]
    fn slice_head_does_not_split_chars() {
        assert_eq!(slice_head("中文abc", 2), "中文");
        assert_eq!(slice_head("abc", 10), "abc");
        assert_eq!(char_count("中文abc"), 5);
    }

    /// golden 契约：同一批输入必须与 TS 侧产出**逐字相同**
    /// （fixture 由两侧共读，见模块头注释）
    #[test]
    fn golden_matches_ts_implementation() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src/tests/fixtures/web-search-format.golden.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取 golden 失败 {}: {}", path.display(), e));
        let cases: Vec<Value> = serde_json::from_str(&raw).expect("golden 不是合法 JSON");

        for case in &cases {
            let name = case["name"].as_str().unwrap_or("(unnamed)");
            let query = case["query"].as_str().unwrap_or("");
            let provider = case["providerName"].as_str().unwrap_or("");
            let elapsed = case["elapsedMs"].as_u64();

            let items: Vec<SearchItem> = case["items"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|it| SearchItem {
                            title: it["title"].as_str().unwrap_or("").to_string(),
                            url: it["url"].as_str().unwrap_or("").to_string(),
                            snippet: it["snippet"].as_str().unwrap_or("").to_string(),
                            icon: it["icon"].as_str().map(|s| s.to_string()),
                            content: it["content"].as_str().map(|s| s.to_string()),
                            published_date: it["publishedDate"].as_str().map(|s| s.to_string()),
                            source: it["source"].as_str().map(|s| s.to_string()),
                            score: it["score"].as_f64(),
                        })
                        .collect()
                })
                .unwrap_or_default();

            let expected = case["expected"].as_str().unwrap_or("");
            let actual = format_search_results(&items, query, provider, elapsed);
            assert_eq!(actual, expected, "golden 用例不一致: {}", name);
        }
    }
}
