//! 单台 MCP 服务器的**连接监督器** —— 一台服务器 = 一个常驻任务。
//!
//! 它负责一台服务器的全部生命周期语义（协议细节在 `client.rs`，语义在这里）：
//!
//! ```text
//!    disabled ─(enabled / approval=deny)─┐
//!        │                               │
//!        ▼                               │
//!   connecting ──ok──► ready ──断开──► backoff ──预算耗尽──► failed
//!        │              ▲  │                                 │
//!        └──fail────────┘  └──list_changed / 手动 reload──┘（手动重连）
//! ```
//!
//! 三条不变量（与 `mcp/mod.rs` 文件头对齐）：
//! 1. **一个服务器的工具要么整批生效、要么一个都不注册**：先把 `tools/list` 全部取完，再整体发布；
//!    同步失败**保留上一世代**（断链期间模型仍看得到工具，调用会失败并如实报错）。
//! 2. **同步串行**：首次同步 / `list_changed` / 重连全在同一个任务里顺序执行 —— 两次同步交错会
//!    「先 dispose 别人的世代、再注册自己的」，出现半套工具（dsh 在这点上踩过，照抄结论）。
//! 3. **预算要能重置**：连接稳定存活超过 `maxDelayMs` 后再断，重连计数清零
//!    （否则「偶尔抖一下」迟早把 10 次预算耗光，服务器永久黑掉）。

use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc;

use super::client::{Client, McpTool};
use super::config::{McpApproval, McpServerConfig, McpTransport};
use super::host::{McpCallOutcome, McpServerState, McpServerStatus, McpToolInfo};
use super::jsonrpc::Incoming;
use super::resources::{McpResourceListing, McpResourceRead};
use super::results;
use super::schema;
use super::transport::{HttpTransport, StdioTransport, Transport, TransportError};
use crate::agent::cancellation::CancellationToken;
use crate::agent::types::{ToolDefinition, ToolParameters};

/// `tools/call` 参数上限：超了**不打给服务器**（一个 100MB 的参数只会被服务器拒绝或把内存吃光）
const MAX_ARGS_BYTES: usize = 256 * 1024;

/// 关闭时等监督任务收尾的上限（超过就放弃 —— 退出不能被一台卡死的服务器拖住）
const DISPOSE_TIMEOUT: Duration = Duration::from_secs(3);

/// 服务器内容更新通知（协议方法名）
const NOTIFICATION_TOOLS_CHANGED: &str = "notifications/tools/list_changed";

// ==================== 已发布的工具 ====================

/// 一个已发布（模型可见）的工具：公开名 ↔ 服务器原始名 ↔ 定义。
#[derive(Debug, Clone)]
pub(crate) struct PublishedTool {
    pub public_name: String,
    pub raw_name: String,
    pub info: McpToolInfo,
    pub definition: ToolDefinition,
}

// ==================== 运行态 ====================

#[derive(Debug, Clone)]
struct RuntimeStatus {
    state: McpServerState,
    attempt: Option<u32>,
    last_error: Option<String>,
    connected_at: Option<i64>,
    server_name: Option<String>,
    server_version: Option<String>,
    stderr_tail: Option<String>,
    /// 服务器说明书（只在 `injectInstructions` 打开且非空时保存）
    instructions: Option<String>,
    /// 是否声明了 resources 能力（没声明的服务器不查资源）
    supports_resources: bool,
    /// 断链后退避重连的次数（跨「就绪」保留，供设置页展示）
    reconnect_count: u32,
}

impl RuntimeStatus {
    fn new(state: McpServerState) -> Self {
        Self {
            state,
            attempt: None,
            last_error: None,
            connected_at: None,
            server_name: None,
            server_version: None,
            stderr_tail: None,
            instructions: None,
            supports_resources: false,
            reconnect_count: 0,
        }
    }
}

/// 监督任务收到的指令（唯一入口 —— 不在任务内改状态就不会有竞态）
enum Command {
    /// 重新列一遍工具（`tools/list`，世代原子交换）
    Sync,
    /// 断开重连（设置页「重连」/ 配置变更后由 manager 触发）
    Reconnect,
    /// 关掉：不重连、杀进程树
    Shutdown,
}

// ==================== 单台服务器 ====================

pub(crate) struct ServerRuntime {
    cfg: McpServerConfig,
    status: Mutex<RuntimeStatus>,
    /// 当前**活的**连接（断开后置空，但工具保留到下一世代）
    client: RwLock<Option<Arc<Client>>>,
    /// 最近一世代工具（`failed` 时才清空）
    tools: RwLock<Vec<PublishedTool>>,
    /// 同一世代的**完整**工具清单（**不**按 `enabledTools` 裁剪）：设置页编辑弹窗回填勾选用。
    ///
    /// ⚠️ 不能直接拿 `tools` 当候选：它已被白名单裁过，被排除的工具就再也勾不回来了。
    all_tools: RwLock<Vec<McpToolInfo>>,
    cmd_tx: mpsc::UnboundedSender<Command>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 任何状态 / 工具变化都调一次（manager 重算快照 + 发事件）
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl ServerRuntime {
    /// 建一台服务器的运行态（**不**起任务：`spawn` 必须在 tokio 上下文里调）
    fn new(cfg: McpServerConfig, on_change: Arc<dyn Fn() + Send + Sync>) -> (Arc<Self>, mpsc::UnboundedReceiver<Command>) {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        // 初始状态在**构造时**就定下来：否则「禁用 / deny」的服务器会先闪一下 connecting
        // （监督任务还没被调度），设置页与快照都会看到一个抖动
        let initial = if config_allows_connection(&cfg) {
            McpServerState::Connecting
        } else {
            McpServerState::Disabled
        };
        let runtime = Arc::new(Self {
            cfg,
            status: Mutex::new(RuntimeStatus::new(initial)),
            client: RwLock::new(None),
            tools: RwLock::new(Vec::new()),
            all_tools: RwLock::new(Vec::new()),
            cmd_tx,
            task: Mutex::new(None),
            on_change,
        });
        (runtime, cmd_rx)
    }

    /// 起监督任务（返回句柄给 manager 存着，`dispose` 时等它收尾）
    pub(crate) fn spawn(
        cfg: McpServerConfig,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        let (runtime, cmd_rx) = Self::new(cfg, on_change);
        let supervisor = runtime.clone();
        let handle = tokio::spawn(async move { supervise(supervisor, cmd_rx).await });
        *runtime.task.lock().unwrap() = Some(handle);
        runtime
    }

    // ==================== 只读快照（同步，绝不等待连接） ====================

    pub(crate) fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .unwrap()
            .iter()
            .map(|tool| tool.definition.clone())
            .collect()
    }

    pub(crate) fn tool_infos(&self) -> Vec<McpToolInfo> {
        self.tools
            .read()
            .unwrap()
            .iter()
            .map(|tool| tool.info.clone())
            .collect()
    }

    /// 服务器提供的完整工具清单（不受 `enabledTools` 裁剪）—— 设置页编辑弹窗靠它回填勾选
    pub(crate) fn all_tool_infos(&self) -> Vec<McpToolInfo> {
        self.all_tools.read().unwrap().clone()
    }

    pub(crate) fn status(&self) -> McpServerStatus {
        let runtime = self.status.lock().unwrap().clone();
        let tools = self.tool_infos();
        McpServerStatus {
            id: self.cfg.id.clone(),
            name: self.cfg.name.clone(),
            transport: self.cfg.transport.kind().to_string(),
            state: runtime.state,
            tool_count: tools.len(),
            tools,
            all_tools: self.all_tool_infos(),
            server_name: runtime.server_name,
            server_version: runtime.server_version,
            connected_at: runtime.connected_at,
            last_error: runtime.last_error,
            attempt: runtime.attempt,
            max_attempts: (runtime.state == McpServerState::Backoff)
                .then_some(self.cfg.reconnect.max_attempts),
            stderr_tail: runtime.stderr_tail,
            reconnect_count: runtime.reconnect_count,
        }
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.status.lock().unwrap().state == McpServerState::Ready
    }

    /// 要注入系统提示词的说明书（未就绪 / 未开启注入 / 内容为空 → `None`）
    pub(crate) fn instructions(&self) -> Option<String> {
        let status = self.status.lock().unwrap();
        if status.state != McpServerState::Ready {
            return None;
        }
        status.instructions.clone()
    }

    /// 是否可以向它查资源（未就绪 / 没声明能力 → 不查，否则只会拿到 -32601）
    pub(crate) fn supports_resources(&self) -> bool {
        let status = self.status.lock().unwrap();
        status.state == McpServerState::Ready && status.supports_resources
    }

    /// 配置（manager 重建快照 / 判定「配置有没有变」时用）
    pub(crate) fn config(&self) -> &McpServerConfig {
        &self.cfg
    }

    // ==================== 调用 ====================

    /// 调一个工具（`public_name` 只用于结果投影；`raw_name` 才是发给服务器的名字）
    pub(crate) async fn call(
        &self,
        public_name: &str,
        raw_name: &str,
        arguments: Value,
        cancel: Option<&CancellationToken>,
    ) -> McpCallOutcome {
        // 参数上限：先挡在本地，别让服务器替我们做输入校验
        let args_bytes = serde_json::to_string(&arguments).map(|s| s.len()).unwrap_or(0);
        if args_bytes > MAX_ARGS_BYTES {
            return McpCallOutcome::error(format!(
                "MCP call rejected ({}.{}): arguments are {} KB, above the {} KB limit",
                self.cfg.name,
                raw_name,
                args_bytes.div_ceil(1024),
                MAX_ARGS_BYTES / 1024
            ));
        }

        let client = self.client.read().unwrap().clone();
        let Some(client) = client else {
            return McpCallOutcome::error(format!(
                "MCP server \"{}\" is not connected ({}); reopen the server in Settings and retry",
                self.cfg.name,
                self.status.lock().unwrap().state.as_str()
            ));
        };

        let future = client.call_tool(raw_name, arguments, self.cfg.tool_call_timeout());
        let result = match cancel {
            Some(token) => tokio::select! {
                _ = token.cancelled() => return McpCallOutcome::cancelled(),
                result = future => result,
            },
            None => future.await,
        };

        match result {
            Ok(result) => results::project(&self.cfg.name, public_name, raw_name, result),
            Err(TransportError::Closed) => McpCallOutcome::error(format!(
                "MCP call failed ({}.{raw_name}): connection closed",
                self.cfg.name
            )),
            Err(error) => McpCallOutcome::error(format!(
                "MCP call failed ({}.{raw_name}): {error}",
                self.cfg.name
            )),
        }
    }

    // ==================== 资源（P3） ====================

    /// 列资源（`resources/list`）。
    ///
    /// 失败**不**是异常：返回一条带 `error` 的清单，让模型看到「哪台服务器、为什么」。
    pub(crate) async fn list_resources(
        &self,
        cancel: Option<&CancellationToken>,
    ) -> McpResourceListing {
        let state = self.status.lock().unwrap().state.as_str();
        let client = self.client.read().unwrap().clone();
        let Some(client) = client else {
            return McpResourceListing::failed(
                &self.cfg.name,
                state,
                format!(
                    "MCP server \"{}\" is not connected ({state}); reopen it in Settings and retry",
                    self.cfg.name
                ),
            );
        };
        if !self.supports_resources() {
            return McpResourceListing::failed(
                &self.cfg.name,
                state,
                format!(
                    "MCP server \"{}\" does not expose resources (no `resources` capability)",
                    self.cfg.name
                ),
            );
        }

        let future = client.list_resources(self.cfg.tool_call_timeout());
        let result = match cancel {
            Some(token) => tokio::select! {
                _ = token.cancelled() => return McpResourceListing::failed(&self.cfg.name, state, "[User cancelled]"),
                result = future => result,
            },
            None => future.await,
        };
        match result {
            Ok(resources) => McpResourceListing {
                server: self.cfg.name.clone(),
                state: state.to_string(),
                resources,
                error: None,
            },
            Err(error) => McpResourceListing::failed(
                &self.cfg.name,
                state,
                format!("MCP resources/list failed ({}): {error}", self.cfg.name),
            ),
        }
    }

    /// 读一个资源（`resources/read`）。失败带可行动文案（未连接 / 未声明能力 / 协议错）。
    pub(crate) async fn read_resource(
        &self,
        uri: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<McpResourceRead, String> {
        let state = self.status.lock().unwrap().state.as_str();
        let client = self.client.read().unwrap().clone();
        let Some(client) = client else {
            return Err(format!(
                "MCP server \"{}\" is not connected ({state}); reopen it in Settings and retry",
                self.cfg.name
            ));
        };
        if !self.supports_resources() {
            return Err(format!(
                "MCP server \"{}\" does not expose resources (no `resources` capability)",
                self.cfg.name
            ));
        }

        let future = client.read_resource(uri, self.cfg.tool_call_timeout());
        let result = match cancel {
            Some(token) => tokio::select! {
                _ = token.cancelled() => return Err("[User cancelled]".to_string()),
                result = future => result,
            },
            None => future.await,
        };
        match result {
            Ok(result) => Ok(McpResourceRead::from_client(uri, result)),
            Err(TransportError::Closed) => Err(format!(
                "MCP resource read failed ({}): connection closed",
                self.cfg.name
            )),
            Err(error) => Err(format!(
                "MCP resource read failed ({}): {error}",
                self.cfg.name
            )),
        }
    }

    // ==================== 指令 ====================

    /// 重新同步工具清单（设置页「刷新」/ 配置热更）
    pub(crate) fn request_sync(&self) {
        let _ = self.cmd_tx.send(Command::Sync);
    }

    pub(crate) fn request_reconnect(&self) {
        let _ = self.cmd_tx.send(Command::Reconnect);
    }

    /// 优雅关闭：发指令 → 等任务收尾 → 兜底关传输
    pub(crate) async fn dispose(&self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
        let handle = self.task.lock().unwrap().take();
        if let Some(handle) = handle {
            let _ = tokio::time::timeout(DISPOSE_TIMEOUT, handle).await;
        }
        self.client.write().unwrap().take();
        self.tools.write().unwrap().clear();
        self.all_tools.write().unwrap().clear();
        self.all_tools.write().unwrap().clear();
        self.all_tools.write().unwrap().clear();
        self.all_tools.write().unwrap().clear();
    }

    /// 同步版（`RunEvent::Exit` 这类同步出口）：只发指令，不等待
    pub(crate) fn shutdown_now(&self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
    }

    // ==================== 状态迁移（只在监督任务里改） ====================

    fn update(&self, change: impl FnOnce(&mut RuntimeStatus)) {
        {
            let mut status = self.status.lock().unwrap();
            change(&mut status);
        }
        (self.on_change)();
    }

    fn mark_disabled(&self) {
        self.tools.write().unwrap().clear();
        self.update(|status| {
            *status = RuntimeStatus::new(McpServerState::Disabled);
        });
    }

    fn mark_error(&self, error: String) {
        self.tools.write().unwrap().clear();
        self.update(|status| {
            *status = RuntimeStatus::new(McpServerState::Error);
            status.last_error = Some(error);
        });
    }

    fn mark_connecting(&self) {
        self.update(|status| status.state = McpServerState::Connecting);
    }

    fn mark_ready(
        &self,
        client: &Arc<Client>,
        tools: Vec<PublishedTool>,
        all_tools: Vec<McpToolInfo>,
    ) {
        let info = client.info();
        // 说明书只在「开启注入」时保存（关掉后不再占内存，也不必在快照里筛）
        let instructions = if self.cfg.inject_instructions {
            info.as_ref()
                .and_then(|info| info.instructions.clone())
                .filter(|text| !text.trim().is_empty())
        } else {
            None
        };
        *self.tools.write().unwrap() = tools;
        *self.all_tools.write().unwrap() = all_tools;
        *self.client.write().unwrap() = Some(client.clone());
        self.update(|status| {
            // 重连计数是累计量：换一代连接不能把它清零
            let reconnects = status.reconnect_count;
            *status = RuntimeStatus::new(McpServerState::Ready);
            status.reconnect_count = reconnects;
            status.connected_at = Some(chrono::Utc::now().timestamp_millis());
            status.server_name = info.as_ref().map(|info| info.server_name.clone());
            status.server_version = info.as_ref().map(|info| info.server_version.clone());
            status.supports_resources = info.as_ref().is_some_and(|info| info.supports_resources);
            status.instructions = instructions;
        });
    }

    /// 断链：连接置空，但**保留**上一世代工具（模型仍看得到；调用会如实报错）
    fn mark_disconnected(&self) {
        *self.client.write().unwrap() = None;
    }

    fn mark_backoff(&self, attempt: u32, error: Option<String>, stderr_tail: Option<String>) {
        self.update(|status| {
            status.state = McpServerState::Backoff;
            status.attempt = Some(attempt);
            // 每安排一次退避重连就 +1（诊断「服务器是不是在反复掉线」）
            status.reconnect_count = status.reconnect_count.saturating_add(1);
            if error.is_some() {
                status.last_error = error;
            }
            if stderr_tail.is_some() {
                status.stderr_tail = stderr_tail;
            }
        });
    }

    /// 预算耗尽：注销这台服务器的全部工具（模型不再看到），等用户手动重连
    fn mark_failed(&self, error: Option<String>, stderr_tail: Option<String>) {
        self.tools.write().unwrap().clear();
        self.update(|status| {
            status.state = McpServerState::Failed;
            status.attempt = None;
            if error.is_some() {
                status.last_error = error;
            }
            if stderr_tail.is_some() {
                status.stderr_tail = stderr_tail;
            }
        });
    }

    fn should_connect(&self) -> bool {
        config_allows_connection(&self.cfg)
    }

    /// 稳定期：连接活过这么久再断，就认为「抖了一下」而不是「这服务器坏了」
    fn stable_window(&self) -> Duration {
        Duration::from_millis(self.cfg.reconnect.max_delay_ms.max(1))
    }
}

// ==================== 监督任务 ====================

/// 「这台服务器该不该建连」——唯一判据（`deny` 的语义是「比连上但不许调更可预测」）。
fn config_allows_connection(cfg: &McpServerConfig) -> bool {
    cfg.enabled && cfg.approval != McpApproval::Deny
}

/// 从「连接 → 就绪 → 断链」中退出来的原因
enum ServeOutcome {
    Shutdown,
    /// 手动重连：立刻重来（不消耗退避预算）
    Reconnect,
    /// 连接意外结束（`None` = 对端安静关闭，`Some` = 有原因）
    Closed(Option<String>),
}

/// 退避 / 失败后是否继续下一轮
enum Flow {
    Continue,
    Stop,
}

async fn supervise(runtime: Arc<ServerRuntime>, mut cmd_rx: mpsc::UnboundedReceiver<Command>) {
    // 配置层面就不该连：不建连、不下发工具（deny 的语义是「比连上但不许调更可预测」）
    if !runtime.should_connect() {
        runtime.mark_disabled();
        // 仍要响应 Shutdown，否则任务泄漏（设置页删掉服务器后就没人管它了）
        while let Some(command) = cmd_rx.recv().await {
            if matches!(command, Command::Shutdown) {
                return;
            }
        }
        return;
    }
    if let Err(error) = runtime.cfg.validate() {
        runtime.mark_error(error);
        while let Some(command) = cmd_rx.recv().await {
            if matches!(command, Command::Shutdown) {
                return;
            }
        }
        return;
    }

    let mut attempt: u32 = 0;
    loop {
        runtime.mark_connecting();
        let connected = connect_and_sync(&runtime).await;

        let failure = match connected {
            Ok((client, tools, all_tools)) => {
                let started = Instant::now();
                runtime.mark_ready(&client, tools, all_tools);
                let outcome = serve(&runtime, &client, &mut cmd_rx).await;
                runtime.mark_disconnected();
                client.close().await;

                match outcome {
                    ServeOutcome::Shutdown => return,
                    ServeOutcome::Reconnect => {
                        attempt = 0;
                        continue;
                    }
                    ServeOutcome::Closed(error) => {
                        // 稳定期重置：活够久的连接断一次不该算「又失败一次」
                        if started.elapsed() >= runtime.stable_window() {
                            attempt = 0;
                        }
                        Some(error.unwrap_or_else(|| "connection closed by the server".to_string()))
                    }
                }
            }
            Err((error, stderr_tail)) => {
                if let Some(tail) = stderr_tail {
                    runtime.update(|status| status.stderr_tail = Some(tail));
                }
                Some(error)
            }
        };

        let error = failure.unwrap_or_default();
        match backoff(&runtime, &mut cmd_rx, &mut attempt, error).await {
            Flow::Continue => {}
            Flow::Stop => return,
        }
    }
}

/// 一步退避（或直接判定失败）。预算耗尽后停下等手动重连 / Shutdown。
async fn backoff(
    runtime: &Arc<ServerRuntime>,
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
    attempt: &mut u32,
    error: String,
) -> Flow {
    *attempt = attempt.saturating_add(1);
    let reconnect = &runtime.cfg.reconnect;

    if !reconnect.enabled || *attempt > reconnect.max_attempts {
        runtime.mark_failed(Some(error), None);
        *attempt = 0;
        // 失败是「终态」：不再自动重试，但**不是**死任务 —— 用户点重连还得能连上
        return match cmd_rx.recv().await {
            None | Some(Command::Shutdown) => Flow::Stop,
            Some(Command::Reconnect) | Some(Command::Sync) => Flow::Continue,
        };
    }

    runtime.mark_backoff(*attempt, Some(error), None);
    let delay = reconnect.delay_for_attempt(*attempt);
    let sleeper = tokio::time::sleep(delay);
    tokio::pin!(sleeper);
    tokio::select! {
        _ = &mut sleeper => Flow::Continue,
        command = cmd_rx.recv() => match command {
            None | Some(Command::Shutdown) => Flow::Stop,
            // 用户主动重连：预算清零，立刻重来
            Some(Command::Reconnect) | Some(Command::Sync) => {
                *attempt = 0;
                Flow::Continue
            }
        },
    }
}

/// 建连 + 首次 `tools/list`（失败带上诊断尾部）。
///
/// 返回 `(连接, 模型可见的工具, 服务器完整工具清单)`：后者**不**受白名单裁剪，
/// 供设置页把「已排除的工具」也列出来。
async fn connect_and_sync(
    runtime: &Arc<ServerRuntime>,
) -> Result<(Arc<Client>, Vec<PublishedTool>, Vec<McpToolInfo>), (String, Option<String>)> {
    let transport: Arc<dyn Transport> = match &runtime.cfg.transport {
        McpTransport::Stdio { .. } => {
            let spec = runtime
                .cfg
                .transport_spec_stdio()
                .expect("McpTransport::Stdio 一定有 stdio spec");
            match StdioTransport::spawn(&spec).await {
                Ok(transport) => transport,
                Err(error) => return Err((error.to_string(), None)),
            }
        }
        McpTransport::Http { .. } => {
            let spec = runtime
                .cfg
                .transport_spec_http()
                .expect("McpTransport::Http 一定有 http spec");
            match HttpTransport::new(&spec) {
                Ok(transport) => transport,
                Err(error) => return Err((error.to_string(), None)),
            }
        }
    };

    let client = match Client::connect(transport.clone(), runtime.cfg.startup_timeout()).await {
        Ok(client) => client,
        Err(error) => return Err((error.to_string(), transport.stderr_tail())),
    };

    match client.list_tools(runtime.cfg.startup_timeout()).await {
        Ok(tools) => {
            let all_tools = all_tool_infos(&runtime.cfg, &tools);
            Ok((client, build_tools(&runtime.cfg, tools), all_tools))
        }
        Err(error) => {
            let tail = transport.stderr_tail();
            client.close().await;
            Err((error.to_string(), tail))
        }
    }
}

/// 就绪期：等断链 / 等指令 / 处理服务器主动消息
async fn serve(
    runtime: &Arc<ServerRuntime>,
    client: &Arc<Client>,
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
) -> ServeOutcome {
    loop {
        tokio::select! {
            _ = client.wait_closed() => {
                return ServeOutcome::Closed(None)
            }
            command = cmd_rx.recv() => match command {
                None | Some(Command::Shutdown) => return ServeOutcome::Shutdown,
                Some(Command::Reconnect) => return ServeOutcome::Reconnect,
                Some(Command::Sync) => {
                    if let Err(error) = resync(runtime, client).await {
                        return ServeOutcome::Closed(Some(error.to_string()));
                    }
                }
            },
            event = client.next_event() => match event {
                Some(Incoming::Notification { method, .. }) => {
                    if method == NOTIFICATION_TOOLS_CHANGED {
                        // 服务器主动改工具：重列一遍（同一世代原子交换）
                        if let Err(error) = resync(runtime, client).await {
                            return ServeOutcome::Closed(Some(error.to_string()));
                        }
                    }
                    // 其余通知（progress / message / cancelled）v1 不用，静默忽略
                }
                Some(Incoming::ServerRequest { id, method, .. }) => {
                    // sampling / roots / elicitation：v1 明确拒绝（假装支持比拒绝更糟）
                    client.reject_server_request(&id, &method).await;
                }
                // 迟到的应答（已超时的请求）：不是错误，忽略
                Some(Incoming::Response { .. }) => {}
                // 事件流结束 = 连接没了
                None => return ServeOutcome::Closed(None),
            },
        }
    }
}

/// 重列工具并发布新世代（失败**不动**上一世代）
async fn resync(runtime: &Arc<ServerRuntime>, client: &Arc<Client>) -> Result<(), TransportError> {
    let tools = client.list_tools(runtime.cfg.startup_timeout()).await?;
    let all_tools = all_tool_infos(&runtime.cfg, &tools);
    let published = build_tools(&runtime.cfg, tools);
    *runtime.tools.write().unwrap() = published;
    *runtime.all_tools.write().unwrap() = all_tools;
    runtime.update(|status| {
        status.last_error = None;
        status.attempt = None;
    });
    Ok(())
}

/// 一条原始工具 → 对外信息（公开名 / schema 清洗 / 描述兜底）。
///
/// 「模型可见的那一份」与「完整清单」共用这一处，避免两条路径各算一份名字。
/// 公开名 = 用户指定的别名，否则服务器自己的工具名（必要时加哈希后缀）；
/// **不拼服务器名** —— 拼了就变成「改服务器名 = 所有历史与白名单失效」（见 naming.rs 头注释）。
fn tool_info(cfg: &McpServerConfig, tool: &McpTool) -> McpToolInfo {
    let description = match tool.description.trim() {
        "" => format!("MCP tool \"{}\" from server \"{}\"", tool.name, cfg.name),
        text => text.to_string(),
    };
    McpToolInfo {
        name: cfg.public_name_for(&tool.name),
        raw_name: tool.name.clone(),
        description,
        input_schema: schema::sanitize(&tool.input_schema),
    }
}

/// 服务器的**完整**工具清单（**不**按 `enabledTools` 裁剪，同公开名只留第一个）。
///
/// 设置页编辑弹窗拿它当候选：用 `tools`（已裁剪）当候选会让被排除的工具再也勾不回来。
fn all_tool_infos(cfg: &McpServerConfig, tools: &[McpTool]) -> Vec<McpToolInfo> {
    let mut infos: Vec<McpToolInfo> = Vec::with_capacity(tools.len());
    for tool in tools {
        let info = tool_info(cfg, tool);
        if infos.iter().any(|existing| existing.name == info.name) {
            continue;
        }
        infos.push(info);
    }
    // 与 `build_tools` 同序：设置页每次打开看到的行顺序一致
    infos.sort_by(|a, b| a.raw_name.cmp(&b.raw_name));
    infos
}

/// 服务器工具 → 公开工具（过滤白名单 / 清洗 schema / 排序稳定）
fn build_tools(cfg: &McpServerConfig, tools: Vec<McpTool>) -> Vec<PublishedTool> {
    let mut published: Vec<PublishedTool> = Vec::with_capacity(tools.len());
    for tool in tools {
        if !cfg.allows_tool(&tool.name) {
            continue;
        }
        let info = tool_info(cfg, &tool);
        // 防御：同一台服务器内两个工具算出了同一个公开名（别名重名已在 `validate` 驳回，
        // 但别名意外撞上另一个工具的默认名时仍可能发生）。这里只留第一个，
        // 宁可少一个也不让两个身份共用一个名字（调用会打到另一个工具）。
        if published.iter().any(|p| p.public_name == info.name) {
            eprintln!(
                "[mcp] {} 的工具 {} 与已发布的公开名 {} 冲突，已跳过",
                cfg.name, tool.name, info.name
            );
            continue;
        }
        let parameters = serde_json::from_value::<ToolParameters>(info.input_schema.clone())
            .unwrap_or_else(|_| loose_parameters(&info.input_schema));
        published.push(PublishedTool {
            public_name: info.name.clone(),
            raw_name: info.raw_name.clone(),
            definition: ToolDefinition {
                name: info.name.clone(),
                label: None,
                description: info.description.clone(),
                parameters,
            },
            info,
        });
    }
    // 按原始名排序：提示词前缀稳定（KV cache 友好），世代比较也不需要顺序无关的处理
    published.sort_by(|a, b| a.raw_name.cmp(&b.raw_name));
    published
}

/// `sanitize` 的输出理论上总能反序列化；真失败时降级成「宽松对象」而不是丢掉整个工具
fn loose_parameters(schema: &Value) -> ToolParameters {
    ToolParameters {
        type_: "object".to_string(),
        properties: schema
            .get("properties")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        required: Vec::new(),
        one_of: None,
        extra: serde_json::Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stdio_cfg(name: &str) -> McpServerConfig {
        serde_json::from_value(json!({
            "id": format!("id-{name}"),
            "name": name,
            "transport": "stdio",
            "command": "definitely-not-installed-mcp-server",
        }))
        .unwrap()
    }

    fn tool(name: &str, description: &str) -> McpTool {
        McpTool {
            name: name.into(),
            description: description.into(),
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path", "missing"],
            }),
        }
    }

    #[test]
    fn build_tools_names_and_sorts() {
        let cfg = stdio_cfg("fs");
        let tools = build_tools(&cfg, vec![tool("b_tool", "B"), tool("a_tool", "A")]);
        assert_eq!(tools.len(), 2);
        // 公开名 = 服务器自己的工具名（不再拼服务器名）
        assert_eq!(tools[0].public_name, "a_tool");
        assert_eq!(tools[0].raw_name, "a_tool");
        assert_eq!(tools[0].definition.name, "a_tool");
        // required 里不存在的字段必须被剪掉（OpenAI 严格模式会整请求 400）
        assert_eq!(tools[0].definition.parameters.required, vec!["path"]);
    }

    #[test]
    fn build_tools_honours_enabled_tools() {
        let mut cfg = stdio_cfg("fs");
        cfg.enabled_tools = Some(vec!["a_tool".into()]);
        let tools = build_tools(&cfg, vec![tool("b_tool", "B"), tool("a_tool", "A")]);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].raw_name, "a_tool");
    }

    /// 完整清单不受白名单裁剪：设置页靠它把「被排除的工具」也列出来（否则再也勾不回来）
    #[test]
    fn all_tool_infos_ignores_whitelist() {
        let mut cfg = stdio_cfg("fs");
        cfg.enabled_tools = Some(vec!["a_tool".into()]);
        let raw = vec![tool("b_tool", "B"), tool("a_tool", "A")];

        let published = build_tools(&cfg, raw.clone());
        assert_eq!(published.len(), 1, "模型只看到白名单里的那个");

        let all = all_tool_infos(&cfg, &raw);
        assert_eq!(all.len(), 2, "完整清单必须两个都在");
        assert_eq!(all[0].raw_name, "a_tool", "按原始名排序，与 build_tools 同序");
        assert_eq!(all[1].raw_name, "b_tool");
    }

    /// 完整清单也要用别名（设置页展示的就是模型看到的那个名字）
    #[test]
    fn all_tool_infos_applies_aliases() {
        let mut cfg = stdio_cfg("blender");
        cfg.tool_aliases.insert("look".into(), "blender_look".into());
        let all = all_tool_infos(&cfg, &[tool("look", "L")]);
        assert_eq!(all[0].name, "blender_look");
        assert_eq!(all[0].raw_name, "look");
    }

    /// 别名只改「模型看到的名字」：`raw_name`（调用时发给服务器的名字）必须不变
    #[test]
    fn build_tools_applies_aliases() {
        let mut cfg = stdio_cfg("blender");
        cfg.tool_aliases
            .insert("look".into(), "blender_look".into());
        let tools = build_tools(&cfg, vec![tool("look", "L"), tool("stat", "S")]);
        let look = tools.iter().find(|t| t.raw_name == "look").expect("应有 look");
        assert_eq!(look.public_name, "blender_look");
        assert_eq!(look.definition.name, "blender_look");
        assert_eq!(look.info.name, "blender_look");
        assert_eq!(look.info.raw_name, "look", "调用仍发服务器自己的名字");
        // 没改名的工具不受影响
        assert!(tools.iter().any(|t| t.public_name == "stat"));
    }

    #[test]
    fn build_tools_falls_back_to_a_readable_description() {
        let cfg = stdio_cfg("fs");
        let tools = build_tools(&cfg, vec![tool("noop", "   ")]);
        assert!(tools[0].definition.description.contains("MCP tool \"noop\""));
    }

    /// deny / 禁用：不建连（`should_connect` 是唯一判据）
    #[test]
    fn deny_and_disabled_never_connect() {
        let mut cfg = stdio_cfg("fs");
        let (runtime, _rx) = ServerRuntime::new(cfg.clone(), Arc::new(|| {}));
        assert!(runtime.should_connect());

        cfg.approval = McpApproval::Deny;
        let (denied, _rx) = ServerRuntime::new(cfg.clone(), Arc::new(|| {}));
        assert!(!denied.should_connect());

        cfg.approval = McpApproval::Allow;
        cfg.enabled = false;
        let (disabled, _rx) = ServerRuntime::new(cfg, Arc::new(|| {}));
        assert!(!disabled.should_connect());
    }

    /// 没连上时调用必须给一条「能看懂 + 可行动」的错误，而不是静默成功
    #[tokio::test]
    async fn call_without_connection_fails_clearly() {
        let (runtime, _rx) = ServerRuntime::new(stdio_cfg("fs"), Arc::new(|| {}));
        let outcome = runtime.call("mcp__fs__read", "read", json!({}), None).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("is not connected"), "{}", outcome.content);
        assert!(outcome.content.contains("Settings"), "要告诉用户去哪儿处理");
    }

    /// 参数超限先挡在本地（不打给服务器）
    #[tokio::test]
    async fn oversized_arguments_are_rejected_locally() {
        let (runtime, _rx) = ServerRuntime::new(stdio_cfg("fs"), Arc::new(|| {}));
        let huge = "x".repeat(MAX_ARGS_BYTES + 10);
        let outcome = runtime
            .call("mcp__fs__write", "write", json!({ "content": huge }), None)
            .await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("above the"), "{}", outcome.content);
    }

    /// 等到满足条件（超时返回 `false`）。
    ///
    /// 为什么用截止时间而不是「循环 N 次」：这两个用例走的是真实状态机 + 真子进程尝试，
    /// 机器忙的时候单次轮询可能被拖到几十毫秒 —— 固定次数在 CI 上会变成随机红。
    async fn wait_until(mut check: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if check() {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// 真子进程：连不上时进 failed（预算耗尽）并注销工具，且如实记录失败原因
    #[tokio::test]
    async fn unreachable_server_ends_up_failed_with_reason() {
        let mut cfg = stdio_cfg("ghost");
        // 预算压到 1 次、退避 1ms：用例要快，但走的仍是真实状态机
        cfg.reconnect.max_attempts = 1;
        cfg.reconnect.initial_delay_ms = 1;
        cfg.reconnect.max_delay_ms = 1;
        let runtime = ServerRuntime::spawn(cfg, Arc::new(|| {}));

        let settled = wait_until(
            || matches!(runtime.status().state, McpServerState::Failed | McpServerState::Error),
            Duration::from_secs(15),
        )
        .await;
        assert!(
            settled,
            "应停在 failed / error，实得 {:?}",
            runtime.status().state
        );
        let status = runtime.status();
        assert!(status.last_error.is_some(), "失败必须带原因");
        assert!(status.tools.is_empty(), "失败后工具必须注销（模型不该再看到）");
        runtime.dispose().await;
    }

    /// 失败是终态但**不是**死任务：手动重连后必须重新尝试。
    ///
    /// ⚠️ 不能用「轮询到状态 != failed」断言：连接失败是毫秒级的（命令根本不存在），
    /// 监督器可能一瞬间就又从 connecting 回到 failed，轮询很容易**完全错过**那个窗口。
    /// 改用变更钩子的计数（每次状态迁移都会调它）—— 它不会漏。
    #[tokio::test]
    async fn manual_reconnect_restarts_a_failed_server() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut cfg = stdio_cfg("ghost");
        cfg.reconnect.max_attempts = 1;
        cfg.reconnect.initial_delay_ms = 1;
        cfg.reconnect.max_delay_ms = 1;

        let changes = Arc::new(AtomicUsize::new(0));
        let counter = changes.clone();
        let runtime = ServerRuntime::spawn(
            cfg,
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        );
        assert!(
            wait_until(
                || runtime.status().state == McpServerState::Failed,
                Duration::from_secs(15)
            )
            .await,
            "应在预算耗尽后停在 failed，实得 {:?}",
            runtime.status().state
        );

        let before = changes.load(Ordering::SeqCst);
        runtime.request_reconnect();
        let restarted = wait_until(
            || changes.load(Ordering::SeqCst) > before,
            Duration::from_secs(15),
        )
        .await;
        assert!(restarted, "手动重连必须让监督器重新进入连接流程");
        runtime.dispose().await;
    }
}
