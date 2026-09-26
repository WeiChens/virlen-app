//! 模型列表拉取 + 连通性验证 —— **配置向导**用（不属于运行时 `Provider` trait）
//!
//! 为什么单独一个模块而不加进 `Provider` trait：
//!
//! 1. `list_models` 只在「配供应商」这一刻用得上，引擎跑一轮对话完全不需要它；
//!    加进 trait 就得连 `BridgedProvider`（Gemini 等走 JS 桥的）一起实现一遍 —— 那是无意义的负担。
//! 2. 这里的能力是**面向调用方**的（CLI 向导 / 未来的诊断命令），不是面向引擎的。
//!
//! ## 与 TS 的口径（铁律 1：双引擎同语义）
//!
//! 两个函数都是 `src/infrastructure/provider/{openai,anthropic}.ts` 里同名逻辑的移植：
//!
//! | 能力 | TS 落点 | 请求 |
//! |---|---|---|
//! | `listModels()` | `openai.ts:120` / `anthropic.ts:161` | `GET {base}/models`（anthropic 用 **origin**，即 scheme://host） |
//! | `validateApiKey()` | `openai.ts:85` / `anthropic.ts:131` | 发一条 `ping` 的最小对话，**`max_tokens: 1`** |
//!
//! ⚠️ anthropic 的 `listModels` 故意不拼 basePath（TS 用 `new URL(baseUrl)` 取 `protocol//host`）：
//! 因为 Anthropic 的模型列表在**根域**上，不在 `/v1` 下面。这里逐字对齐。

use super::super::cancellation::CancellationToken;
use super::super::types::{ChatRequest, Message, ProviderConnection};
use super::anthropic::NativeAnthropicProvider;
use super::openai::NativeOpenAiProvider;
use super::Provider;
use serde_json::{json, Value};

/// 连通性验证用的最小对话内容（与 TS `validateApiKey` 的 `'ping'` 逐字一致）
const PING_TEXT: &str = "ping";

/// 列表拉取的超时上限。
///
/// ⚠️ `reqwest::Client::new()` **默认没有超时** —— 配置向导里一个不可达的 Base URL 会把
/// 用户永久卡在「正在拉取…」。20s 足够一次正常的 /models 往返，也短到用户不会以为死机。
const LIST_MODELS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 带超时的 HTTP 客户端（构建失败时退回默认客户端 —— 不因为一个超时配置让功能不可用）
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(LIST_MODELS_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 拉取供应商的模型列表。
///
/// - `openai`：`GET {baseUrl}/models`，`Authorization: Bearer`；取 `data[].id`
/// - `anthropic`：`GET {scheme}://{host}/models`，带 `x-api-key` / `anthropic-version`
/// - 其余协议（gemini 等走 JS 桥）：明确报错，不静默返回空表
pub async fn list_models(
    provider_type: &str,
    api_key: &str,
    base_url: &str,
) -> Result<Vec<String>, String> {
    match provider_type {
        "openai" => list_models_openai(api_key, base_url).await,
        "anthropic" => list_models_anthropic(api_key, base_url).await,
        other => Err(format!(
            "暂不支持拉取 `{}` 协议的模型列表（该协议需要前端 JS 桥）；请手工填写模型 id",
            other
        )),
    }
}

/// 验证「这个 key + baseUrl + model 真的能用」—— 发一条 `ping` 的最小对话。
///
/// 与 GUI「验证 API Key」同一条路径、同一个 `max_tokens: 1`：因此 CLI 里能从 401/404/额度错误里
/// 拿到与桌面端**一致**的判定。成功时返回助手回答的纯文本（一般只有 1 个 token，可能为空串）。
///
/// ⚠️ 这是**真实计费调用**（虽然只花 1 个 token）。向导里应把它作为可选步骤并提前说明。
pub async fn verify_connection(conn: &ProviderConnection, model: &str) -> Result<String, String> {
    let provider: Box<dyn Provider> = match conn.provider_type.as_str() {
        "openai" => Box::new(NativeOpenAiProvider::new(
            &conn.provider_id,
            &conn.api_key,
            &conn.base_url,
        )),
        "anthropic" => Box::new(NativeAnthropicProvider::new(
            &conn.provider_id,
            &conn.api_key,
            &conn.base_url,
        )),
        other => {
            return Err(format!(
                "暂不支持验证 `{}` 协议的连接（该协议需要前端 JS 桥）",
                other
            ))
        }
    };

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![Message {
            role: "user".to_string(),
            content: json!([{ "type": "text", "text": PING_TEXT }]),
            ..Default::default()
        }],
        system_prompt: None,
        tools: Vec::new(),
        temperature: 0.0,
        top_p: 1.0,
        max_tokens: 1,
        stream: false,
        tool_choice: String::new(),
        reasoning_effort: None,
        thinking: None,
    };

    let cancel = CancellationToken::new();
    let message = provider.chat(&request, &cancel).await?;
    Ok(message.text_content())
}

// ==================== 协议实现 ====================

async fn list_models_openai(api_key: &str, base_url: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let resp = http_client()
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("API Error: {}", e))?;
    parse_models_response(resp).await
}

async fn list_models_anthropic(api_key: &str, base_url: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/models", origin_of(base_url)?);
    let resp = http_client()
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("API Error: {}", e))?;
    parse_models_response(resp).await
}

/// `scheme://host[:port]`（对应 TS 的 `new URL(baseUrl)` 取 `protocol//host`）
fn origin_of(base_url: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(base_url)
        .map_err(|e| format!("Base URL 无法解析 ({}): {}", base_url, e))?;
    let host = u
        .host_str()
        .ok_or_else(|| format!("Base URL 缺少主机名: {}", base_url))?;
    Ok(match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    })
}

/// 共用的响应处理：非 2xx 报错（带上响应体，401/404 的原因都在里面），成功取 `data[].id`
async fn parse_models_response(resp: reqwest::Response) -> Result<Vec<String>, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read the response: {}", e))?;
    if !status.is_success() {
        return Err(format!("API Error ({}): {}", status.as_u16(), text));
    }
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse the response: {}", e))?;
    Ok(data
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// origin 只保留协议 + 主机（+ 端口）；path 必须丢掉（Anthropic 的模型列表在根域）
    #[test]
    fn origin_strips_path() {
        assert_eq!(
            origin_of("https://api.anthropic.com/v1").unwrap(),
            "https://api.anthropic.com"
        );
        assert_eq!(
            origin_of("http://127.0.0.1:8080/v1").unwrap(),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn origin_rejects_garbage() {
        assert!(origin_of("not-a-url").is_err());
    }

    /// 不支持的协议必须**报错**而不是返回空列表 —— 空列表会被向导误读成「这家没有模型」
    #[tokio::test]
    async fn unsupported_protocol_errors_out() {
        let err = list_models("gemini", "k", "https://example.com").await.unwrap_err();
        assert!(err.contains("gemini"), "{}", err);
    }

    #[tokio::test]
    async fn verify_unsupported_protocol_errors_out() {
        let conn = ProviderConnection {
            provider_type: "gemini".into(),
            provider_id: "p".into(),
            api_key: "k".into(),
            base_url: "https://example.com".into(),
        };
        let err = verify_connection(&conn, "m").await.unwrap_err();
        assert!(err.contains("gemini"), "{}", err);
    }
}
