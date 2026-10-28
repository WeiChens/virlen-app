//! Streamable HTTP 传输 —— 远端 MCP 服务器（POST + 可选 SSE），零新依赖（`reqwest` 已有 `stream` 特性）。
//!
//! 协议要点（`2025-06-18` 的 Streamable HTTP）：
//!
//! - 每个请求都是 `POST`，`Accept: application/json, text/event-stream`；
//! - 应答可能是**一个 JSON 体**，也可能是**一条 SSE 流**（流里可能先夹几条通知再给应答）；
//! - `initialize` 的响应头里带 `Mcp-Session-Id` → 后续请求必须回传；服务器回 `404` 表示会话失效
//!   （要重新握手，不是「服务器挂了」）；
//! - 服务端主动消息走**另一条 `GET`** 的 SSE 长连接（`Last-Event-ID` 断点续传）；服务器回 `405`
//!   表示不支持推送 —— 这时工具列表变化只能靠重连发现（如实上报，不假装支持）。
//!
//! ⚠️ `GET` 长连接**不能**设总超时（会按 `timeout` 掐断本该常驻的流）；只有 POST 带超时。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use super::{await_response, Core, Transport, TransportError};
use crate::mcp::config::HttpSpec;
use crate::mcp::jsonrpc::{self, Incoming};

/// 会话 id 头（握手响应下发）
pub const SESSION_HEADER: &str = "Mcp-Session-Id";
/// 协议版本头（握手完成后每个请求都带）
pub const PROTOCOL_VERSION_HEADER: &str = "Mcp-Protocol-Version";

/// 单次响应体上限：防止「服务器回一坨 100MB」把内存吃光
const MAX_HTTP_BODY: usize = 32 * 1024 * 1024;
/// SSE 事件缓冲上限（超了就当协议错误丢弃，不让内存无限涨）
const MAX_SSE_BUFFER: usize = 32 * 1024 * 1024;

/// 待应答的三元组：`(method, id, 接收端)` —— 抽成别名只为给 `clippy::type_complexity` 一个名字
pub(crate) type PendingResponse =
    (String, i64, tokio::sync::oneshot::Receiver<Result<Value, jsonrpc::RpcError>>);

pub struct HttpTransport {
    core: Arc<Core>,
    client: reqwest::Client,
    url: String,
    headers: BTreeMap<String, String>,
    session: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
    stream_task: AsyncMutex<Option<JoinHandle<()>>>,
    events: Mutex<Option<mpsc::UnboundedReceiver<Incoming>>>,
}

impl HttpTransport {
    pub fn new(spec: &HttpSpec) -> Result<Arc<Self>, TransportError> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("virlen/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| TransportError::Io(format!("创建 HTTP 客户端失败：{e}")))?;
        let (core, events) = Core::new();
        Ok(Arc::new(Self {
            core,
            client,
            url: spec.url.clone(),
            headers: spec.headers.clone(),
            session: Mutex::new(None),
            protocol_version: Mutex::new(None),
            stream_task: AsyncMutex::new(None),
            events: Mutex::new(Some(events)),
        }))
    }

    pub fn session_id(&self) -> Option<String> {
        self.session.lock().ok().and_then(|guard| guard.clone())
    }

    /// 放弃当前会话（服务器回 404 / 需要重新 `initialize` 时）
    pub fn clear_session(&self) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = None;
        }
    }

    /// 把公共头（会话 id / 协议版本 / 用户配置的 headers）贴到请求上。
    fn apply_common_headers(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(session) = self.session_id() {
            request = request.header(SESSION_HEADER, session);
        }
        if let Some(version) = self.protocol_version.lock().ok().and_then(|g| g.clone()) {
            request = request.header(PROTOCOL_VERSION_HEADER, version);
        }
        for (key, value) in &self.headers {
            request = request.header(key, value);
        }
        request
    }

    /// 发一个 POST 并取回应答（含会话 id 捕获与非 2xx 归类）。
    async fn post(&self, body: String, timeout: Duration) -> Result<reqwest::Response, TransportError> {
        let request = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .timeout(timeout)
            .body(body);
        let response = self
            .apply_common_headers(request)
            .send()
            .await
            .map_err(|e| TransportError::Io(format!("MCP HTTP 请求失败：{e}")))?;

        if let Some(session) = response
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            if let Ok(mut guard) = self.session.lock() {
                *guard = Some(session.to_string());
            }
        }

        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        let body: String = body.chars().take(2000).collect();
        // 404 是「会话过期」的约定信号（服务器重启 / TTL），客户端要重新握手
        Err(TransportError::Http {
            status: status.as_u16(),
            body,
        })
    }

    /// 消费一次 POST 的应答：JSON 体或 SSE 流，最后等到自己的应答。
    async fn consume(
        &self,
        response: reqwest::Response,
        pending: Option<PendingResponse>,
        timeout: Duration,
    ) -> Result<Value, TransportError> {
        let is_sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase().contains("text/event-stream"))
            .unwrap_or(false);

        if !is_sse {
            let bytes = response
                .bytes()
                .await
                .map_err(|e| TransportError::Io(format!("读取 MCP 响应失败：{e}")))?;
            if bytes.len() > MAX_HTTP_BODY {
                return Err(TransportError::Protocol(format!(
                    "response body too large ({} bytes)",
                    bytes.len()
                )));
            }
            if !bytes.is_empty() {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    match jsonrpc::parse_message(value) {
                        Ok(message) => self.core.dispatch(message),
                        Err(e) => {
                            return Err(TransportError::Protocol(e.to_string()));
                        }
                    }
                }
                // 空体（202 Accepted）也是合法回应：通知/无结果
            }
            return match pending {
                Some((method, id, receiver)) => {
                    await_response(&self.core, id, &method, timeout, receiver).await
                }
                None => Ok(Value::Null),
            };
        }

        // SSE：流里先到的可能是通知，最后才是我要的那条应答
        let mut response = response;
        let mut decoder = SseDecoder::new();
        let Some((method, id, mut receiver)) = pending else {
            // 通知的 SSE 应答：把流读干（通常会立刻关闭）
            while let Ok(Some(bytes)) = response.chunk().await {
                dispatch_sse_chunk(&self.core, &mut decoder, &bytes);
            }
            return Ok(Value::Null);
        };

        loop {
            tokio::select! {
                biased;
                result = &mut receiver => {
                    return match result {
                        Ok(Ok(value)) => Ok(value),
                        Ok(Err(rpc)) => Err(TransportError::Rpc(rpc)),
                        Err(_) => Err(TransportError::Closed),
                    };
                }
                chunk = response.chunk() => {
                    match chunk {
                        Ok(Some(bytes)) => dispatch_sse_chunk(&self.core, &mut decoder, &bytes),
                        Ok(None) => break,
                        Err(e) => return Err(TransportError::Io(format!("读取 MCP 事件流失败：{e}"))),
                    }
                }
            }
        }
        // 流结束了但应答还没到（服务器提前关流）：继续等到超时，别静默成功
        await_response(&self.core, id, &method, timeout, receiver).await
    }
}

/// 解一段 SSE 字节并分派（两种消费路径共用）。
fn dispatch_sse_chunk(core: &Core, decoder: &mut SseDecoder, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    for payload in decoder.push(&text) {
        match serde_json::from_str::<Value>(&payload) {
            Ok(value) => match jsonrpc::parse_message(value) {
                Ok(message) => core.dispatch(message),
                Err(e) => eprintln!("[mcp] http：SSE 消息不合法（已忽略）：{e}"),
            },
            Err(e) => eprintln!("[mcp] http：SSE 载荷不是 JSON（已忽略）：{e}"),
        }
    }
}

/// GET 长连接的读循环（服务端主动消息）。
async fn pump_event_stream(core: Arc<Core>, mut response: reqwest::Response) {
    let mut decoder = SseDecoder::new();
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => dispatch_sse_chunk(&core, &mut decoder, &bytes),
            Ok(None) => break,
            Err(e) => {
                eprintln!("[mcp] http：事件流中断：{e}");
                break;
            }
        }
    }
    // 主动推送通道断了不代表请求通道不可用（下次请求会自己报错）
    eprintln!("[mcp] http：服务端事件流结束");
}

#[async_trait]
impl Transport for HttpTransport {
    fn kind(&self) -> &'static str {
        "http"
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, TransportError> {
        if self.is_closed() {
            return Err(TransportError::Closed);
        }
        let id = self.core.next_id();
        let receiver = self.core.expect(id);
        let body = jsonrpc::encode_request(id, method, params);
        let response = match self.post(body, timeout).await {
            Ok(response) => response,
            Err(e) => {
                self.core.forget(id);
                return Err(e);
            }
        };
        self.consume(response, Some((method.to_string(), id, receiver)), timeout)
            .await
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        if self.is_closed() {
            return Err(TransportError::Closed);
        }
        let body = jsonrpc::encode_notification(method, params);
        let response = self.post(body, Duration::from_secs(30)).await?;
        self.consume(response, None, Duration::from_secs(30)).await?;
        Ok(())
    }

    async fn close(&self) {
        if let Some(handle) = self.stream_task.lock().await.take() {
            handle.abort();
        }
        // 规范允许 DELETE 显式结束会话；服务器不一定支持，且我们本地已关，不做也无害
        self.core.close();
    }

    fn is_closed(&self) -> bool {
        self.core.is_closed()
    }

    async fn wait_closed(&self) {
        self.core.wait_closed().await;
    }

    fn take_events(&self) -> Option<mpsc::UnboundedReceiver<Incoming>> {
        self.events.lock().ok().and_then(|mut slot| slot.take())
    }

    fn set_protocol_version(&self, version: &str) {
        if let Ok(mut guard) = self.protocol_version.lock() {
            *guard = Some(version.to_string());
        }
    }

    async fn start_event_stream(&self) -> Result<bool, TransportError> {
        if self.is_closed() {
            return Err(TransportError::Closed);
        }
        let mut request = self
            .client
            .get(&self.url)
            .header("accept", "text/event-stream")
            // 长连接不设总超时（见文件头）
            .header("cache-control", "no-cache");
        request = self.apply_common_headers(request);
        let response = match request.send().await {
            Ok(response) => response,
            // 推送通道建不起来不该让整个连接失败
            Err(e) => {
                eprintln!("[mcp] http：事件流建立失败（忽略）：{e}");
                return Ok(false);
            }
        };
        let status = response.status();
        if status == reqwest::StatusCode::METHOD_NOT_ALLOWED
            || status == reqwest::StatusCode::NOT_FOUND
            || status == reqwest::StatusCode::NOT_IMPLEMENTED
        {
            return Ok(false);
        }
        if !status.is_success() {
            eprintln!("[mcp] http：事件流被拒绝（{status}），工具列表变化只能靠重连发现");
            return Ok(false);
        }
        let core = Arc::clone(&self.core);
        let handle = tokio::spawn(async move { pump_event_stream(core, response).await });
        *self.stream_task.lock().await = Some(handle);
        Ok(true)
    }

    async fn reply_error(
        &self,
        id: &Value,
        error: &jsonrpc::RpcError,
    ) -> Result<(), TransportError> {
        if self.is_closed() {
            return Err(TransportError::Closed);
        }
        // 反向请求的应答就是一条普通消息（无 id 的 POST）
        let body = jsonrpc::encode_error(id, error);
        let response = self.post(body, Duration::from_secs(30)).await?;
        self.consume(response, None, Duration::from_secs(30)).await?;
        Ok(())
    }
}

// ==================== SSE 解析 ====================

/// 最小 SSE 解码器：只关心 `data:` 行，事件以空行分隔。
///
/// 不做「重连 / Last-Event-ID 续传」——那属于监督器的重连策略（P1），不是解码器的事。
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一段文本，返回本次凑齐的事件载荷（每个事件一个字符串，`data:` 多行用 `\n` 连接）。
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        if self.buffer.len() > MAX_SSE_BUFFER {
            // 服务器在灌垃圾：丢掉缓冲，让上层超时兜底
            self.buffer.clear();
            return Vec::new();
        }
        let mut out = Vec::new();
        while let Some(event) = self.take_event() {
            let data = collect_data(&event);
            if !data.is_empty() {
                out.push(data);
            }
        }
        out
    }

    /// 取下一个完整事件（`\n\n` 或 `\r\n\r\n` 分隔）
    fn take_event(&mut self) -> Option<String> {
        let (index, end) = {
            let lf = self.buffer.find("\n\n").map(|i| (i, i + 2));
            let crlf = self.buffer.find("\r\n\r\n").map(|i| (i, i + 4));
            match (lf, crlf) {
                // 两种都命中时取更靠前的那个（`\r\n\r\n` 的 `\n\n` 位置偏后）
                (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            }?
        };
        let event = self.buffer[..index].to_string();
        self.buffer.drain(..end);
        Some(event)
    }
}

/// 一个事件里的 `data:` 行（多行按规范用 `\n` 拼接）
fn collect_data(event: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in event.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(rest) = line.strip_prefix("data:") else {
            continue; // `event:` / `id:` / 注释行（`:` 开头）一律忽略
        };
        lines.push(rest.strip_prefix(' ').unwrap_or(rest));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // ==================== SSE 解码 ====================

    #[test]
    fn sse_extracts_single_event() {
        let mut decoder = SseDecoder::new();
        let out = decoder.push("data: {\"jsonrpc\":\"2.0\"}\n\n");
        assert_eq!(out, vec!["{\"jsonrpc\":\"2.0\"}".to_string()]);
    }

    #[test]
    fn sse_handles_partial_and_crlf() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("data: {\"a\":").is_empty());
        let out = decoder.push("1}\r\n\r\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn sse_joins_multiline_data_and_ignores_other_fields() {
        let mut decoder = SseDecoder::new();
        let out = decoder.push("event: message\nid: 3\ndata: line1\ndata: line2\n\n");
        assert_eq!(out, vec!["line1\nline2".to_string()]);
    }

    #[test]
    fn sse_skips_events_without_data() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(": keep-alive\n\n").is_empty());
        let out = decoder.push("data: x\n\n");
        assert_eq!(out, vec!["x".to_string()]);
    }

    // ==================== HTTP 夹具 ====================

    /// 起一个「一个请求一个响应」的最小 HTTP 服务器（响应固定带 `Connection: close`）。
    async fn serve(
        respond: impl Fn(&str, &str) -> String + Send + Sync + 'static,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut raw: Vec<u8> = Vec::new();
                let mut buffer = [0u8; 4096];
                let header_end = loop {
                    let read = match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => read,
                    };
                    raw.extend_from_slice(&buffer[..read]);
                    if let Some(pos) = find_subsequence(&raw, b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
                let content_length = head
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        if key.eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                while raw.len() < header_end + content_length {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => raw.extend_from_slice(&buffer[..read]),
                    }
                }
                let body = String::from_utf8_lossy(
                    &raw[header_end..(header_end + content_length).min(raw.len())],
                )
                .to_string();
                let response = respond(&head, &body);
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{addr}/mcp")
    }

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn json_response(body: &str, extra_headers: &str) -> String {
        // ⚠️ `extra_headers` 自带行尾 `\r\n`：再补一个就会提前结束头块（body 会被当成头部），
        // 客户端按 content-length 截断后拿到的是半截 JSON —— 表现是「超时」而非「解析失败」。
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{extra_headers}connection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// 从请求体里取出 `id`（夹具要按 id 回包）
    fn request_id(body: &str) -> u64 {
        let value: Value = serde_json::from_str(body).expect("请求体是 JSON");
        value["id"].as_u64().expect("请求带数字 id")
    }

    #[tokio::test]
    async fn http_json_response_round_trip() {
        let url = serve(|_head, body| {
            let id = request_id(body);
            json_response(
                &json!({"jsonrpc":"2.0","id":id,"result":{"ok":true}}).to_string(),
                "mcp-session-id: sess-1\r\n",
            )
        })
        .await;

        let transport = HttpTransport::new(&HttpSpec {
            url,
            headers: BTreeMap::new(),
        })
        .unwrap();
        let value = transport
            .request("ping", json!({}), Duration::from_secs(5))
            .await
            .expect("请求应成功");
        assert_eq!(value, json!({"ok": true}));
        assert_eq!(transport.session_id().as_deref(), Some("sess-1"));
    }

    #[tokio::test]
    async fn http_sse_response_delivers_notification_first() {
        let url = serve(|_head, body| {
            let id = request_id(body);
            let payload = format!(
                "data: {}\n\ndata: {}\n\n",
                json!({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}),
                json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"ok"}]}})
            );
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            )
        })
        .await;

        let transport = HttpTransport::new(&HttpSpec {
            url,
            headers: BTreeMap::new(),
        })
        .unwrap();
        let mut events = transport.take_events().expect("事件接收端只能取一次");
        let value = transport
            .request("tools/call", json!({"name":"echo","arguments":{}}), Duration::from_secs(5))
            .await
            .expect("SSE 应答应成功");
        assert_eq!(value["content"][0]["text"], "ok");

        let event = events.try_recv().expect("应先收到一条通知");
        match event {
            Incoming::Notification { method, .. } => {
                assert_eq!(method, "notifications/message");
            }
            other => panic!("应为通知，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_error_status_is_reported() {
        let url = serve(|_head, _body| {
            "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 4\r\nconnection: close\r\n\r\nboom"
                .to_string()
        })
        .await;
        let transport = HttpTransport::new(&HttpSpec {
            url,
            headers: BTreeMap::new(),
        })
        .unwrap();
        let error = transport
            .request("ping", json!({}), Duration::from_secs(5))
            .await
            .expect_err("500 应报错");
        match error {
            TransportError::Http { status, body } => {
                assert_eq!(status, 500);
                assert!(body.contains("boom"));
            }
            other => panic!("应为 Http 错误，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_session_id_is_replayed_on_next_request() {
        // 服务器把每次请求看到的会话头记下来：第一次必空、第二次必是第一次下发的 id
        let seen = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let seen_for_server = Arc::clone(&seen);
        let url = serve(move |head, body| {
            let id = request_id(body);
            let session = head.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                if key.eq_ignore_ascii_case("mcp-session-id") {
                    Some(value.trim().to_string())
                } else {
                    None
                }
            });
            seen_for_server.lock().unwrap().push(session);
            json_response(
                &json!({"jsonrpc":"2.0","id":id,"result":{}}).to_string(),
                "mcp-session-id: sess-2\r\n",
            )
        })
        .await;
        let transport = HttpTransport::new(&HttpSpec {
            url,
            headers: BTreeMap::new(),
        })
        .unwrap();
        transport
            .request("initialize", json!({}), Duration::from_secs(5))
            .await
            .expect("第一次请求");
        transport
            .request("tools/list", json!({}), Duration::from_secs(5))
            .await
            .expect("第二次请求");
        let sessions = seen.lock().unwrap().clone();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0], None, "握手请求还没有会话 id");
        assert_eq!(sessions[1].as_deref(), Some("sess-2"), "后续请求必须回传会话 id");
    }
}
