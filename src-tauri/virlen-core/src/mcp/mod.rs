//! MCP（Model Context Protocol）客户端 —— **协议层 + 管理器**。
//!
//! P0 = 协议层（连上去、握手、列工具、调工具）；P1 = 引擎接入（多服务器快照 / 重连监督 /
//! 全局 `McpHost` 挂载）。审批与卡片在 P2，资源与指令在 P3（见 `docs/mcp-plan.md`）。
//!
//! ```text
//! mcp/
//! ├── mod.rs          对外出口（本文件）
//! ├── naming.rs       公开工具名：**直接用服务器自己的工具名** + 64 字符/12 hex 规则
//! │                  （`mcp__<server>__<raw>` 只剩旧数据识别）
//! ├── naming_fixtures.json  命名黄金值（Rust 与 TS 两侧共用同一份，防算法漂移）
//! ├── config.rs       服务器配置（serde camelCase）+ 校验 + 子进程环境清洗 + 重连退避
//! ├── schema.rs       MCP 的任意 JSON Schema → 三大 provider 都吃得下的子集
//! ├── jsonrpc.rs      JSON-RPC 2.0 消息编解码 + 行帧切分（stdio 用）
//! ├── transport/
//! │   ├── mod.rs       `Transport` 契约 + 两种传输共用的 id 关联 / 事件队列 / 关闭信号
//! │   ├── stdio.rs     本地子进程（Windows `.cmd` 垫片 / 环境清洗 / stderr 环 / 进程树）
//! │   └── http.rs      Streamable HTTP（POST + SSE + Mcp-Session-Id + GET 流）
//! ├── client.rs       单连接客户端：initialize 握手 / tools 分页 / call_tool / 通知
//! ├── results.rs      `tools/call` 结果投影（模型文本 + 界面块 + 60KB 上限）
//! ├── resources.rs    `resources/list` / `resources/read` 投影（P3）
//! ├── instructions.rs 服务器 `instructions` → 系统提示词片段（32KB 上限，P3）
//! ├── connection.rs   单服务器监督器（连接 / 同步串行 / 退避重连 / 诊断）
//! ├── registry.rs     多服务器管理器（快照 + 世代 + 差量重载 + 配置读写）
//! ├── bridge.rs       `ask` 档的审批闸门（复用 `confirm_mcp_call` 交互通道）
//! └── host.rs         引擎侧出口：`McpHost` trait + 全局 attach + Noop
//! ```
//!
//! ⚠️ 三条不变量（P1 接引擎时必须继续成立）：
//! 1. **公开名 = 服务器自己的工具名**（必要时加哈希后缀），同一输入永远同一名字；`tools/call`
//!    只发服务器自己的 `rawName`。跨服务器同名**不折叠、不猜路由**：由 `McpManager::republish`
//!    判定为冲突并**两边都不下发**（fail-closed），同时报给界面。
//! 2. **一个服务器的工具要么整批生效、要么一个都不注册**（同步失败保留上一世代）。
//! 3. **stdio 子进程不套沙盒**（它本来就要读写文件/网络），防护靠：默认不启用 + 审批 +
//!    环境变量清洗 + 结果大小上限（见 `docs/mcp-plan.md` §7）。

pub mod bridge;
pub mod client;
pub mod config;
// 单服务器监督器是内部实现（对外只暴露 `McpManager` 与快照类型）
pub(crate) mod connection;
pub mod host;
pub mod import;
pub mod instructions;
pub mod jsonrpc;
pub mod naming;
pub mod registry;
pub mod resources;
pub mod results;
pub mod schema;
pub mod transport;

pub use bridge::{call_with_approval, McpApprovalCtx, McpGatedCall, CONFIRM_TYPE};
pub use client::{
    CallToolResult, Client, InitializeResult, McpResource, McpTool, ReadResourceResult,
    ResourceContent,
};
pub use config::{
    merge_child_env, scrubbed_parent_env, validate_all, HttpSpec, McpApproval,
    McpReconnectConfig, McpServerConfig, McpTransport, StdioSpec,
};
pub use host::{
    attach, call_tool, conflicts, definitions, detach, host, instructions, is_attached,
    list_resources, owns, read_resource, route, statuses, McpCallOutcome, McpCallRequest,
    McpConflict, McpConflictKind, McpHost, McpServerState, McpServerStatus, McpToolInfo,
    McpToolRoute, NoopMcpHost,
};
pub use import::{parse_import, ImportResult, SkippedImport};
pub use jsonrpc::{parse_message, Incoming, RpcError};
pub use naming::{
    is_legacy_mcp_tool_name, public_tool_name, split_legacy_mcp_tool_name, MCP_PREFIX,
};
pub use registry::{
    load_configs, probe, save_configs, start_from_settings, validate_configs, McpChangeSink,
    McpManager, SETTINGS_KEY,
};
pub use resources::{McpResourceListing, McpResourceRead};
pub use results::MAX_RESULT_CHARS;
pub use transport::{Transport, TransportError};
