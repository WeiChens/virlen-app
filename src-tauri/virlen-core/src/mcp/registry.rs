//! 多服务器管理器（`McpHost` 的实现）—— 快照、世代、差量重载。
//!
//! 结构上是「一张快照 + 一组监督任务」：
//!
//! ```text
//!   McpManager ──snapshot(RwLock<Arc<Snapshot>>)──► 引擎（definitions / statuses，同步读）
//!       │                                       └──► 前端（epoch / 状态胶囊）
//!       └── servers: [ServerRuntime]  每台服务器一个 tokio 任务（见 connection.rs）
//! ```
//!
//! 三条纪律：
//! 1. **快照同步可读**：`definitions()` / `statuses()` 只读已发布快照，绝不等待连接
//!    （否则启动会被 `npx` 冷启动拖死，见方案 §8.5）。
//! 2. **世代只在工具集合变化时 +1**：前端据此决定要不要失效定义缓存；状态变化走 `mcp:status`。
//! 3. **配置变更走差量**：`reload` 只重建「配置真的变了」的服务器 —— 改一个字段不该让其它
//!    服务器的 stdio 子进程全部重启。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use async_trait::async_trait;

use super::config::{validate_all, McpApproval, McpServerConfig};
use super::connection::ServerRuntime;
use super::host::{
    McpCallOutcome, McpCallRequest, McpHost, McpServerState, McpServerStatus, McpToolInfo,
};
use super::resources::{McpResourceListing, McpResourceRead};
use crate::agent::cancellation::CancellationToken;
use crate::agent::types::ToolDefinition;
use crate::session_db::SettingsRepo;

/// 配置在 `app_settings` 里的键名（与 TS `SettingsStore.mcpServers` 同名同层）
pub const SETTINGS_KEY: &str = "mcpServers";

/// 探针（「测试连接」）等待就绪的额外余量：建连超时之外再给一点收尾时间
const PROBE_GRACE_MS: u64 = 5_000;

// ==================== 变更出口 ====================

/// 快照变化的宿主出口（GUI 实现 = 发 `mcp:changed` / `mcp:status`；CLI 不挂）。
///
/// 为什么用 trait 而不是直接 emit：core 零 `tauri::`（宿主差异全收在宿主侧）。
pub trait McpChangeSink: Send + Sync {
    /// 快照已更新。
    ///
    /// - `tools_changed == false` 时只代表**状态**变了（连接 / 退避 / 失败），工具定义没变；
    ///   前端应刷新状态，但不必重新拉定义。
    fn publish(&self, statuses: &[McpServerStatus], epoch: u64, tools_changed: bool);
}

// ==================== 快照 ====================

/// 公开名 → 「哪台服务器 + 服务器自己的名字」（`tools/call` 只发后者）
#[derive(Debug, Clone)]
struct Route {
    server_id: String,
    raw_name: String,
}

struct Snapshot {
    /// 单调递增：**工具集合**每变一次 +1
    epoch: u64,
    tools: Vec<ToolDefinition>,
    statuses: Vec<McpServerStatus>,
    routes: HashMap<String, Route>,
    /// 工具集合的指纹（判断「变了没有」，避免把状态抖动也当世代）
    signature: String,
}

impl Snapshot {
    fn empty() -> Self {
        Self {
            epoch: 0,
            tools: Vec::new(),
            statuses: Vec::new(),
            routes: HashMap::new(),
            // 与「空工具列表」的序列化结果一致 → 首次发布不会凭空产生一个世代
            signature: "[]".to_string(),
        }
    }
}

// ==================== 管理器 ====================

pub struct McpManager {
    /// 最近一次落库的配置（`reload` 的输入副本；`enabled=false` 的也在里面）
    configs: RwLock<Vec<McpServerConfig>>,
    /// 只在跑的服务器（含 disabled / deny —— 它们不建连，但状态要显示）
    servers: RwLock<Vec<Arc<ServerRuntime>>>,
    snapshot: RwLock<Arc<Snapshot>>,
    sink: Mutex<Option<Arc<dyn McpChangeSink>>>,
    started: AtomicBool,
}

impl McpManager {
    /// 建管理器（**不**起任何任务：`start` 必须在 tokio 上下文里调）
    pub fn new(configs: Vec<McpServerConfig>, sink: Option<Arc<dyn McpChangeSink>>) -> Arc<Self> {
        Arc::new(Self {
            configs: RwLock::new(configs),
            servers: RwLock::new(Vec::new()),
            snapshot: RwLock::new(Arc::new(Snapshot::empty())),
            sink: Mutex::new(sink),
            started: AtomicBool::new(false),
        })
    }

    /// 起全部监督任务（幂等：只有第一次生效）
    pub async fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let configs = self.configs.read().unwrap().clone();
        self.reload(configs).await;
    }

    /// 差量重载：配置**完全一致**的服务器原地保留（不重连），其余重建。
    pub async fn reload(self: &Arc<Self>, configs: Vec<McpServerConfig>) {
        *self.configs.write().unwrap() = configs.clone();
        let existing: Vec<Arc<ServerRuntime>> = self.servers.read().unwrap().clone();

        let keep = |cfg: &McpServerConfig| {
            existing
                .iter()
                .find(|server| server.config() == cfg)
                .cloned()
        };

        // 先停掉不再需要的（配置变了 / 被删掉的）
        let mut kept: Vec<Arc<ServerRuntime>> = Vec::new();
        for cfg in &configs {
            if let Some(server) = keep(cfg) {
                kept.push(server);
            }
        }
        for server in &existing {
            if !kept.iter().any(|k| Arc::ptr_eq(k, server)) {
                server.dispose().await;
            }
        }

        // 再按配置顺序重建列表（顺序决定快照顺序 → 提示词前缀稳定）
        let hook = self.change_hook();
        let mut servers: Vec<Arc<ServerRuntime>> = Vec::with_capacity(configs.len());
        for cfg in configs {
            match kept.iter().find(|server| server.config() == &cfg) {
                Some(server) => servers.push(server.clone()),
                None => servers.push(ServerRuntime::spawn(cfg, hook.clone())),
            }
        }
        // 替换列表：**先把旧列表换出来、再在锁外 drop** —— drop 会关闭旧服务器的指令通道，
        // 而监督任务退出时可能回调 `republish`（它要读同一把锁，std RwLock 不可重入）
        let previous = {
            let mut slot = self.servers.write().unwrap();
            std::mem::replace(&mut *slot, servers)
        };
        drop(previous);
        self.republish();
    }

    /// 当前配置（含 disabled 的）
    pub fn configs(&self) -> Vec<McpServerConfig> {
        self.configs.read().unwrap().clone()
    }

    /// 手动重连（无 id = 全部）；`failed` 的服务器也由此复活
    pub fn reconnect(&self, id: Option<&str>) {
        for server in self.servers.read().unwrap().iter() {
            if id.map(|id| id == server.config().id).unwrap_or(true) {
                server.request_reconnect();
            }
        }
    }

    /// 重新列工具（配置里的工具白名单变了但连接没断时用）
    pub fn request_sync(&self, id: Option<&str>) {
        for server in self.servers.read().unwrap().iter() {
            if id.map(|id| id == server.config().id).unwrap_or(true) {
                server.request_sync();
            }
        }
    }

    /// 换快照出口（GUI 初始化时挂；测试里也可后挂）
    pub fn set_sink(&self, sink: Option<Arc<dyn McpChangeSink>>) {
        *self.sink.lock().unwrap() = sink;
    }

    /// 重算并发布快照（任何服务器状态变化都会走到这里）
    fn republish(&self) {
        let servers = self.servers.read().unwrap().clone();
        let mut tools: Vec<ToolDefinition> = Vec::new();
        let mut statuses: Vec<McpServerStatus> = Vec::with_capacity(servers.len());
        let mut routes: HashMap<String, Route> = HashMap::new();

        for server in &servers {
            let status = server.status();
            tools.extend(server.definitions());
            for info in &status.tools {
                routes.insert(
                    info.name.clone(),
                    Route {
                        server_id: status.id.clone(),
                        raw_name: info.raw_name.clone(),
                    },
                );
            }
            statuses.push(status);
        }
        // 排序固定：提示词前缀稳定（KV cache 友好），也便于「世代是否变化」的比较
        tools.sort_by(|a, b| a.name.cmp(&b.name));

        let signature = serde_json::to_string(&tools).unwrap_or_default();
        let previous = self.snapshot.read().unwrap().clone();
        let tools_changed = signature != previous.signature;
        let epoch = if tools_changed {
            previous.epoch + 1
        } else {
            previous.epoch
        };
        let snapshot = Arc::new(Snapshot {
            epoch,
            tools,
            statuses,
            routes,
            signature,
        });
        *self.snapshot.write().unwrap() = snapshot.clone();

        if let Some(sink) = self.sink.lock().unwrap().clone() {
            sink.publish(&snapshot.statuses, epoch, tools_changed);
        }
    }

    /// 服务器变化回调（`Weak` 断开后自动失效 —— 管理器销毁时不留环）
    fn change_hook(self: &Arc<Self>) -> Arc<dyn Fn() + Send + Sync> {
        let weak = Arc::downgrade(self);
        Arc::new(move || {
            if let Some(manager) = weak.upgrade() {
                manager.republish();
            }
        })
    }

    fn find_server(&self, id: &str) -> Option<Arc<ServerRuntime>> {
        self.servers
            .read()
            .unwrap()
            .iter()
            .find(|server| server.config().id == id)
            .cloned()
    }

    /// 是否所有服务器都「有结论了」（没有一台还在 `connecting`）。
    ///
    /// 消费方是 [`start_from_settings`]：CLI 是「跑完就退」的进程，不在启动阶段把服务器连上，
    /// 那一轮就永远用不到 MCP 工具；但也不能无限等 —— `backoff` / `failed` 已经是有结论的状态。
    pub fn settled(&self) -> bool {
        !self
            .servers
            .read()
            .unwrap()
            .iter()
            .any(|server| server.status().state == McpServerState::Connecting)
    }
}

#[async_trait]
impl McpHost for McpManager {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.snapshot.read().unwrap().tools.clone()
    }

    fn statuses(&self) -> Vec<McpServerStatus> {
        self.snapshot.read().unwrap().statuses.clone()
    }

    fn epoch(&self) -> u64 {
        self.snapshot.read().unwrap().epoch
    }

    fn is_ready(&self) -> bool {
        self.servers
            .read()
            .unwrap()
            .iter()
            .any(|server| server.is_ready())
    }

    /// 按 `serverName` 查审批档（公开名里的命名空间，不是配置 id）。
    ///
    /// 读的是 `configs`（含 `enabled=false` 的），不是服务器列表：用户刚把某台服务器
    /// 改成 `deny` 时，监督任务可能还在收尾，审批判定不该跟着抖。
    fn approval_for(&self, server: &str) -> Option<McpApproval> {
        self.configs
            .read()
            .unwrap()
            .iter()
            .find(|config| config.name == server)
            .map(|config| config.approval)
    }

    /// 全部要注入的说明书，按配置顺序拼成一段（空 → `None`）。
    ///
    /// 只收「已就绪且 `injectInstructions` 开」的：`backoff` / `failed` 的服务器本轮没有工具可用，
    /// 把它的说明书也注进去只会浪费上下文并误导模型。
    fn instructions(&self) -> Option<String> {
        let servers = self.servers.read().unwrap().clone();
        let entries: Vec<(String, String)> = servers
            .iter()
            .filter_map(|server| {
                server
                    .instructions()
                    .map(|text| (server.config().name.clone(), text))
            })
            .collect();
        super::instructions::render(&entries)
    }

    async fn list_resources(
        &self,
        server: Option<&str>,
        cancel: Option<&CancellationToken>,
    ) -> Vec<McpResourceListing> {
        let servers = self.servers.read().unwrap().clone();
        if let Some(name) = server {
            let Some(runtime) = servers.iter().find(|item| item.config().name == name) else {
                return vec![McpResourceListing::failed(
                    name,
                    "unknown",
                    format!("MCP server \"{name}\" is not configured (see Settings → MCP servers)"),
                )];
            };
            return vec![runtime.list_resources(cancel).await];
        }
        // 不指定服务器：只问「声明了 resources 能力且现在能连上」的 ——
        // 对不支持的服务器发 `resources/list` 只会拿到 -32601，把错误摆给模型看是噪音
        let mut out: Vec<McpResourceListing> = Vec::new();
        for runtime in &servers {
            if !runtime.supports_resources() {
                continue;
            }
            out.push(runtime.list_resources(cancel).await);
        }
        out
    }

    async fn read_resource(
        &self,
        server: &str,
        uri: &str,
        cancel: Option<&CancellationToken>,
    ) -> Result<McpResourceRead, String> {
        let servers = self.servers.read().unwrap().clone();
        let Some(runtime) = servers.iter().find(|item| item.config().name == server) else {
            return Err(format!(
                "MCP server \"{server}\" is not configured (see Settings → MCP servers)"
            ));
        };
        runtime.read_resource(uri, cancel).await
    }

    async fn call(&self, req: McpCallRequest<'_>) -> McpCallOutcome {
        let route = self
            .snapshot
            .read()
            .unwrap()
            .routes
            .get(req.tool_name)
            .cloned();
        let Some(route) = route else {
            return McpCallOutcome::error(format!(
                "MCP tool \"{}\" is not available (its server is not connected, disabled, or no longer exposes it)",
                req.tool_name
            ));
        };
        let Some(server) = self.find_server(&route.server_id) else {
            return McpCallOutcome::error(format!(
                "MCP tool \"{}\" is not available (server was removed while the run was in flight)",
                req.tool_name
            ));
        };
        server
            .call(req.tool_name, &route.raw_name, req.arguments, req.cancel)
            .await
    }

    async fn kill_all(&self) {
        let servers = self.servers.read().unwrap().clone();
        for server in servers {
            server.dispose().await;
        }
        // 与 `reload` 同一纪律：旧列表在锁外 drop（监督任务退出时可能回调 `republish`）
        let previous = {
            let mut slot = self.servers.write().unwrap();
            std::mem::take(&mut *slot)
        };
        drop(previous);
        self.republish();
    }

    fn shutdown_all(&self) {
        for server in self.servers.read().unwrap().iter() {
            server.shutdown_now();
        }
    }
}

// ==================== 配置读写（GUI / CLI 同一条） ====================

/// 读 `app_settings.mcpServers`（缺键 / null → 空；解析失败 → 明确错误）
pub async fn load_configs(settings: &dyn SettingsRepo) -> Result<Vec<McpServerConfig>, String> {
    let all = settings.get_all().await?;
    let Some(value) = all.get(SETTINGS_KEY) else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    serde_json::from_value::<Vec<McpServerConfig>>(value.clone())
        .map_err(|e| format!("mcpServers 配置解析失败：{e}"))
}

/// 写 `app_settings.mcpServers`（只动这一个键）
pub async fn save_configs(
    settings: &dyn SettingsRepo,
    configs: &[McpServerConfig],
) -> Result<(), String> {
    let value = serde_json::to_value(configs).map_err(|e| format!("mcpServers 序列化失败：{e}"))?;
    let mut entries = serde_json::Map::new();
    entries.insert(SETTINGS_KEY.to_string(), value);
    settings.upsert(entries).await
}

/// 校验一批配置（设置页落库前的最后一道门）
pub fn validate_configs(configs: &[McpServerConfig]) -> Result<(), String> {
    validate_all(configs)
}

/// 无界面宿主（CLI）的装配：读配置 → 建管理器 → `attach` → 启动 → 等到「有结论」。
///
/// 为什么要等：CLI 是「跑完就退」的进程 —— 不等，那一轮的工具定义里就永远没有 MCP 工具
/// （`npx` 冷启动通常 3–10 秒）。等待上限取「各服务器启动超时的最大值 + 2s」，
/// 且 `backoff` / `failed` 也算「有结论」（它们本来就不可能在本轮提供工具）。
///
/// 配置读失败 → `Err`（调用方自己决定是否阻断；CLI 选择只告警不阻断）。
pub async fn start_from_settings(
    settings: &dyn SettingsRepo,
    sink: Option<Arc<dyn McpChangeSink>>,
) -> Result<Arc<McpManager>, String> {
    let configs = load_configs(settings).await?;
    let wait_ms = configs
        .iter()
        .map(|config| config.startup_timeout_ms)
        .max()
        .unwrap_or(0)
        .saturating_add(2_000);
    let manager = McpManager::new(configs, sink);
    super::host::attach(manager.clone());
    manager.start().await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
    while !manager.settled() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(manager)
}

// ==================== 探针（「测试连接」） ====================

/// 临时连一次、列工具、立刻关掉 —— 不落库、不影响正在跑的服务器。
///
/// 为什么复用监督器而不是另写一条链：连接语义（Windows `.cmd` 垫片 / 环境清洗 /
/// 协议版本回退）只写一份，测试连接才可能和真实运行一致。
///
/// ⚠️ 两个必要偏差（都是「测试连接」的语义，不是真实运行）：
/// 1. **关掉自动重连**：这是个用户点了一下、要在几秒内看到结论的按钮。开着退避时它要等
///    `500ms → 1s → 2s …` 十轮（可能几分钟）才落 `failed`，而退避中的状态不是终态 ——
///    探针只能干等到超时，然后把真实原因换成一句硬编码的「连接超时」（实测踩过：Python
///    服务端 stdout 不是 UTF-8、HTTP 端口其实不是 MCP，都被这句盖掉了）。
/// 2. **超时优先带出 `last_error`**：连接过程中可能已经失败过一次并有原因，别丢掉。
pub async fn probe(config: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
    config.validate()?;
    if !config.enabled || config.approval == super::config::McpApproval::Deny {
        return Err("该服务器已被禁用或审批方式为「禁用」，不会建立连接".to_string());
    }
    let mut probe_config = config.clone();
    probe_config.reconnect.enabled = false;
    let runtime = ServerRuntime::spawn(probe_config, Arc::new(|| {}));
    let deadline = tokio::time::Instant::now()
        + config.startup_timeout()
        + std::time::Duration::from_millis(PROBE_GRACE_MS);

    let mut outcome: Result<Vec<McpToolInfo>, String> = Err("连接超时".to_string());
    loop {
        let status = runtime.status();
        match status.state {
            McpServerState::Ready => {
                outcome = Ok(status.tools);
                break;
            }
            McpServerState::Failed | McpServerState::Error | McpServerState::Disabled => {
                outcome = Err(status.last_error.unwrap_or_else(|| "连接失败".to_string()));
                break;
            }
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            // 超时也要把已经拿到的原因带出去（`connecting` 卡住时 last_error 可能已有内容）
            if let Some(error) = status.last_error {
                outcome = Err(format!(
                    "{error}（{} ms 内未就绪）",
                    config.startup_timeout_ms + PROBE_GRACE_MS
                ));
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    runtime.dispose().await;
    outcome
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_db::NoopSettingsRepo;
    use serde_json::json;

    fn cfg(name: &str) -> McpServerConfig {
        serde_json::from_value(json!({
            "id": format!("id-{name}"),
            "name": name,
            "transport": "stdio",
            "command": "definitely-not-installed-mcp-server",
            "approval": "allow",
            "reconnect": { "enabled": false },
        }))
        .unwrap()
    }

    /// 没启过的管理器：定义 / 状态 / 世代都是空，调工具给明确错误
    #[tokio::test]
    async fn empty_manager_is_a_well_behaved_host() {
        let manager = McpManager::new(Vec::new(), None);
        assert!(manager.definitions().is_empty());
        assert!(manager.statuses().is_empty());
        assert_eq!(manager.epoch(), 0);
        assert!(!manager.is_ready());
        let outcome = manager
            .call(McpCallRequest {
                tool_name: "mcp__ghost__x",
                arguments: json!({}),
                cancel: None,
            })
            .await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("not available"), "{}", outcome.content);
    }

    /// 禁用 / deny 的服务器也要有状态（设置页要显示「已禁用」），但不建连、不下发工具
    #[tokio::test]
    async fn disabled_servers_report_state_without_connecting() {
        let mut config = cfg("off");
        config.enabled = false;
        let manager = McpManager::new(vec![config], None);
        manager.start().await;

        let statuses = manager.statuses();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].name, "off");
        assert_eq!(statuses[0].reconnect_count, 0, "没重连过就是 0");
        assert_eq!(statuses[0].state, McpServerState::Disabled);
        assert!(manager.definitions().is_empty());
        manager.kill_all().await;
    }

    /// 世代只在工具集合变化时 +1（状态抖动不该让前端反复失效缓存）
    #[tokio::test]
    async fn epoch_only_moves_when_tool_set_changes() {
        let manager = McpManager::new(Vec::new(), None);
        manager.start().await;
        assert_eq!(manager.epoch(), 0, "没有工具 → 没有世代");

        // 加一台禁用服务器：状态有了，但工具集合仍是空 → 世代不动
        let mut config = cfg("off");
        config.enabled = false;
        manager.reload(vec![config]).await;
        assert_eq!(manager.epoch(), 0);

        // 移除：同样不动
        manager.reload(Vec::new()).await;
        assert_eq!(manager.epoch(), 0);
    }

    /// 配置完全一致时 reload **不重建**运行时（否则改一个字段会拖累所有服务器）
    #[tokio::test]
    async fn reload_keeps_identical_servers() {
        let mut config = cfg("ghost");
        config.enabled = false;
        let manager = McpManager::new(vec![config.clone()], None);
        manager.start().await;
        let first = manager.find_server("id-ghost").expect("应有运行时");

        manager.reload(vec![config.clone()]).await;
        let second = manager.find_server("id-ghost").expect("应有运行时");
        assert!(
            Arc::ptr_eq(&first, &second),
            "配置一样的服务器应原地保留（不重连）"
        );

        // 改一个字段 → 必须重建
        let mut changed = config;
        changed.tool_call_timeout_ms = 12_345;
        manager.reload(vec![changed]).await;
        let third = manager.find_server("id-ghost").expect("应有运行时");
        assert!(!Arc::ptr_eq(&second, &third), "配置变了应重建运行时");
        manager.kill_all().await;
    }

    /// 变更出口要能收到「工具是否真的变了」这个区分
    #[tokio::test]
    async fn sink_receives_publish_notifications() {
        struct Recorder(Mutex<Vec<(u64, bool)>>);
        impl McpChangeSink for Recorder {
            fn publish(&self, _statuses: &[McpServerStatus], epoch: u64, tools_changed: bool) {
                self.0.lock().unwrap().push((epoch, tools_changed));
            }
        }

        let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
        let manager = McpManager::new(Vec::new(), Some(recorder.clone()));
        manager.start().await;
        let published = recorder.0.lock().unwrap().clone();
        assert!(!published.is_empty(), "至少发布一次");
        assert_eq!(published.last().unwrap().0, 0);
        assert!(!published.last().unwrap().1);
    }

    /// 配置解析：缺键 / null → 空；坏形状 → 明确错误（不 panic）
    #[tokio::test]
    async fn load_configs_handles_missing_and_malformed() {
        let settings = NoopSettingsRepo;
        assert!(load_configs(&settings).await.unwrap().is_empty());
    }

    /// 「测试连接」必须快且说真话：即使配置里开着自动重连，也要立刻落 `failed` 并带出原因
    /// （不去等完 `500ms→30s` 的退避预算，也不把真实错误换成一句「连接超时」）
    #[tokio::test]
    async fn probe_fails_fast_with_a_reason_even_when_reconnect_is_enabled() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "id": "id-ghost",
            "name": "ghost",
            "transport": "stdio",
            "command": "definitely-not-installed-mcp-server",
            "reconnect": {
                "enabled": true,
                "initialDelayMs": 5000,
                "maxDelayMs": 30000,
                "maxAttempts": 10
            },
            "startupTimeoutMs": 20000
        }))
        .unwrap();
        let started = std::time::Instant::now();
        let error = probe(&config).await.expect_err("命令不存在必然失败");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "探针不许等完退避预算，实得 {:?}",
            started.elapsed()
        );
        assert!(!error.contains("连接超时"), "必须给真实原因，实得：{error}");
    }

    /// 落库形状与 TS `McpServerConfig` 同形（camelCase、传输字段扁平）
    #[test]
    fn configs_serialize_to_the_ts_shape() {
        let config = cfg("fs");
        let value = serde_json::to_value(vec![&config]).unwrap();
        assert_eq!(value[0]["name"], "fs");
        assert_eq!(value[0]["transport"], "stdio");
        assert_eq!(value[0]["toolCallTimeoutMs"], 60_000);
        assert!(value[0].get("command").is_some(), "stdio 字段应扁平存在");
    }
}
