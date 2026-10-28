//! JSON-RPC 2.0 编解码 + stdio 行帧 —— 手写的协议层（**零新依赖**：只用 `serde_json`）。
//!
//! MCP 的 stdio 传输规定消息是**换行分隔的 JSON**（不是 LSP 的 `Content-Length` 头）。两个坑：
//!
//! - 一次 `read` 可能只拿到半条消息，也可能一次拿到好几条 → 必须有行缓冲（[`LineFramer`]）；
//! - 服务器可以（也应该）在**同一个流**上混发响应、通知、以及反向请求 → 三类必须分开识别，
//!   否则「工具的返回值」会被当成「服务器发来的通知」静默丢掉。
//!
//! 反向请求（`sampling/*` / `roots/*` / `elicitation/*`）本项目一律回 `MethodNotFound`：
//! 假装支持比明确拒绝更糟（模型会以为能力真的存在）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const JSONRPC_VERSION: &str = "2.0";

/// 单行上限：防「服务器吐一条没有换行的 100MB」把内存打爆
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

pub const CODE_PARSE_ERROR: i64 = -32700;
pub const CODE_INVALID_REQUEST: i64 = -32600;
pub const CODE_METHOD_NOT_FOUND: i64 = -32601;
pub const CODE_INVALID_PARAMS: i64 = -32602;
pub const CODE_INTERNAL_ERROR: i64 = -32603;

// ==================== 错误对象 ====================

/// JSON-RPC 错误对象（服务器返回的 `error` 字段）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    #[serde(default)]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(CODE_METHOD_NOT_FOUND, format!("Method not found: {method}"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_PARAMS, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CODE_INTERNAL_ERROR, message)
    }

    /// 给模型/日志看的一行摘要（服务器文案可能很长，截断到 300 字符）
    pub fn summary(&self) -> String {
        let message: String = self.message.chars().take(300).collect();
        if message.is_empty() {
            format!("JSON-RPC error {}", self.code)
        } else {
            format!("JSON-RPC error {}: {}", self.code, message)
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.summary())
    }
}

impl std::error::Error for RpcError {}

// ==================== 入站消息 ====================

/// 从服务器读到的三类消息之一。
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// 我们发出的请求的应答（`id` 只可能是我们自己生成的数字 id）
    Response { id: i64, result: Result<Value, RpcError> },
    /// 通知（无 `id`）：`notifications/tools/list_changed` / `notifications/message` …
    Notification { method: String, params: Value },
    /// 服务器反向请求（`id` 原样保留：回 `MethodNotFound` 时要逐字回传）
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
}

/// 一条消息解析失败的三种原因（都属协议级致命错误：调用方应断开连接）
#[derive(Debug, Clone, PartialEq)]
pub enum RpcParseError {
    NotJson(String),
    NotMessage(String),
    NonNumericId(Value),
}

impl std::fmt::Display for RpcParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcParseError::NotJson(reason) => write!(f, "invalid JSON: {reason}"),
            RpcParseError::NotMessage(reason) => write!(f, "not a JSON-RPC message: {reason}"),
            RpcParseError::NonNumericId(value) => {
                write!(f, "response id is not an integer: {value}")
            }
        }
    }
}

impl std::error::Error for RpcParseError {}

/// 把一个已解析的 JSON 值归类成 [`Incoming`]。
pub fn parse_message(value: Value) -> Result<Incoming, RpcParseError> {
    let Some(obj) = value.as_object() else {
        return Err(RpcParseError::NotMessage("message is not an object".into()));
    };
    let method = obj.get("method").and_then(Value::as_str);
    let params = || obj.get("params").cloned().unwrap_or_else(|| json!({}));

    match (obj.get("id"), method) {
        // 反向请求：有 method 也有 id（id 可能是字符串，必须原样回传）
        (Some(id), Some(method)) => Ok(Incoming::ServerRequest {
            id: id.clone(),
            method: method.to_string(),
            params: params(),
        }),
        // 应答：有 id、无 method
        (Some(id), None) => {
            let Some(id) = id.as_i64() else {
                return Err(RpcParseError::NonNumericId(id.clone()));
            };
            match obj.get("error") {
                Some(error) if !error.is_null() => {
                    let rpc: RpcError = serde_json::from_value(error.clone()).unwrap_or_else(|_| {
                        RpcError::internal("malformed error object from server")
                    });
                    Ok(Incoming::Response {
                        id,
                        result: Err(rpc),
                    })
                }
                _ => Ok(Incoming::Response {
                    id,
                    result: Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
                }),
            }
        }
        // 通知：只有 method
        (None, Some(method)) => Ok(Incoming::Notification {
            method: method.to_string(),
            params: params(),
        }),
        (None, None) => Err(RpcParseError::NotMessage(
            "message has neither id nor method".into(),
        )),
    }
}

// ==================== 编码 ====================

/// 请求 → 单行 JSON（末尾带 `\n`）。
pub fn encode_request(id: i64, method: &str, params: Value) -> String {
    encode_message(&json!({
        "jsonrpc": JSONRPC_VERSION,
        "id": id,
        "method": method,
        "params": params,
    }))
}

/// 通知 → 单行 JSON（无 `id`）。
pub fn encode_notification(method: &str, params: Value) -> String {
    encode_message(&json!({
        "jsonrpc": JSONRPC_VERSION,
        "method": method,
        "params": params,
    }))
}

/// 成功应答 → 单行 JSON。
pub fn encode_result(id: &Value, result: Value) -> String {
    encode_message(&json!({
        "jsonrpc": JSONRPC_VERSION,
        "id": id,
        "result": result,
    }))
}

/// 错误应答 → 单行 JSON。
pub fn encode_error(id: &Value, error: &RpcError) -> String {
    encode_message(&json!({
        "jsonrpc": JSONRPC_VERSION,
        "id": id,
        "error": error,
    }))
}

/// 序列化成**紧凑单行**（`serde_json` 默认不换行；这里只补行尾）。
fn encode_message(message: &Value) -> String {
    let mut text = serde_json::to_string(message).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text
}

// ==================== 行帧 ====================

/// 行缓冲错误（两种都是协议级致命：断开连接 + 上报原因）。
#[derive(Debug, Clone, PartialEq)]
pub enum FramerError {
    LineTooLong { limit: usize },
    Invalid(String),
}

impl std::fmt::Display for FramerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FramerError::LineTooLong { limit } => {
                write!(f, "server sent a line longer than {limit} bytes")
            }
            FramerError::Invalid(reason) => write!(f, "{reason}"),
        }
    }
}

impl std::error::Error for FramerError {}

/// 把字节流切成「一条一条的 JSON-RPC 消息」。
#[derive(Debug)]
pub struct LineFramer {
    buf: Vec<u8>,
    max_line_bytes: usize,
}

impl Default for LineFramer {
    fn default() -> Self {
        Self::new()
    }
}

impl LineFramer {
    pub fn new() -> Self {
        Self::with_max(MAX_LINE_BYTES)
    }

    pub fn with_max(max_line_bytes: usize) -> Self {
        Self {
            buf: Vec::new(),
            max_line_bytes: max_line_bytes.max(1),
        }
    }

    /// 喂一段字节，返回本次凑齐的完整消息（可能 0 条、1 条或多条）。
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Incoming>, FramerError> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            // `drain(..=pos)` 含换行符本身
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let text = std::str::from_utf8(&line[..line.len() - 1]).map_err(|e| {
                // 协议要求 stdio 必须 UTF-8；Windows 上 Python 服务端默认按 cp936 写 stdout，
                // 一天常见。把修复办法直接写进错误里（否者用户只能看到「协议错误」）。
                FramerError::Invalid(format!(
                    "line is not UTF-8: {e} — MCP stdio requires UTF-8 output; \
                     Python servers can set PYTHONIOENCODING=utf-8 (and PYTHONUTF8=1)"
                ))
            })?;
            let text = text.trim();
            if text.is_empty() {
                continue; // 空行 / 纯 \r：不是消息
            }
            let value: Value = serde_json::from_str(text).map_err(|e| {
                FramerError::Invalid(format!("invalid JSON from server: {e}"))
            })?;
            out.push(parse_message(value).map_err(|e| FramerError::Invalid(e.to_string()))?);
        }
        if self.buf.len() > self.max_line_bytes {
            return Err(FramerError::LineTooLong {
                limit: self.max_line_bytes,
            });
        }
        Ok(out)
    }

    /// 还没凑成一行的字节数（诊断用）
    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(value: Value) -> Vec<u8> {
        let mut s = serde_json::to_string(&value).unwrap();
        s.push('\n');
        s.into_bytes()
    }

    #[test]
    fn parses_a_result_response() {
        let mut framer = LineFramer::new();
        let msgs = framer
            .push(&line(json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}})))
            .unwrap();
        assert_eq!(
            msgs,
            vec![Incoming::Response {
                id: 7,
                result: Ok(json!({"ok": true})),
            }]
        );
    }

    #[test]
    fn parses_an_error_response() {
        let mut framer = LineFramer::new();
        let msgs = framer
            .push(&line(
                json!({"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"nope"}}),
            ))
            .unwrap();
        match &msgs[0] {
            Incoming::Response { id, result: Err(err) } => {
                assert_eq!(*id, 3);
                assert_eq!(err.code, -32601);
                assert!(err.summary().contains("nope"));
            }
            other => panic!("应为错误响应，实际 {other:?}"),
        }
    }

    #[test]
    fn parses_notifications_and_server_requests() {
        let mut framer = LineFramer::new();
        let msgs = framer
            .push(&line(
                json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),
            ))
            .unwrap();
        assert_eq!(
            msgs,
            vec![Incoming::Notification {
                method: "notifications/tools/list_changed".into(),
                params: json!({}),
            }]
        );

        let msgs = framer
            .push(&line(
                json!({"jsonrpc":"2.0","id":"srv-1","method":"sampling/createMessage","params":{"a":1}}),
            ))
            .unwrap();
        assert_eq!(
            msgs,
            vec![Incoming::ServerRequest {
                id: json!("srv-1"),
                method: "sampling/createMessage".into(),
                params: json!({"a": 1}),
            }]
        );
    }

    #[test]
    fn splits_partial_packets() {
        let mut framer = LineFramer::new();
        let bytes = line(json!({"jsonrpc":"2.0","id":1,"result":{}}));
        let (head, tail) = bytes.split_at(12);
        assert!(framer.push(head).unwrap().is_empty(), "半条消息不该产出");
        assert_eq!(framer.pending_bytes(), 12);
        let msgs = framer.push(tail).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(framer.pending_bytes(), 0);
    }

    #[test]
    fn handles_multiple_messages_in_one_chunk() {
        let mut framer = LineFramer::new();
        let mut bytes = line(json!({"jsonrpc":"2.0","id":1,"result":1}));
        bytes.extend(line(json!({"jsonrpc":"2.0","id":2,"result":2})));
        bytes.extend(line(
            json!({"jsonrpc":"2.0","method":"notifications/message","params":{}}),
        ));
        let msgs = framer.push(&bytes).unwrap();
        assert_eq!(msgs.len(), 3);
    }

    #[test]
    fn tolerates_crlf_and_blank_lines() {
        let mut framer = LineFramer::new();
        let mut bytes = b"\r\n".to_vec();
        bytes.extend(b"{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":null}\r\n");
        bytes.extend(b"\r\n");
        let msgs = framer.push(&bytes).unwrap();
        assert_eq!(
            msgs,
            vec![Incoming::Response {
                id: 9,
                result: Ok(Value::Null)
            }]
        );
    }

    #[test]
    fn rejects_garbage_and_bad_ids() {
        let mut framer = LineFramer::new();
        assert!(framer.push(b"not json\n").is_err());
        let mut framer = LineFramer::new();
        let err = framer
            .push(b"{\"jsonrpc\":\"2.0\",\"id\":\"str\",\"result\":1}\n")
            .unwrap_err();
        assert!(matches!(err, FramerError::Invalid(_)), "{err:?}");
        let mut framer = LineFramer::new();
        assert!(framer.push(b"{\"jsonrpc\":\"2.0\"}\n").is_err());
    }

    #[test]
    fn rejects_oversized_lines() {
        let mut framer = LineFramer::with_max(16);
        let err = framer.push(&[b'x'; 64]).unwrap_err();
        assert_eq!(err, FramerError::LineTooLong { limit: 16 });
    }

    #[test]
    fn encode_decode_round_trip() {
        let text = encode_request(42, "tools/list", json!({"cursor": "p2"}));
        assert!(text.ends_with('\n'));
        assert!(!text.trim_end().contains('\n'), "必须是单行");

        let mut framer = LineFramer::new();
        let msgs = framer.push(text.as_bytes()).unwrap();
        assert_eq!(
            msgs,
            vec![Incoming::ServerRequest {
                id: json!(42),
                method: "tools/list".into(),
                params: json!({"cursor": "p2"}),
            }]
        );
    }

    #[test]
    fn encode_error_echoes_original_id() {
        let text = encode_error(&json!("srv-1"), &RpcError::method_not_found("sampling/x"));
        let value: Value = serde_json::from_str(text.trim_end()).unwrap();
        assert_eq!(value["id"], "srv-1");
        assert_eq!(value["error"]["code"], CODE_METHOD_NOT_FOUND);
    }

    #[test]
    fn notification_has_no_id() {
        let text = encode_notification("notifications/initialized", json!({}));
        let value: Value = serde_json::from_str(text.trim_end()).unwrap();
        assert!(value.get("id").is_none());
    }
}
