//! `web_search` 工具（原生）— 通过已配置的搜索源检索互联网。
//!
//! ## 配置来源（与 S7 同一套：读的就是 CLI 会读的那份）
//!
//! 搜索源配置（`searchProviders` / `defaultSearchProviderId`）随 `SettingsStore` 一起下沉到了
//! `app_settings` 表，因此这里经 `ctx.settings` 直读同一份配置 —— GUI（Rust 引擎）与 CLI 行为
//! 天然一致，也不需要前端下发任何字段。（对比：`sandbox_ignore_rules` 走的是「随消息下发」，
//! 因为沙盒判定要求每条命令零 IO；这里一次调用一次网络请求，读一次表的开销可忽略。）
//!
//! ## 与 TS 侧的对齐
//!
//! 逐字镜像 `src/infrastructure/tools/web/web-search.ts` +
//! `src/infrastructure/search-providers/{tavily,bocha}.ts`：
//! - 参数校验 / 「未配置搜索源」/ 「无结果」三类文案逐字一致；
//! - 结果文本由 `super::common::format_search_results` 生成（两侧共读 golden 收敛）；
//! - `uiData` 形状一致（`length / items[{title,url,snippet,icon}] / provider / query / timestamp`）；
//! - 请求体与响应字段映射一致（`days` 仅 `time_range=day` 时出现 —— 对齐 JS `undefined` 被丢弃）；
//! - 失败文案一致（`Tavily API error (status): body` / `博查 API error ...`）。
//!
//! ⚠️ 与 TS 侧一样只支持 `tavily` / `bocha`：`searxng` 在 TS 的 `factory.ts` 里被注释掉
//! （未接入运行时），因此「配了 searxng 但没配可用源」在两侧都表现为「未配置搜索源」。

use crate::agent::cancellation::CancellationToken;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};
use std::time::Instant;

use super::common::{
    format_search_results, http_client, items_to_ui, slice_head, SearchItem,
};

/// 默认返回条数（对齐 TS `args.max_results ?? 10`）
const DEFAULT_MAX_RESULTS: i64 = 10;
/// 条数上限（对齐 TS `Math.min(..., 50)`）
const MAX_MAX_RESULTS: i64 = 50;
/// 搜索请求超时（TS 侧由 `plugin-http` 默认；给足时间避免慢检索被误判失败）
const SEARCH_TIMEOUT_SECS: u64 = 30;

/// 「未配置搜索源」文案 —— 与 TS 逐字一致
const NO_PROVIDER_MSG: &str =
    "No search provider is configured. Please configure a search provider in settings (e.g., Tavily, Bing, or a self-hosted SearXNG instance).";
/// 「缺少 query」文案 —— 与 TS 逐字一致
const MISSING_QUERY_MSG: &str =
    "Missing required parameter: \"query\". Please provide a search query.";

/// 搜索源配置快照（从 `app_settings` 读出的一份可执行配置）
struct SearchProviderCfg {
    provider_type: String,
    /// 展示名（进结果头部，如 `Tavily` / `博查`）
    name: String,
    base_url: String,
    api_key: String,
}

pub(crate) async fn web_search_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    // 1. 参数校验（TS：`!query || typeof query !== 'string' || query.trim() === ''`）
    let query = match args.get("query") {
        Some(Value::String(s)) => s.clone(),
        // 非字符串（数字/对象…）在 TS 里同样命中「缺少参数」分支
        _ => String::new(),
    };
    if query.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: MISSING_QUERY_MSG.to_string(),
            ui_data: None,
        });
    }

    // 2. 取默认搜索源
    let cfg = match load_search_provider(ctx).await? {
        Some(cfg) => cfg,
        None => {
            return Ok(NativeToolOutcome::Value {
                content: NO_PROVIDER_MSG.to_string(),
                ui_data: None,
            })
        }
    };

    // 3. 参数（TS：`Math.min(args.max_results ?? 10, 50)`）
    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .min(MAX_MAX_RESULTS);
    let time_range = args
        .get("time_range")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // 4. 执行搜索（不支持的 type → 与 TS 一致地表现为「未配置」）
    let started = Instant::now();
    let items = match cfg.provider_type.as_str() {
        "tavily" => search_tavily(&cfg, &query, max_results, time_range.as_deref(), ctx.cancel)
            .await?,
        "bocha" => search_bocha(&cfg, &query, max_results, time_range.as_deref(), ctx.cancel)
            .await?,
        _ => {
            return Ok(NativeToolOutcome::Value {
                content: NO_PROVIDER_MSG.to_string(),
                ui_data: None,
            })
        }
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;

    // 5. 无结果（TS 用的是原始 query —— 这里同样不做 trim）
    if items.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: format!("No search results found for \"{}\".", query),
            ui_data: Some(json!({ "length": 0, "items": [] })),
        });
    }

    // 6. 格式化（与 TS 同一个函数形状 → 同一份 golden 契约）
    let content = format_search_results(&items, &query, &cfg.name, Some(elapsed_ms));
    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(json!({
            "length": items.len(),
            "items": items_to_ui(&items),
            "provider": cfg.name,
            "query": query,
            // 对齐 TS `new Date().toISOString()`（UTC + 毫秒 + `Z`）
            "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        })),
    })
}

/// 读出默认搜索源配置（`app_settings` → `defaultSearchProviderId` + `searchProviders`）。
///
/// 与 TS 初始化逻辑对齐（`searchProviderService.initSearchProviders`）：只认 `enabled: true`
/// 的项 —— 未启用等于「没注册」，运行时 `getDefault()` 取不到 → 表现为未配置。
async fn load_search_provider(ctx: &NativeToolCtx<'_>) -> Result<Option<SearchProviderCfg>, String> {
    let all = ctx
        .settings
        .get_all()
        .await
        .map_err(|e| format!("Failed to read search provider settings: {}", e))?;

    let default_id = match all.get("defaultSearchProviderId").and_then(|v| v.as_str()) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => return Ok(None),
    };
    let list = all
        .get("searchProviders")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for cfg in list {
        if cfg.get("id").and_then(|v| v.as_str()) != Some(default_id.as_str()) {
            continue;
        }
        // `enabled` 缺省视为 false（与 TS 的 `if (!config.enabled) continue` 一致）
        if cfg.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
            return Ok(None);
        }
        let provider_type = cfg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let name = cfg.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let api_key = cfg.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
        // 缺 baseUrl 时用各家的默认端点（与 TS provider 构造函数一致）
        let base_url = match cfg.get("baseUrl").and_then(|v| v.as_str()) {
            Some(b) if !b.is_empty() => b.trim_end_matches('/').to_string(),
            _ => match provider_type {
                "tavily" => "https://api.tavily.com".to_string(),
                "bocha" => "https://api.bocha.cn/v1".to_string(),
                _ => String::new(),
            },
        };
        return Ok(Some(SearchProviderCfg {
            provider_type: provider_type.to_string(),
            name: name.to_string(),
            base_url,
            api_key: api_key.to_string(),
        }));
    }
    Ok(None)
}

/// Tavily：`POST {base}/search`（镜像 `search-providers/tavily.ts`）
async fn search_tavily(
    cfg: &SearchProviderCfg,
    query: &str,
    max_results: i64,
    time_range: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Vec<SearchItem>, String> {
    let is_news = time_range == Some("day");
    let mut body = json!({
        "query": query,
        "api_key": cfg.api_key,
        "max_results": max_results,
        "search_depth": "basic",
        "topic": if is_news { "news" } else { "general" },
        "include_answer": false,
    });
    // TS 里 `days: timeRange === 'day' ? 1 : undefined` —— undefined 会被 JSON.stringify 丢弃
    if is_news {
        body["days"] = json!(1);
    }

    let (status, text) = post_json(&format!("{}/search", cfg.base_url), &cfg.api_key, &body, cancel).await?;
    if !(200..300).contains(&status) {
        return Err(format!("Tavily API error ({}): {}", status, text));
    }
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Tavily API error: invalid JSON response: {}", e))?;

    let items = data
        .get("results")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|it| {
                    let content = it.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    SearchItem {
                        title: it.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        url: it.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        // TS: `snippet: sliceHead(item.content, 300)`
                        snippet: slice_head(content, 300),
                        content: Some(content.to_string()),
                        score: it.get("score").and_then(|v| v.as_f64()),
                        ..Default::default()
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(items)
}

/// 博查：`POST {base}/web-search`（镜像 `search-providers/bocha.ts`）
async fn search_bocha(
    cfg: &SearchProviderCfg,
    query: &str,
    max_results: i64,
    time_range: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Vec<SearchItem>, String> {
    let freshness = match time_range {
        Some("day") => "oneDay",
        Some("week") => "oneWeek",
        Some("month") => "oneMonth",
        Some("year") => "oneYear",
        _ => "noLimit",
    };
    let body = json!({
        "query": query,
        "count": max_results,
        "summary": true,
        "freshness": freshness,
    });

    let (status, text) = post_json(&format!("{}/web-search", cfg.base_url), &cfg.api_key, &body, cancel).await?;
    if !(200..300).contains(&status) {
        return Err(format!("博查 API error ({}): {}", status, text));
    }
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| format!("博查 API error: invalid JSON response: {}", e))?;

    // TS: `data.code !== 200` → 抛错（msg 为空时回落到 `code=...`）
    if data.get("code").and_then(|v| v.as_i64()) != Some(200) {
        let msg = data
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                format!(
                    "code={}",
                    data.get("code").map(|v| v.to_string()).unwrap_or_else(|| "null".into())
                )
            });
        return Err(format!("博查 API error: {}", msg));
    }

    let items = data
        .get("data")
        .and_then(|d| d.get("webPages"))
        .and_then(|w| w.get("value"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|p| SearchItem {
                    title: p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    url: p.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    // 博查的 snippet 取自 `summary` 字段（不是 `snippet`）
                    snippet: p.get("summary").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    icon: p.get("siteIcon").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    published_date: p
                        .get("datePublished")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    source: p.get("siteName").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    ..Default::default()
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(items)
}

/// 发一个 JSON POST，返回 `(状态码, 响应体文本)`。
///
/// 非 2xx **不在这里报错** —— 由调用方按各自文案组装（与 TS 里
/// `if (!response.ok) { const errorBody = await response.text().catch(...) }` 一致）。
async fn post_json(
    url: &str,
    api_key: &str,
    body: &Value,
    cancel: &CancellationToken,
) -> Result<(u16, String), String> {
    let req = http_client()
        .post(url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .json(body);

    let resp = tokio::select! {
        _ = cancel.cancelled() => return Err("cancelled".to_string()),
        r = req.send() => r.map_err(|e| format!("Search request failed: {}", e))?,
    };
    let status = resp.status().as_u16();
    // TS: `await response.text().catch(() => 'Unknown error')`
    let text = resp
        .text()
        .await
        .unwrap_or_else(|_| "Unknown error".to_string());
    Ok((status, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::noop_repo;
    use crate::agent::native_tools::test_util::test_security;
    use crate::session_db::{NoopSettingsRepo, SettingsRepo};

    /// 构造 ctx 并跑 `web_search`（`settings` = 后端注入的配置来源）
    async fn run_with(settings: &dyn SettingsRepo, args: Value) -> NativeToolOutcome {
        let sec = test_security("C:/tmp");
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s1",
            tool_call_id: "tc_web",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings,
        };
        web_search_tool(&ctx, &args).await.expect("不应返回 Err")
    }

    /// 缺 `query` → 与 TS 同一句文案
    #[tokio::test]
    async fn missing_query_message_matches_ts() {
        let out = run_with(&NoopSettingsRepo, json!({})).await;
        match out {
            NativeToolOutcome::Value { content, ui_data } => {
                assert_eq!(content, MISSING_QUERY_MSG);
                assert!(ui_data.is_none());
            }
            other => panic!("期望 Value，得到 {:?}", other),
        }
    }

    /// 无设置后端（= 未配置搜索源）→ 与 TS 同一句文案
    #[tokio::test]
    async fn no_provider_message_matches_ts() {
        let out = run_with(&NoopSettingsRepo, json!({ "query": "rust" })).await;
        match out {
            NativeToolOutcome::Value { content, .. } => assert_eq!(content, NO_PROVIDER_MSG),
            other => panic!("期望 Value，得到 {:?}", other),
        }
    }
}
