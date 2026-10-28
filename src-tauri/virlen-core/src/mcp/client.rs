//! 单连接 MCP 客户端 —— 握手、列工具、调工具、收通知。
//!
//! 这一层不认识「哪台服务器」「要不要审批」「工具名怎么公开」（那些在 P1 的 registry / bridge），
//! 只负责把协议讲对：
//!
//! - `initialize` 按 `2025-06-18` → `2025-03-26` → `2024-11-05` 依次尝试（老服务器会对未知版本
//!   直接报错，客户端必须能降级；服务器回了我们不认识的版本则接受 + 告警，不硬失败 ——
//!   MCP 的版本协商语义是「服务器说了算」）；
//! - `tools/list` 自己走完分页（上限 50 页，防游标死循环）；
//! - 同一台服务器列出重名工具 = 无效列表，整批失败（绝不「部分注册」）；
//! - `tools/call` 的 `isError` 原样上报（是否变成工具失败由 P1 的桥决定，这里不吞）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::jsonrpc::{Incoming, RpcError};
use super::transport::{Transport, TransportError};

/// 客户端名（服务器日志里能看到，便于排查「谁连的」）
pub const CLIENT_NAME: &str = "virlen";

/// 支持的协议版本（从新到旧；握手时依次尝试）
pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// `tools/list` 分页上限
const MAX_TOOL_PAGES: usize = 50;

/// `resources/list` 分页上限（与工具同一条纪律：游标死循环不能变成死循环）
const MAX_RESOURCE_PAGES: usize = 50;

// ==================== 结果类型 ====================

/// `initialize` 的协商结果。
#[derive(Debug, Clone, PartialEq)]
pub struct InitializeResult {
    /// 最终使用的协议版本（服务器选的）
    pub protocol_version: String,
    /// 服务器自称的名字（**只用于展示**，绝不用于命名 —— 远端名字不可信且会变）
    pub server_name: String,
    pub server_version: String,
    /// 服务器说明书（P3 才注入系统提示词）
    pub instructions: Option<String>,
    pub capabilities: Value,
    /// 是否声明了 tools 能力（没声明的服务器仍然可以连，只是没有工具）
    pub supports_tools: bool,
    /// 是否支持「工具列表变更」通知（决定要不要期待 `notifications/tools/list_changed`）
    pub tools_list_changed: bool,
    /// 是否声明了 resources 能力（没声明的服务器不查资源：`resources/list` 会回 -32601）
    pub supports_resources: bool,
}

/// 一台服务器的一个工具（`input_schema` 是原始 schema，清洗见 `mcp::schema`）。
#[derive(Debug, Clone, PartialEq)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// `resources/list` 的一项（资源是**服务器声明的可读数据**，不是工具）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    /// 资源定位符（`file://` / `https://` / 自定义 scheme）—— `resources/read` 只认它
    pub uri: String,
    /// 服务器给的人类可读名字（可能为空：协议里 `name` 是必填，但现实里常有空串）
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// 声明的大小（字节；服务器可以不填）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// `resources/read` 返回的一段内容（协议允许一个 URI 对应多段）。
#[derive(Debug, Clone, PartialEq)]
pub struct ResourceContent {
    pub uri: String,
    pub mime_type: Option<String>,
    /// 文本内容（与 `blob` 二选一）
    pub text: Option<String>,
    /// base64 二进制（与 `text` 二选一）—— **绝不进模型上下文**，只用来算字节数
    pub blob: Option<String>,
}

/// `resources/read` 的原始结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ReadResourceResult {
    pub contents: Vec<ResourceContent>,
}

/// `tools/call` 的原始结果。
#[derive(Debug, Clone, PartialEq)]
pub struct CallToolResult {
    /// 内容块数组（`text` / `image` / `audio` / `resource_link` / `resource` …），顺序即协议顺序
    pub content: Vec<Value>,
    /// 结构化结果（服务器声明 `outputSchema` 时才有）
    pub structured: Option<Value>,
    /// ⚠️ 服务器报告的**业务失败**（不是协议失败）：必须原样上报，不能当成功
    pub is_error: bool,
}

// ==================== 客户端 ====================

pub struct Client {
    transport: Arc<dyn Transport>,
    events: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<Incoming>>,
    info: Mutex<Option<InitializeResult>>,
}

/// 手写 `Debug`：`Arc<dyn Transport>` 不是 `Debug`，但测试与日志都需要能打印客户端状态。
impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let version = self
            .info
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|info| info.protocol_version.clone()));
        f.debug_struct("Client")
            .field("transport", &self.transport.kind())
            .field("protocol_version", &version)
            .finish()
    }
}

impl Client {
    /// 建连 + 握手（不列工具：要不要列、何时列由 P1 的监督器决定）。
    pub async fn connect(
        transport: Arc<dyn Transport>,
        startup_timeout: Duration,
    ) -> Result<Arc<Self>, TransportError> {
        let events = transport.take_events().ok_or_else(|| {
            TransportError::Protocol("transport events were already taken".to_string())
        })?;
        let client = Arc::new(Self {
            transport,
            events: tokio::sync::Mutex::new(events),
            info: Mutex::new(None),
        });

        let info = client.handshake(startup_timeout).await?;
        // 规范要求：握手成功立刻发 `notifications/initialized`
        client
            .transport
            .notify("notifications/initialized", json!({}))
            .await?;
        // HTTP：开服务端推送通道（stdio 没这个概念，默认返回 false）
        if let Err(e) = client.transport.start_event_stream().await {
            eprintln!("[mcp] 服务端事件流未建立（不影响请求通道）：{e}");
        }
        *client.info.lock().unwrap() = Some(info);
        Ok(client)
    }

    pub fn info(&self) -> Option<InitializeResult> {
        self.info.lock().unwrap().clone()
    }

    pub fn transport_kind(&self) -> &'static str {
        self.transport.kind()
    }

    pub fn transport(&self) -> &Arc<dyn Transport> {
        &self.transport
    }

    pub fn is_closed(&self) -> bool {
        self.transport.is_closed()
    }

    pub async fn wait_closed(&self) {
        self.transport.wait_closed().await
    }

    pub async fn close(&self) {
        self.transport.close().await
    }

    /// 健康检查（失败两次由监督器判定断链）
    pub async fn ping(&self, timeout: Duration) -> Result<(), TransportError> {
        self.transport.request("ping", json!({}), timeout).await?;
        Ok(())
    }

    /// 列出全部工具（自动分页）。
    pub async fn list_tools(&self, timeout: Duration) -> Result<Vec<McpTool>, TransportError> {
        let mut tools: Vec<McpTool> = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_TOOL_PAGES {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let result = self.transport.request("tools/list", params, timeout).await?;
            let page = result
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            for item in page {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                // 无名工具无法调用（`tools/call` 只认名字），静默跳过比渲染一个空行工具好
                if name.is_empty() {
                    continue;
                }
                if tools.iter().any(|tool| tool.name == name) {
                    return Err(TransportError::Protocol(format!(
                        "server listed tool \"{name}\" more than once — invalid tool list"
                    )));
                }
                tools.push(McpTool {
                    name,
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input_schema: item
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                });
            }

            match result.get("nextCursor").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => return Ok(tools),
            }
        }
        Err(TransportError::Protocol(format!(
            "tools/list exceeded {MAX_TOOL_PAGES} pages — server cursor likely loops"
        )))
    }

    /// 列出全部资源（自动分页）。
    pub async fn list_resources(
        &self,
        timeout: Duration,
    ) -> Result<Vec<McpResource>, TransportError> {
        let mut resources: Vec<McpResource> = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_RESOURCE_PAGES {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let result = self
                .transport
                .request("resources/list", params, timeout)
                .await?;
            let page = result
                .get("resources")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            for item in page {
                let uri = item
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                // 没有 uri 的资源读不了（`resources/read` 只认 uri）：跳过比列一个死项好
                if uri.is_empty() || resources.iter().any(|r| r.uri == uri) {
                    continue;
                }
                resources.push(McpResource {
                    uri,
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    title: optional_text(&item, "title"),
                    description: optional_text(&item, "description"),
                    mime_type: optional_text(&item, "mimeType"),
                    size: item.get("size").and_then(Value::as_u64),
                });
            }

            match result.get("nextCursor").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => return Ok(resources),
            }
        }
        Err(TransportError::Protocol(format!(
            "resources/list exceeded {MAX_RESOURCE_PAGES} pages — server cursor likely loops"
        )))
    }

    /// 读一个资源（`uri` 必须是服务器在 `resources/list` 里给过的，或模板展开后的 URI）。
    pub async fn read_resource(
        &self,
        uri: &str,
        timeout: Duration,
    ) -> Result<ReadResourceResult, TransportError> {
        let result = self
            .transport
            .request("resources/read", json!({ "uri": uri }), timeout)
            .await?;
        let contents = match result.get("contents") {
            Some(Value::Array(items)) => items.clone(),
            None | Some(Value::Null) => Vec::new(),
            Some(other) => {
                return Err(TransportError::Protocol(format!(
                    "resources/read returned non-array contents: {other}"
                )))
            }
        };
        Ok(ReadResourceResult {
            contents: contents
                .into_iter()
                .map(|item| ResourceContent {
                    uri: item
                        .get("uri")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or(uri)
                        .to_string(),
                    mime_type: optional_text(&item, "mimeType"),
                    text: item.get("text").and_then(Value::as_str).map(str::to_string),
                    blob: item.get("blob").and_then(Value::as_str).map(str::to_string),
                })
                .collect(),
        })
    }

    /// 调用一个工具（`name` 必须是服务器自己的原始名，不是 `mcp__…` 公开名）。
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<CallToolResult, TransportError> {
        let result = self
            .transport
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
                timeout,
            )
            .await?;
        let content = match result.get("content") {
            Some(Value::Array(items)) => items.clone(),
            None | Some(Value::Null) => Vec::new(),
            Some(other) => {
                return Err(TransportError::Protocol(format!(
                    "tools/call returned non-array content: {other}"
                )))
            }
        };
        Ok(CallToolResult {
            content,
            structured: result
                .get("structuredContent")
                .cloned()
                .filter(|value| !value.is_null()),
            is_error: result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// 取下一条服务器主动消息（通知 / 反向请求）。连接关闭后返回 `None`。
    pub async fn next_event(&self) -> Option<Incoming> {
        let mut events = self.events.lock().await;
        events.recv().await
    }

    /// 回一个「我不支持这个方法」（协议规定反向请求必须应答，不能装死）。
    pub async fn reject_server_request(&self, id: &Value, method: &str) {
        let error = RpcError::method_not_found(method);
        if let Err(e) = self.transport.reply_error(id, &error).await {
            eprintln!("[mcp] 回 MethodNotFound 失败：{e}");
        }
    }

    // ==================== 内部 ====================

    async fn handshake(&self, timeout: Duration) -> Result<InitializeResult, TransportError> {
        let mut last_error: Option<TransportError> = None;
        for (index, version) in PROTOCOL_VERSIONS.iter().enumerate() {
            let params = json!({
                "protocolVersion": version,
                "capabilities": {},
                "clientInfo": {
                    "name": CLIENT_NAME,
                    "version": env!("CARGO_PKG_VERSION"),
                },
            });
            match self.transport.request("initialize", params, timeout).await {
                Ok(result) => {
                    let info = parse_initialize(&result)?;
                    self.transport.set_protocol_version(&info.protocol_version);
                    if !PROTOCOL_VERSIONS.contains(&info.protocol_version.as_str()) {
                        // 服务器选了更新的版本：接受（版本协商是服务器说了算），但在日志里留痕
                        eprintln!(
                            "[mcp] 服务器选择了未在支持列表里的协议版本 {}（已接受）",
                            info.protocol_version
                        );
                    }
                    return Ok(info);
                }
                Err(error @ TransportError::Rpc(_)) => {
                    // 老服务器对未知版本直接报错 → 降级重试；不是 Rpc 的错误（IO/超时）直接上抛
                    last_error = Some(error);
                    if index + 1 >= PROTOCOL_VERSIONS.len() {
                        break;
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error.unwrap_or_else(|| {
            TransportError::Protocol("initialize failed for every supported protocol version".into())
        }))
    }
}

/// 解析 `initialize` 的 result（字段缺失一律给可用默认值，只有 `protocolVersion` 是硬要求）
fn parse_initialize(result: &Value) -> Result<InitializeResult, TransportError> {
    let protocol_version = result
        .get("protocolVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            TransportError::Protocol("initialize response is missing protocolVersion".to_string())
        })?
        .to_string();

    let server_info = result.get("serverInfo");
    let capabilities = result
        .get("capabilities")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let tools_capability = capabilities.get("tools");
    Ok(InitializeResult {
        protocol_version,
        server_name: server_info
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        server_version: server_info
            .and_then(|info| info.get("version"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        instructions: result
            .get("instructions")
            .and_then(Value::as_str)
            .map(str::to_string),
        supports_tools: tools_capability.is_some(),
        tools_list_changed: tools_capability
            .and_then(|tools| tools.get("listChanged"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        supports_resources: capabilities.get("resources").is_some(),
        capabilities,
    })
}

/// 取一个可选文本字段（空串等同缺失 —— 服务器常把「没有」写成 `""`）
fn optional_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 供 P1 用：`RpcError` → 给模型看的一句英文（不含服务器可控的长文本换行）
pub fn rpc_error_for_model(error: &RpcError) -> String {
    error.summary()
}

/// 供 P1 用：协议版本是否在支持列表里
pub fn is_supported_protocol(version: &str) -> bool {
    PROTOCOL_VERSIONS.contains(&version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::mpsc;

    /// 脚本化的假传输：按方法名返回预置结果，并记录收到的请求。
    struct FakeTransport {
        script: Mutex<Vec<(String, Result<Value, RpcError>)>>,
        sent: Mutex<Vec<(String, Value)>>,
        events: Mutex<Option<mpsc::UnboundedReceiver<Incoming>>>,
        events_tx: mpsc::UnboundedSender<Incoming>,
        closed: AtomicBool,
        protocol_version: Mutex<Option<String>>,
        event_stream_started: AtomicBool,
    }

    impl FakeTransport {
        fn new() -> Arc<Self> {
            let (events_tx, events) = mpsc::unbounded_channel();
            Arc::new(Self {
                script: Mutex::new(Vec::new()),
                sent: Mutex::new(Vec::new()),
                events: Mutex::new(Some(events)),
                events_tx,
                closed: AtomicBool::new(false),
                protocol_version: Mutex::new(None),
                event_stream_started: AtomicBool::new(false),
            })
        }

        fn push_ok(&self, method: &str, value: Value) {
            self.script
                .lock()
                .unwrap()
                .push((method.to_string(), Ok(value)));
        }

        fn push_err(&self, method: &str, error: RpcError) {
            self.script
                .lock()
                .unwrap()
                .push((method.to_string(), Err(error)));
        }

        fn sent_methods(&self) -> Vec<String> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .map(|(method, _)| method.clone())
                .collect()
        }

        fn last_params(&self, method: &str) -> Option<Value> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|(name, _)| name == method)
                .map(|(_, params)| params.clone())
        }

        fn push_event(&self, message: Incoming) {
            let _ = self.events_tx.send(message);
        }
    }

    #[async_trait::async_trait]
    impl Transport for FakeTransport {
        fn kind(&self) -> &'static str {
            "fake"
        }

        async fn request(
            &self,
            method: &str,
            params: Value,
            _timeout: Duration,
        ) -> Result<Value, TransportError> {
            self.sent
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let mut script = self.script.lock().unwrap();
            let position = script.iter().position(|(name, _)| name == method);
            match position {
                Some(index) => {
                    let (_, result) = script.remove(index);
                    drop(script);
                    match result {
                        Ok(value) => Ok(value),
                        Err(error) => Err(TransportError::Rpc(error)),
                    }
                }
                None => Err(TransportError::Protocol(format!(
                    "unexpected request: {method}"
                ))),
            }
        }

        async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
            self.sent
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            Ok(())
        }

        async fn reply_error(&self, id: &Value, error: &RpcError) -> Result<(), TransportError> {
            self.sent.lock().unwrap().push((
                "<reply>".to_string(),
                json!({ "id": id, "error": error }),
            ));
            Ok(())
        }

        async fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }

        fn is_closed(&self) -> bool {
            self.closed.load(Ordering::SeqCst)
        }

        async fn wait_closed(&self) {
            while !self.is_closed() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }

        fn take_events(&self) -> Option<mpsc::UnboundedReceiver<Incoming>> {
            self.events.lock().ok().and_then(|mut slot| slot.take())
        }

        fn set_protocol_version(&self, version: &str) {
            *self.protocol_version.lock().unwrap() = Some(version.to_string());
        }

        async fn start_event_stream(&self) -> Result<bool, TransportError> {
            self.event_stream_started.store(true, Ordering::SeqCst);
            Ok(true)
        }
    }

    fn init_result(version: &str) -> Value {
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": { "name": "fixture", "version": "1.2.3" },
            "instructions": "be nice"
        })
    }

    #[tokio::test]
    async fn handshake_parses_capabilities_and_notifies_initialized() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        let client = Client::connect(transport.clone(), Duration::from_secs(1))
            .await
            .expect("握手应成功");

        let info = client.info().expect("info 已写入");
        assert_eq!(info.protocol_version, "2025-06-18");
        assert_eq!(info.server_name, "fixture");
        assert_eq!(info.server_version, "1.2.3");
        assert_eq!(info.instructions.as_deref(), Some("be nice"));
        assert!(info.supports_tools);
        assert!(info.tools_list_changed);
        assert_eq!(
            transport.protocol_version.lock().unwrap().as_deref(),
            Some("2025-06-18")
        );
        assert!(transport
            .sent_methods()
            .contains(&"notifications/initialized".to_string()));
        assert!(
            transport.event_stream_started.load(Ordering::SeqCst),
            "握手后应尝试开服务端推送通道"
        );

        // 客户端信息要带上版本号（服务器靠它区分实现）
        let params = transport.last_params("initialize").unwrap();
        assert_eq!(params["clientInfo"]["name"], CLIENT_NAME);
        assert_eq!(params["clientInfo"]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn handshake_falls_back_to_older_protocol_versions() {
        let transport = FakeTransport::new();
        transport.push_err(
            "initialize",
            RpcError::new(-32602, "unsupported protocol version"),
        );
        transport.push_err(
            "initialize",
            RpcError::new(-32602, "still unsupported"),
        );
        transport.push_ok("initialize", init_result("2024-11-05"));

        let client = Client::connect(transport.clone(), Duration::from_secs(1))
            .await
            .expect("第三次应成功");
        assert_eq!(
            client.info().unwrap().protocol_version,
            "2024-11-05",
            "应采用服务器选的旧版本"
        );
        let attempts: Vec<String> = transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "initialize")
            .map(|(_, params)| params["protocolVersion"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            attempts,
            vec!["2025-06-18", "2025-03-26", "2024-11-05"],
            "降级顺序必须是新 → 旧"
        );
    }

    #[tokio::test]
    async fn handshake_gives_up_with_last_error() {
        let transport = FakeTransport::new();
        for _ in 0..PROTOCOL_VERSIONS.len() {
            transport.push_err("initialize", RpcError::new(-32602, "nope"));
        }
        let error = Client::connect(transport, Duration::from_secs(1))
            .await
            .expect_err("全失败应报错");
        assert!(matches!(error, TransportError::Rpc(_)), "{error:?}");
    }

    #[tokio::test]
    async fn handshake_requires_protocol_version_field() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", json!({ "capabilities": {} }));
        let error = Client::connect(transport, Duration::from_secs(1))
            .await
            .expect_err("缺 protocolVersion 应报错");
        assert!(matches!(error, TransportError::Protocol(_)), "{error:?}");
    }

    #[tokio::test]
    async fn io_errors_are_not_retried_with_older_versions() {
        struct Failing;
        #[async_trait::async_trait]
        impl Transport for Failing {
            fn kind(&self) -> &'static str {
                "failing"
            }
            async fn request(
                &self,
                _method: &str,
                _params: Value,
                _timeout: Duration,
            ) -> Result<Value, TransportError> {
                Err(TransportError::Spawn("no such command".into()))
            }
            async fn notify(&self, _method: &str, _params: Value) -> Result<(), TransportError> {
                Ok(())
            }
            async fn reply_error(
                &self,
                _id: &Value,
                _error: &RpcError,
            ) -> Result<(), TransportError> {
                Ok(())
            }
            async fn close(&self) {}
            fn is_closed(&self) -> bool {
                true
            }
            async fn wait_closed(&self) {}
            fn take_events(&self) -> Option<mpsc::UnboundedReceiver<Incoming>> {
                let (_tx, rx) = mpsc::unbounded_channel();
                Some(rx)
            }
        }

        let error = Client::connect(Arc::new(Failing), Duration::from_secs(1))
            .await
            .expect_err("应直接失败");
        assert!(matches!(error, TransportError::Spawn(_)), "{error:?}");
    }

    #[tokio::test]
    async fn list_tools_walks_every_page() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        transport.push_ok(
            "tools/list",
            json!({
                "tools": [{ "name": "echo", "description": "回声", "inputSchema": { "type": "object" } }],
                "nextCursor": "p2"
            }),
        );
        transport.push_ok(
            "tools/list",
            json!({ "tools": [{ "name": "add", "inputSchema": { "type": "object" } }], "nextCursor": "p3" }),
        );
        transport.push_ok("tools/list", json!({ "tools": [{ "name": "boom" }] }));

        let client = Client::connect(transport.clone(), Duration::from_secs(1))
            .await
            .unwrap();
        let tools = client
            .list_tools(Duration::from_secs(1))
            .await
            .expect("分页应成功");
        assert_eq!(
            tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec!["echo", "add", "boom"]
        );
        assert_eq!(tools[0].description, "回声");
        // 无 inputSchema 时补一个空 object（后续 schema 清洗不必判空）
        assert_eq!(tools[2].input_schema["type"], "object");

        let cursors: Vec<Value> = transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "tools/list")
            .map(|(_, params)| params.clone())
            .collect();
        assert_eq!(cursors[0], json!({}));
        assert_eq!(cursors[1], json!({ "cursor": "p2" }));
        assert_eq!(cursors[2], json!({ "cursor": "p3" }));
    }

    #[tokio::test]
    async fn duplicate_tool_names_reject_the_whole_list() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        transport.push_ok(
            "tools/list",
            json!({ "tools": [{ "name": "dup" }, { "name": "dup" }] }),
        );
        let client = Client::connect(transport, Duration::from_secs(1))
            .await
            .unwrap();
        let error = client
            .list_tools(Duration::from_secs(1))
            .await
            .expect_err("重名应整批失败");
        assert!(matches!(error, TransportError::Protocol(_)), "{error:?}");
    }

    #[tokio::test]
    async fn call_tool_maps_content_structured_and_is_error() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        transport.push_ok(
            "tools/call",
            json!({
                "content": [{ "type": "text", "text": "3" }],
                "structuredContent": { "sum": 3 }
            }),
        );
        let client = Client::connect(transport.clone(), Duration::from_secs(1))
            .await
            .unwrap();

        let result = client
            .call_tool("add", json!({ "a": 1, "b": 2 }), Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.structured, Some(json!({ "sum": 3 })));
        assert!(!result.is_error);

        let params = transport.last_params("tools/call").unwrap();
        assert_eq!(params["name"], "add");
        assert_eq!(params["arguments"], json!({ "a": 1, "b": 2 }));
    }

    #[tokio::test]
    async fn call_tool_surfaces_is_error() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        transport.push_ok(
            "tools/call",
            json!({ "content": [{ "type": "text", "text": "boom" }], "isError": true }),
        );
        let client = Client::connect(transport, Duration::from_secs(1))
            .await
            .unwrap();
        let result = client
            .call_tool("fail", json!({}), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(result.is_error, "isError 必须原样上报");
    }

    #[tokio::test]
    async fn call_tool_rejects_non_array_content() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        transport.push_ok("tools/call", json!({ "content": "nope" }));
        let client = Client::connect(transport, Duration::from_secs(1))
            .await
            .unwrap();
        let error = client
            .call_tool("x", json!({}), Duration::from_secs(1))
            .await
            .expect_err("非数组 content 应报错");
        assert!(matches!(error, TransportError::Protocol(_)), "{error:?}");
    }

    #[tokio::test]
    async fn notifications_are_delivered_to_the_supervisor() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        let client = Client::connect(transport.clone(), Duration::from_secs(1))
            .await
            .unwrap();

        transport.push_event(Incoming::Notification {
            method: "notifications/tools/list_changed".into(),
            params: json!({}),
        });
        let event = client.next_event().await.expect("应收到通知");
        assert_eq!(
            event,
            Incoming::Notification {
                method: "notifications/tools/list_changed".into(),
                params: json!({})
            }
        );
    }

    #[tokio::test]
    async fn list_resources_walks_pages_and_skips_uri_less_items() {
        let transport = FakeTransport::new();
        transport.push_ok(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "resources": { "listChanged": true } },
                "serverInfo": { "name": "fixture", "version": "1.2.3" }
            }),
        );
        transport.push_ok(
            "resources/list",
            json!({
                "resources": [
                    { "uri": "file:///a.md", "name": "a", "mimeType": "text/markdown", "size": 12 },
                    { "uri": "file:///a.md", "name": "dup" },
                    { "name": "no-uri" }
                ],
                "nextCursor": "p2"
            }),
        );
        transport.push_ok(
            "resources/list",
            json!({ "resources": [{ "uri": "db://row/1", "name": "" , "title": "Row 1" }] }),
        );

        let client = Client::connect(transport.clone(), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(client.info().unwrap().supports_resources, "要记住 capabilities.resources");
        let resources = client
            .list_resources(Duration::from_secs(1))
            .await
            .expect("分页应成功");
        assert_eq!(
            resources.iter().map(|r| r.uri.as_str()).collect::<Vec<_>>(),
            vec!["file:///a.md", "db://row/1"]
        );
        assert_eq!(resources[0].mime_type.as_deref(), Some("text/markdown"));
        assert_eq!(resources[0].size, Some(12));
        assert_eq!(resources[1].title.as_deref(), Some("Row 1"));

        let cursors: Vec<Value> = transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "resources/list")
            .map(|(_, params)| params.clone())
            .collect();
        assert_eq!(cursors[0], json!({}));
        assert_eq!(cursors[1], json!({ "cursor": "p2" }));
    }

    #[tokio::test]
    async fn read_resource_maps_text_and_blob() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        transport.push_ok(
            "resources/read",
            json!({
                "contents": [
                    { "uri": "file:///a.md", "mimeType": "text/markdown", "text": "# hi" },
                    { "uri": "file:///b.bin", "mimeType": "application/octet-stream", "blob": "AAAA" }
                ]
            }),
        );
        let client = Client::connect(transport.clone(), Duration::from_secs(1))
            .await
            .unwrap();
        let result = client
            .read_resource("file:///a.md", Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(result.contents.len(), 2);
        assert_eq!(result.contents[0].text.as_deref(), Some("# hi"));
        assert_eq!(result.contents[1].blob.as_deref(), Some("AAAA"));
        assert_eq!(
            transport.last_params("resources/read").unwrap()["uri"],
            "file:///a.md"
        );
    }

    #[tokio::test]
    async fn read_resource_rejects_non_array_contents() {
        let transport = FakeTransport::new();
        transport.push_ok("initialize", init_result("2025-06-18"));
        transport.push_ok("resources/read", json!({ "contents": "nope" }));
        let client = Client::connect(transport, Duration::from_secs(1))
            .await
            .unwrap();
        let error = client
            .read_resource("file:///a.md", Duration::from_secs(1))
            .await
            .expect_err("非数组 contents 应报错");
        assert!(matches!(error, TransportError::Protocol(_)), "{error:?}");
    }

    #[test]
    fn protocol_helpers() {
        assert!(is_supported_protocol("2025-06-18"));
        assert!(!is_supported_protocol("1999-01-01"));
        let text = rpc_error_for_model(&RpcError::new(-32601, "Method not found: x"));
        assert!(text.contains("-32601"));
    }
}
