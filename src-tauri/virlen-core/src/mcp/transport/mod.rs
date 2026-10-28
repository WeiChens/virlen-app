//! 传输层契约 —— `Transport` + 两种传输共用的「id 关联 / 事件队列 / 关闭信号」。
//!
//! 两种传输的通信形态完全不同（stdio 是一条长连接；HTTP 是「一次请求一格响应」），但客户端
//! 只关心四件事：发请求等应答、发通知、收服务器主动消息、关闭。所以：
//!
//! - 每个传输自己起**读任务**，把读到的消息交给 [`Core::dispatch`]；
//! - `Core` 负责「按 id 把应答还给等待者」+「把通知/反向请求塞进事件队列」；
//! - 关闭是**单向且幂等**的：先置位再唤醒，未应答的请求立刻以 [`TransportError::Closed`] 失败
//!   （不能等到超时 —— 用户点了停止还要等 60s 是最难受的体验）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, Notify};

use crate::mcp::jsonrpc::{Incoming, RpcError};

pub mod http;
pub mod stdio;

pub use http::HttpTransport;
pub use stdio::StdioTransport;

// ==================== 错误 ====================

/// 传输级失败（每一种都要能直接翻译成「给模型看的一句英文」）。
#[derive(Debug, Clone, PartialEq)]
pub enum TransportError {
    /// 起子进程失败（命令不存在 / 权限不足 / 工作目录不存在）
    Spawn(String),
    /// 读写管道 / 网络 IO 失败
    Io(String),
    /// 连接已关闭（进程退出、HTTP 断开、主动 dispose）
    Closed,
    /// 等应答超时
    Timeout { method: String, ms: u64 },
    /// 协议违反（版本不匹配、工具重名、无效结果……）
    Protocol(String),
    /// HTTP 非 2xx
    Http { status: u16, body: String },
    /// 服务器返回的 JSON-RPC 错误对象
    Rpc(RpcError),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Spawn(reason) => write!(f, "failed to start MCP server: {reason}"),
            TransportError::Io(reason) => write!(f, "MCP transport I/O error: {reason}"),
            TransportError::Closed => write!(f, "MCP connection is closed"),
            TransportError::Timeout { method, ms } => {
                write!(f, "MCP request `{method}` timed out after {ms} ms")
            }
            TransportError::Protocol(reason) => write!(f, "MCP protocol error: {reason}"),
            TransportError::Http { status, body } => {
                write!(f, "MCP HTTP error {status}: {body}")
            }
            TransportError::Rpc(err) => write!(f, "{}", err.summary()),
        }
    }
}

impl std::error::Error for TransportError {}

// ==================== 共用内核 ====================

/// 待应答表 + 事件出口 + 关闭信号。两种传输各持一个，避免把 id 关联逻辑写两遍。
pub(crate) struct Core {
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>,
    events: mpsc::UnboundedSender<Incoming>,
    closed: AtomicBool,
    close_notify: Notify,
}

impl Core {
    /// 返回 `(core, 事件接收端)`；接收端由客户端（`Client`）持有。
    pub(crate) fn new() -> (Arc<Core>, mpsc::UnboundedReceiver<Incoming>) {
        let (events, receiver) = mpsc::unbounded_channel();
        let core = Arc::new(Self {
            next_id: AtomicI64::new(0),
            pending: Mutex::new(HashMap::new()),
            events,
            closed: AtomicBool::new(false),
            close_notify: Notify::new(),
        });
        (core, receiver)
    }

    pub(crate) fn next_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 登记「我在等这个 id」（必须在发出去之前登记：服务器可能回得比我们返回还快）
    pub(crate) fn expect(&self, id: i64) -> oneshot::Receiver<Result<Value, RpcError>> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        rx
    }

    /// 超时后摘掉等待位（否则迟到的应答会打到已失效的 sender 上，内存慢慢涨）
    pub(crate) fn forget(&self, id: i64) {
        self.pending.lock().unwrap().remove(&id);
    }

    /// 分派一条入站消息：应答还给等待者，其余进事件队列。
    pub(crate) fn dispatch(&self, message: Incoming) {
        match message {
            Incoming::Response { id, result } => {
                let sender = self.pending.lock().unwrap().remove(&id);
                if let Some(tx) = sender {
                    let _ = tx.send(result);
                }
                // 迟到的应答（已超时/已放弃）静默丢弃：MCP 允许服务器晚回
            }
            other => {
                let _ = self.events.send(other);
            }
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 置为关闭并唤醒所有等待者（幂等）。
    ///
    /// 未应答的请求**直接 drop sender** → 等待方收到 `RecvError` → 归为 [`TransportError::Closed`]。
    pub(crate) fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.pending.lock().unwrap().clear();
        self.close_notify.notify_waiters();
    }

    pub(crate) async fn wait_closed(&self) {
        loop {
            if self.is_closed() {
                return;
            }
            let notified = self.close_notify.notified();
            if self.is_closed() {
                return;
            }
            notified.await;
        }
    }
}

/// 等一次应答（`request` 的公共尾巴）。
pub(crate) async fn await_response(
    core: &Core,
    id: i64,
    method: &str,
    timeout: Duration,
    receiver: oneshot::Receiver<Result<Value, RpcError>>,
) -> Result<Value, TransportError> {
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(rpc))) => Err(TransportError::Rpc(rpc)),
        Ok(Err(_dropped)) => Err(TransportError::Closed),
        Err(_elapsed) => {
            core.forget(id);
            Err(TransportError::Timeout {
                method: method.to_string(),
                ms: timeout.as_millis() as u64,
            })
        }
    }
}

// ==================== 契约 ====================

/// 一条 MCP 连接的最小能力集（客户端只依赖这四个方法）。
#[async_trait]
pub trait Transport: Send + Sync {
    /// `"stdio"` / `"http"`（诊断与埋点用）
    fn kind(&self) -> &'static str;

    /// 发请求等应答（`timeout` 由调用方给：`tools/call` 与 `initialize` 的口径不同）
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, TransportError>;

    /// 发通知（不需要应答）
    async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError>;

    /// 取走「服务器主动消息」的接收端（只能取一次；`Client::connect` 会拿走）。
    /// 返回 `None` = 已经被取走。
    fn take_events(&self) -> Option<mpsc::UnboundedReceiver<Incoming>>;

    /// 握手后告知协商到的协议版本（HTTP 要写进每个请求的 header；stdio 忽略）。
    fn set_protocol_version(&self, _version: &str) {}

    /// 开服务端主动消息通道（HTTP 的 `GET` SSE）。stdio 没这个概念 → 默认 `Ok(false)`；
    /// `false` 只表示「不支持推送」，不是连接失败。
    async fn start_event_stream(&self) -> Result<bool, TransportError> {
        Ok(false)
    }

    /// 服务器自身输出的尾部（只给 UI 诊断；**绝不进模型上下文 / 埋点正文**）。
    /// stdio 覆写成子进程 stderr 的环；HTTP 没有这种概念 → `None`。
    fn stderr_tail(&self) -> Option<String> {
        None
    }

    /// 回服务器一个错误对象。
    ///
    /// ⚠️ 协议要求反向请求（`sampling/*` / `roots/*` / `elicitation/*`）**必须应答**，
    /// 不能装死 —— 服务器会一直等（P0 统一回 `MethodNotFound`）。
    async fn reply_error(&self, id: &Value, error: &RpcError) -> Result<(), TransportError>;

    /// 主动关闭（幂等）
    async fn close(&self);

    fn is_closed(&self) -> bool;

    /// 等连接关闭（监督器用它触发重连）
    async fn wait_closed(&self);
}
