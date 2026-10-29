//! MCP 的**引擎侧出口** —— 一个进程内唯一的 `.host()`，与
//! `attach_service_notice_host` / `attach_output_host` 同一套注入风格。
//!
//! 为什么是全局 attach 而不是加参数：`execute_tool_steps` 已经 12 个参数
//!（`#[allow(too_many_arguments)]`），再加一条要穿透 5 层调用链；而「有没有 MCP」天然是
//! 进程级事实（GUI 挂 `McpManager`，CLI 挂同一个，测试与无 MCP 的宿主挂 [`NoopMcpHost`]）。
//!
//! ⚠️ 三条纪律：
//! 1. **未挂载时必须是可用的 Noop**：任何 MCP 工具调用都给一条明确英文错误，
//!    绝不静默转给 JS 桥（那里永远没有执行器，模型只会看到「工具不存在」）。
//! 2. `definitions()` / `statuses()` 是**同步**的：读的是已发布快照，绝不等待连接
//!    （否则启动会被 `npx` 冷启动拖死，见方案 §8.5）。
//! 3. `McpHost` 只出现在引擎与壳层：`mcp` 下面的 `client` / `transport` / `config` 不认识它。

use std::sync::{Arc, LazyLock, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::cancellation::CancellationToken;
use crate::agent::types::ToolDefinition;

use super::config::McpApproval;
use super::resources::{McpResourceListing, McpResourceRead};

// ==================== 状态类型（同时也是给前端的 DTO） ====================

/// 一台服务器的运行态（与方案 §4.2 的 TS 联合类型同词表）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpServerState {
    /// 被禁用 / 审批为 `deny`：不连接、工具不下发
    Disabled,
    /// 正在建连 + 首次 `tools/list`
    Connecting,
    /// 已连接且工具已发布
    Ready,
    /// 断链退避中（**保留上一世代工具**：模型仍看得到，调用会失败并如实报错）
    Backoff,
    /// 重连预算耗尽：工具已注销，等用户手动重连
    Failed,
    /// 配置无效等致命错误（不会自动重试）
    Error,
}

impl McpServerState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Connecting => "connecting",
            Self::Ready => "ready",
            Self::Backoff => "backoff",
            Self::Failed => "failed",
            Self::Error => "error",
        }
    }
}

/// 一个已发布的 MCP 工具
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    /// 模型可见名（= 用户指定的别名，缺省则服务器自己的工具名；仅字符替换 / 超长 / 历史前缀时带 12 位哈希后缀）
    pub name: String,
    /// 服务器自己的名字（`tools/call` 只认它）
    pub raw_name: String,
    pub description: String,
    /// 已过 `mcp::schema::sanitize` 的 JSON Schema（可直接下发模型）
    pub input_schema: Value,
}

/// 一个公开名归属哪台服务器的哪个工具（分发 / 审批 / 展示共用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolRoute {
    /// 服务器配置名（审批档按它查）
    pub server: String,
    /// 服务器自己的工具名（`tools/call` 原样发送）
    pub raw: String,
}

/// 冲突的两类来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpConflictKind {
    /// 与内置工具（`definitions.json` 里 39 个）重名：内置优先
    Builtin,
    /// 两台以上服务器发布了同名工具：无法判定该发给谁 → 都不下发
    Server,
}

/// 一个被**扣下不发**的同名工具。
///
/// 为什么不加后缀区分：名字是模型唯一的身份凭据，`look_1` / `look_2` 只会让模型猜。
/// 冲突必须由人来消除（在 MCP 设置里给工具改公开名 / 关掉一台服务器），所以只做「不猜 + 报出来」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConflict {
    /// 冲突的公开名（模型本该看到的名字）
    pub name: String,
    pub kind: McpConflictKind,
    /// 涉及的服务器名（`Builtin` 时为空）
    pub servers: Vec<String>,
}

/// 一台服务器的对外状态快照（不持久化；前端只读）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub id: String,
    pub name: String,
    /// `"stdio"` / `"http"`
    pub transport: String,
    pub state: McpServerState,
    pub tool_count: usize,
    /// 已发布（模型可见）的工具：已被 `enabledTools` 裁剪过
    pub tools: Vec<McpToolInfo>,
    /// 服务器提供的**完整**工具清单（不受 `enabledTools` 裁剪）。
    ///
    /// 设置页编辑弹窗要用它回填勾选 —— 拿 `tools` 当候选就只能看到已勾过的那些，
    /// 被排除的工具再也勾不回来（白名单是穷举的）。`tools` 的语义保持不变（模型看到什么就报什么）。
    #[serde(default)]
    pub all_tools: Vec<McpToolInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    /// 最近一次连上的时间（毫秒时间戳）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<i64>,
    /// 最近一次失败原因（已脱敏：不含 env / header / 参数正文）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// 重连进度：第几次 / 上限
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    /// 服务器自身输出的尾部诊断（stdio 的 stderr，≤ 8 KB；HTTP 无）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
    /// 本次进程生命周期内「断链 → 退避重连」的次数（诊断用：反复重连通常是服务器自身不稳）
    #[serde(default)]
    pub reconnect_count: u32,
}

// ==================== 调用 ====================

/// 一次 `tools/call` 的入参。
///
/// `cancel` 是「用户点了停止」：MCP 调用往往几十秒（跑 `npx`、访问网络），
/// 不能等到超时才结束（与 `execute_command` 同一纪律）。
pub struct McpCallRequest<'a> {
    /// 公开名（可能是别名）—— 由 [`super::host`] 的实现解成 `(server, raw)`
    pub tool_name: &'a str,
    pub arguments: Value,
    pub cancel: Option<&'a CancellationToken>,
}

/// 一次 `tools/call` 的结果（**已投影**：模型侧文本 + 界面侧结构化块）。
///
/// 为什么不在 `mcp` 里直接产出 `NativeToolOutcome`：`mcp` 的协议层不该依赖引擎类型；
/// 映射只发生在 `agent::tool_executor` 一处（`Value` ↔ `is_error=false`，`Error` ↔ `true`）。
#[derive(Debug, Clone, PartialEq)]
pub struct McpCallOutcome {
    /// 给模型的正文（固定英文；含截断标记）
    pub content: String,
    /// 给界面的结构化块（`{ type: "mcp_tool", server, rawName, blocks, … }`）
    pub ui_data: Option<Value>,
    /// 业务失败（服务器 `isError:true` / 协议失败 / 用户取消）—— 必须走红色通道
    pub is_error: bool,
}

impl McpCallOutcome {
    pub fn value(content: impl Into<String>, ui_data: Option<Value>) -> Self {
        Self {
            content: content.into(),
            ui_data,
            is_error: false,
        }
    }

    pub fn error(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            ui_data: None,
            is_error: true,
        }
    }

    /// 用户点「停止」时的统一文案（与 `execute_command` 的既有约定逐字一致）
    pub fn cancelled() -> Self {
        Self::error("[User cancelled]")
    }
}

// ==================== 契约 ====================

/// 引擎眼里的 MCP —— 只有「有哪些工具 / 现在什么状态 / 帮我调一个」三件事。
///
/// 默认实现全是「没有 MCP」：实现者只需覆写它真正支持的。
#[async_trait]
pub trait McpHost: Send + Sync {
    /// 当前已发布的工具定义（契约外的动态定义，按 `(serverName, rawName)` 排序）。
    /// ⚠️ 同步、立即可返：绝不等待连接。
    fn definitions(&self) -> Vec<ToolDefinition> {
        Vec::new()
    }

    /// 全部服务器状态（按配置顺序）
    fn statuses(&self) -> Vec<McpServerStatus> {
        Vec::new()
    }

    /// 快照世代（每次**工具集合**变化 +1）。前端据此判断要不要失效定义缓存。
    fn epoch(&self) -> u64 {
        0
    }

    /// 是否至少有一台服务器处于 `ready`（诊断用）
    fn is_ready(&self) -> bool {
        false
    }

    /// 某台服务器的审批档（按 `serverName` 查，**不是**公开名）。
    ///
    /// `None` = 没有这台服务器（已被删除 / 配置没加载）→ 调用方不必审批，交由 [`Self::call`]
    /// 给出「工具已不可用」的如实错误（方案 §14 风险 5：缺失即明确 Error，不静默重试）。
    fn approval_for(&self, server: &str) -> Option<McpApproval> {
        let _ = server;
        None
    }

    /// 这个公开名现在归哪台服务器的哪个工具。
    ///
    /// 工具名不带前缀了，「是不是 MCP 工具」只能问这里（`owns` 的默认实现就是问它）。
    /// ⚠️ 同步且绝不等待连接；返回 `None` 表示「不是我负责的名字」。
    fn route(&self, tool_name: &str) -> Option<McpToolRoute> {
        let _ = tool_name;
        None
    }

    /// 这个名字是不是 MCP 工具（引擎据此决定 `exec_path` / 卡片分类）。
    ///
    /// 默认实现直接问 [`Self::route`]：实现者只覆写一个即可。
    fn owns(&self, tool_name: &str) -> bool {
        self.route(tool_name).is_some()
    }

    /// 本世代被扣下不发的同名工具（界面上要如实报出来，否则用户只会看到「工具少了」）。
    fn conflicts(&self) -> Vec<McpConflict> {
        Vec::new()
    }

    /// 需要注入系统提示词的服务器说明书（已带归属前缀 + 总量截断）。
    ///
    /// `None` = 没有任何服务器要注入（未启用 / 没给 instructions / `injectInstructions=false`）。
    /// `allowed_servers` = 本次会话所属 Agent 白名单里**至少有一个工具**的服务器名：
    /// - `None`：不过滤（无 Agent 白名单的宿主，例如 CLI 全量下发工具时的会话）；
    /// - `Some(&[])`：一个都不注 —— 白名单把工具全摘掉了，说明书教的就是一批模型看不到的工具。
    ///
    /// ⚠️ 同步且绝不等待连接：建会话时调它，不能因为某台服务器正在退避而卡住。
    fn instructions(&self, allowed_servers: Option<&[String]>) -> Option<String> {
        let _ = allowed_servers;
        None
    }

    /// 列资源（`server = None` → 全部就绪且声明了 resources 能力的服务器）。
    ///
    /// 一台都没有时返回空向量（调用方据此给模型「没有任何服务器暴露资源」的如实结论）。
    async fn list_resources(
        &self,
        server: Option<&str>,
        cancel: Option<&CancellationToken>,
    ) -> Vec<McpResourceListing> {
        let _ = (server, cancel);
        Vec::new()
    }

    /// 读一个资源（`server` 是命名空间，`uri` 原样交给服务器）。
    async fn read_resource(
        &self,
        server: &str,
        uri: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<McpResourceRead, String> {
        let _ = (server, uri, cancel);
        Err("MCP support is not available in this host".to_string())
    }

    /// 调一个工具（`tool_name` 是公开名）
    async fn call(&self, req: McpCallRequest<'_>) -> McpCallOutcome {
        let _ = req;
        McpCallOutcome::error("MCP support is not available in this host")
    }

    /// 关闭全部连接（GUI 退出 / CLI 结束）
    async fn kill_all(&self) {}

    /// 同步版的「发出关闭指令」：`RunEvent::Exit` 这类同步出口用，不等待收尾
    /// （stdio 子进程还有 Job Object 的 `KILL_ON_JOB_CLOSE` 兜底）。
    fn shutdown_all(&self) {}
}

/// 没有 MCP 的宿主（测试 / CLI 未启用 / GUI 尚未装配）：任何调用都如实报错。
pub struct NoopMcpHost;

#[async_trait]
impl McpHost for NoopMcpHost {}

static NOOP: LazyLock<Arc<dyn McpHost>> = LazyLock::new(|| Arc::new(NoopMcpHost));

/// 进程内唯一出口（与 `notice::HOST` / `user_shell::HOST` 同一写法：
/// 用 `Mutex<Option<..>>` 而非 `OnceLock`，换 / 卸都要能做 —— 测试与「关掉 MCP」都需要）。
static HOST: LazyLock<Mutex<Option<Arc<dyn McpHost>>>> = LazyLock::new(|| Mutex::new(None));

/// 挂上宿主（GUI 在引擎初始化时调一次；重复挂载以最后一次为准，旧连接卸载由调用方负责）。
pub fn attach(host: Arc<dyn McpHost>) {
    *HOST.lock().unwrap() = Some(host);
}

/// 卸下宿主（回到「没有 MCP」；主要给测试收尾）
pub fn detach() {
    *HOST.lock().unwrap() = None;
}

/// 当前宿主（未挂载 → 静态 Noop）
pub fn host() -> Arc<dyn McpHost> {
    match HOST.lock().unwrap().clone() {
        Some(host) => host,
        None => NOOP.clone(),
    }
}

/// 是否真的挂了一个宿主（`host()` 永远可用，这个才是「有没有 MCP」）
pub fn is_attached() -> bool {
    HOST.lock().unwrap().is_some()
}

/// 便捷：当前已发布定义（未挂载 → 空）
pub fn definitions() -> Vec<ToolDefinition> {
    host().definitions()
}

/// 便捷：全部服务器状态（未挂载 → 空）
pub fn statuses() -> Vec<McpServerStatus> {
    host().statuses()
}

/// 便捷：公开名归属（未挂载 / 不认识 → `None`）
pub fn route(tool_name: &str) -> Option<McpToolRoute> {
    host().route(tool_name)
}

/// 便捷：这个名字是不是 MCP 工具
pub fn owns(tool_name: &str) -> bool {
    host().owns(tool_name)
}

/// 便捷：本世代被扣下不发的同名工具
pub fn conflicts() -> Vec<McpConflict> {
    host().conflicts()
}

/// 便捷：调一个 MCP 工具（`tool_name` 是公开名）
pub async fn call_tool(
    tool_name: &str,
    arguments: Value,
    cancel: Option<&CancellationToken>,
) -> McpCallOutcome {
    host()
        .call(McpCallRequest {
            tool_name,
            arguments,
            cancel,
        })
        .await
}

/// 便捷：服务器说明书片段（未挂载 / 没内容 → `None`）
///
/// `allowed_servers` 语义见 [`McpHost::instructions`]；`None` = 不过滤。
pub fn instructions(allowed_servers: Option<&[String]>) -> Option<String> {
    host().instructions(allowed_servers)
}

/// 便捷：列资源（`server = None` → 全部就绪且支持 resources 的服务器）
pub async fn list_resources(
    server: Option<&str>,
    cancel: Option<&CancellationToken>,
) -> Vec<McpResourceListing> {
    host().list_resources(server, cancel).await
}

/// 便捷：读一个资源
pub async fn read_resource(
    server: &str,
    uri: &str,
    cancel: Option<&CancellationToken>,
) -> Result<McpResourceRead, String> {
    host().read_resource(server, uri, cancel).await
}

/// 测试串行化锁：`HOST` 是**进程级**全局，任何「挂载 / 卸载 / 调到它」的用例都必须经同一把锁。
///
/// ⚠️ 以前每个测试模块各写一个 `static GUARD` —— 那不是同一把锁，并发时互相卸宿主，
/// 表现为「单跑绿、全量红」的随机失败。所有 mcp 测试统一用这个。
#[cfg(test)]
pub(crate) fn test_lock() -> &'static tokio::sync::Mutex<()> {
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    &GUARD
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 测试串行化：`HOST` 是进程级全局，用例之间必须排队（否则互相卸载）
    fn lock() -> &'static tokio::sync::Mutex<()> {
        super::test_lock()
    }

    #[tokio::test]
    async fn unattached_host_is_a_working_noop() {
        let _guard = lock().lock().await;
        detach();
        assert!(!is_attached());
        assert!(definitions().is_empty());
        assert!(statuses().is_empty());
        assert_eq!(host().epoch(), 0);
        assert!(!host().is_ready());

        let outcome = call_tool("mcp__fs__read_file", json!({}), None).await;
        assert!(outcome.is_error, "未挂载时调 MCP 工具必须是失败，不能静默成功");
        assert!(
            outcome.content.contains("not available"),
            "文案要能让模型看懂：{}",
            outcome.content
        );
    }

    struct FakeHost;

    #[async_trait]
    impl McpHost for FakeHost {
        fn epoch(&self) -> u64 {
            7
        }
        fn is_ready(&self) -> bool {
            true
        }
        async fn call(&self, req: McpCallRequest<'_>) -> McpCallOutcome {
            McpCallOutcome::value(format!("called {}", req.tool_name), None)
        }
    }

    #[tokio::test]
    async fn attached_host_receives_calls() {
        let _guard = lock().lock().await;
        attach(Arc::new(FakeHost));
        assert!(is_attached());
        assert_eq!(host().epoch(), 7);
        assert!(host().is_ready());
        let outcome = call_tool("ping", json!({}), None).await;
        assert_eq!(outcome.content, "called ping");
        assert!(!outcome.is_error);
        detach();
        assert!(!is_attached());
    }

    /// 状态枚举的序列化词表就是 TS 联合类型（前端按它选胶囊颜色）
    #[test]
    fn states_serialize_lowercase() {
        for (state, expected) in [
            (McpServerState::Disabled, "\"disabled\""),
            (McpServerState::Connecting, "\"connecting\""),
            (McpServerState::Ready, "\"ready\""),
            (McpServerState::Backoff, "\"backoff\""),
            (McpServerState::Failed, "\"failed\""),
            (McpServerState::Error, "\"error\""),
        ] {
            assert_eq!(serde_json::to_string(&state).unwrap(), expected);
            assert_eq!(state.as_str(), expected.trim_matches('"'));
        }
    }

    /// 状态里可缺省的字段不得序列化成 `null`（前端用 `undefined` 判断「没有」）
    #[test]
    fn status_omits_absent_optionals() {
        let status = McpServerStatus {
            id: "x".into(),
            name: "fs".into(),
            transport: "stdio".into(),
            state: McpServerState::Disabled,
            tool_count: 0,
            tools: Vec::new(),
            all_tools: Vec::new(),
            server_name: None,
            server_version: None,
            connected_at: None,
            last_error: None,
            attempt: None,
            max_attempts: None,
            stderr_tail: None,
            reconnect_count: 0,
        };
        let value = serde_json::to_value(&status).unwrap();
        for key in [
            "serverName",
            "serverVersion",
            "connectedAt",
            "lastError",
            "attempt",
            "maxAttempts",
            "stderrTail",
        ] {
            assert!(value.get(key).is_none(), "{key} 不应出现");
        }
        assert_eq!(value["state"], "disabled");
        assert_eq!(value["toolCount"], 0);
        // 重连次数是**计数**（0 也有意义），必须始终下发
        assert_eq!(value["reconnectCount"], 0);
    }
}
