//! `web_search` 工具（原生）— 通过已配置的搜索源检索互联网。
//!
//! 配置来源：`searchProviders` / `defaultSearchProviderId` 在 `app_settings` 表，经 `ctx.settings` 直读
//! —— GUI 与 CLI 天然一致（对比：`sandbox_ignore_rules` 随消息下发，因沙盒判定要求每条命令零 IO）。
//!
//! ⚠️ 与 TS `web-search.ts` + `search-providers/{tavily,bocha,deepseek}.ts` 逐字对齐（铁律 1）：三类文案、
//! 结果文本（共读 golden）、`uiData` 形状、请求体与响应字段映射均一致。与 TS 一样只支持
//! `tavily` / `bocha` / `deepseek`（`searxng` 未接入，两侧都表现为「未配置搜索源」）。

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
/// DeepSeek `count` 上下限（官方 1~50，越界直接 400）
const DEEPSEEK_MIN_COUNT: i64 = 1;
const DEEPSEEK_MAX_COUNT: i64 = 50;
/// DeepSeek `rerank_score` 满分（官方 0~3 分，1.5 分算优质）
const DEEPSEEK_MAX_RERANK_SCORE: f64 = 3.0;
/// DeepSeek `query` 上限（官方 1~128 字符）：拼 `after:` 后超限就放弃时间限定
const DEEPSEEK_MAX_QUERY_CHARS: usize = 128;
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
        "deepseek" => {
            search_deepseek(&cfg, &query, max_results, time_range.as_deref(), ctx.cancel).await?
        }
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
                // 只到域名：搜索在 `/v1/tools/search`、余额在 `/user/balance`（两个前缀不同）
                "deepseek" => "https://api.deepseek.com".to_string(),
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

/// DeepSeek：`POST {base}/v1/tools/search`（镜像 `search-providers/deepseek.ts`）
async fn search_deepseek(
    cfg: &SearchProviderCfg,
    query: &str,
    max_results: i64,
    time_range: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Vec<SearchItem>, String> {
    let body = json!({
        "query": deepseek_query(query, time_range),
        "count": max_results.clamp(DEEPSEEK_MIN_COUNT, DEEPSEEK_MAX_COUNT),
    });

    let (status, text) = post_json(
        &format!("{}/v1/tools/search", cfg.base_url),
        &cfg.api_key,
        &body,
        cancel,
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(format!("DeepSeek API error ({}): {}", status, text));
    }
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| format!("DeepSeek API error: invalid JSON response: {}", e))?;
    Ok(deepseek_items(&data))
}

/// 给 query 拼时间限定：DeepSeek 没有 freshness 参数，只有 `after:YYYY-MM-DD` 搜索语法。
///
/// ⚠️ 与 TS `withTimeRange` 逐字对齐（铁律 1）：日期一律按 UTC 算；拼完超过 128 字符就放弃限定
/// （官方上限，超了直接 400）。
fn deepseek_query(query: &str, time_range: Option<&str>) -> String {
    let days = match time_range {
        Some("day") => 1,
        Some("week") => 7,
        Some("month") => 30,
        Some("year") => 365,
        _ => return query.to_string(),
    };
    let day = (chrono::Utc::now() - chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string();
    let joined = format!("{} after:{}", query, day);
    if joined.chars().count() <= DEEPSEEK_MAX_QUERY_CHARS {
        joined
    } else {
        query.to_string()
    }
}

/// `results[]` → 统一 `SearchItem`（纯函数，便于单测）。
///
/// 映射口径见 TS `search-providers/deepseek.ts` 文件头：`snippet ← summary`（空则退回 `snippet`）、
/// `score ← rerank_score / 3`（0~3 分 → 0~1）。
fn deepseek_items(data: &Value) -> Vec<SearchItem> {
    data.get("results")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    let snippet = r.get("snippet").and_then(|v| v.as_str()).unwrap_or("");
                    let summary = r.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                    SearchItem {
                        title: r.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        url: r.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        snippet: if summary.is_empty() {
                            snippet.to_string()
                        } else {
                            summary.to_string()
                        },
                        icon: non_empty(r.get("site_icon")),
                        // `need_content` 默认 false → 官方返回空串；空串当作没有
                        content: non_empty(r.get("content")),
                        published_date: non_empty(r.get("date")),
                        source: non_empty(r.get("site_name")),
                        score: r
                            .get("rerank_score")
                            .and_then(|v| v.as_f64())
                            .map(|s| (s / DEEPSEEK_MAX_RERANK_SCORE).clamp(0.0, 1.0)),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 取非空字符串字段（null / 缺失 / 空串 → None，对齐 TS 的 `r.x || undefined`）
fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
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
            memory: crate::agent::native_tools::noop_memory(),
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

    /// DeepSeek 结果映射：summary 优先、score 归一到 0~1、null / 空串字段不进搜索结果
    #[test]
    fn deepseek_items_maps_fields() {
        let data = json!({
            "results": [
                {
                    "rerank_score": 2.4,
                    "title": "T1",
                    "url": "https://a.com",
                    "snippet": "短摘要",
                    "summary": "长摘要",
                    "content": "",
                    "site_name": "站点",
                    "site_icon": null,
                    "date": "2026-06-01T00:00:00+00:00",
                    "authority": 3
                },
                {
                    "title": "T2",
                    "url": "https://b.com",
                    "snippet": "只有短摘要",
                    "summary": ""
                }
            ]
        });

        let items = deepseek_items(&data);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].snippet, "长摘要");
        assert_eq!(items[0].content, None);
        assert_eq!(items[0].icon, None);
        assert_eq!(items[0].source.as_deref(), Some("站点"));
        assert_eq!(
            items[0].published_date.as_deref(),
            Some("2026-06-01T00:00:00+00:00")
        );
        let score = items[0].score.expect("rerank_score 存在就应换算成 score");
        assert!((score - 0.8).abs() < 1e-9, "2.4 / 3 应为 0.8，得到 {}", score);

        // summary 为空 → 退回 snippet；缺字段一律 None
        assert_eq!(items[1].snippet, "只有短摘要");
        assert_eq!(items[1].score, None);
        assert_eq!(items[1].source, None);
    }

    /// 时间范围 → `after:` 语法（DeepSeek 没有 freshness 参数）
    #[test]
    fn deepseek_query_appends_after_operator() {
        let q = deepseek_query("rust", Some("week"));
        assert!(q.starts_with("rust after:"), "{}", q);
        assert_eq!(q.len(), "rust after:YYYY-MM-DD".len());

        // 无时间范围 → 原样返回
        assert_eq!(deepseek_query("rust", None), "rust");

        // 超长 query 不再拼：官方上限 128 字符，超了直接 400
        let long = "测".repeat(DEEPSEEK_MAX_QUERY_CHARS);
        assert_eq!(deepseek_query(&long, Some("day")), long);
    }
}
