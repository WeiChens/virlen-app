//! 原生工具执行器 — 高价值工具在 Rust 侧直接执行（无需 JS 桥往返）
//!
//! 目录结构与 JS 侧工具注册表 `src/infrastructure/tools/` 一一对应：
//! 一个工具一个文件，分类内公共函数下沉到 `<分类>/common.rs`。
//!
//! ```text
//! native_tools/
//! ├── mod.rs                 统一结果 NativeToolOutcome / 上下文 NativeToolCtx / 分发 execute_native_tool
//! ├── common.rs              跨分类公共：参数取值辅助 arg_*、安全路径解析 resolve_safe_path / is_path_allowed
//! ├── execute/               代码执行（2）
//! │   ├── common/           终端输出解码 / 命令解析与风险分类 / 运行中命令注册表 / run_command_native
//! │   │   ├── decode.rs     终端输出解码（UTF-8 优先 / GBK 兜底 / 有界缓冲）
//! │   │   ├── classify.rs   命令解析与风险分类
//! │   │   ├── registry.rs   运行中命令注册表（前端「终止」）
//! │   │   ├── terminal.rs   终端输出处理（ANSI / \r 覆盖）
//! │   │   └── runner/       统一运行器（pipes / pty / sandbox）
//! │   ├── execute_command.rs
//! │   └── execute_script.rs
//! ├── file/                  文件操作（8）
//! │   ├── common.rs          format_size / ensure_parent_dir / format_system_time
//! │   ├── read_file.rs       write_file.rs   edit_file.rs    delete_file.rs
//! │   └── copy_move_file.rs  list_files.rs   file_info.rs    mkdir.rs
//! ├── search/                搜索（2）
//! │   ├── common.rs          glob_to_regex / escape_regex
//! │   ├── search_files_by_name.rs
//! │   └── search_text_in_files.rs
//! ├── plan/                  任务清单（1）
//! │   ├── common.rs          清单归一化 / 统计 / 软校验 / 渲染（对齐 TS `domain/todo/state.ts`）
//! │   └── todo_write.rs
//! ├── system/                系统（2）
//! │   ├── user_choice.rs     交互请求（无执行逻辑，仅经交互通道交给 UI）
//! │   └── get_current_time.rs 当前时间（IANA 时区，chrono-tz）
//! ├── chat/                  会话消息（2）
//! │   ├── common.rs          文本格式化 / 输出上限 / 单会话字符预算（对齐 TS `tools/chat/common.ts`）
//! │   ├── list_messages.rs   列出「已压缩区间」的消息时序
//! │   └── read_messages.rs   按锚点读窗口内消息正文
//! ├── skill/                 技能（2）
//! │   ├── common.rs          SKILL.md 元信息解析 / 目录扫描 / 文件树
//! │   ├── list_skills.rs
//! │   └── read_skill_source.rs
//! ├── vision/                视觉（1）
//! │   └── vision_analyze.rs  端侧视觉分析（模型目录经 `ctx.host` 定位；无 `tauri::`）
//! └── knowledge_base/        知识库（6）
//!     ├── common.rs          rag_service / build_search_context
//!     ├── search_knowledge_base.rs        list_knowledge_bases.rs
//!     ├── list_knowledge_base_documents.rs  get_knowledge_base_document.rs
//!     └── delete_knowledge_base_document.rs write_to_knowledge_base.rs
//! ├── memory/                长期记忆（3）
//! │   ├── common.rs          依赖组装（ctx → MemoryToolDeps）/ 结果转换
//! │   ├── memory_search.rs   关键词检索（FTS5 trigram，短查询回退 LIKE）
//! │   ├── memory_recall.rs   取详情正文（无详情 → 如实回「摘要即全文」）
//! │   └── memory_write.rs    写入记忆（`detail` 非空 → 详情落专用知识库）
//! ├── web/                   网络（2）
//! │   ├── common.rs          MAX_LENGTH / is_html / format_search_results（对齐 TS `tools/web/common.ts`）
//! │   ├── web_fetch.rs       抓 URL（reqwest + htmd；二进制拒绝 / 超时·取消 / 截断）
//! │   └── web_search.rs      经已配置搜索源检索（tavily / bocha；直读 `app_settings`）
//! ```
//!
//! **31 个工具全部有 Rust 原生实现**（不再有走 JS 桥的工具）。安全策略与前端
//! `securityService.resolveSafePath` / `securityPort.isPathAllowed` 对齐；各工具的模型侧
//! `content` / `uiData` 与 TS 回退路径逐字对齐（铁律 1）。

mod chat;
mod common;
mod execute;
mod file;
mod knowledge_base;
mod memory;
pub(crate) mod plan;
mod search;
mod skill;
mod system;
mod vision;
mod web;

#[cfg(test)]
pub(crate) mod test_util;

// 保持原有公开路径不变：crate::agent::native_tools::{is_path_allowed, resolve_safe_path}
#[allow(unused_imports)]
pub use common::{is_path_allowed, resolve_safe_path};
pub use execute::kill_running_command;
// `SandboxBypass`：TS 引擎入口 `run_command_for_ts_engine` 的脱壳原因入参（跨 crate）。
pub use execute::SandboxBypass;
// PTY 会话交互：前端中途插键盘 / 改窗口尺寸 / 命名控制键 / 接管交还（Step 1 + Step 2 ③②）
pub use execute::{pty_key, pty_resize, pty_set_held, pty_write};

use crate::agent::bridge::AgentBridgeState;
use crate::agent::cancellation::CancellationToken;
use crate::agent::event_sink::EventSink;
use crate::agent::host::HostEnv;
use crate::agent::types::NativeToolSecurity;
use crate::session_db::{
    MemoryRepo, NoopMemoryRepo, NoopSettingsRepo, NoopSessionRepo, SessionRepo, SettingsRepo,
};
use serde_json::Value;

// ==================== 统一结果 ====================

/// 原生工具结果 — 与 `BridgeToolResult` 对齐，便于下游统一处理
#[derive(Debug, Clone)]
pub enum NativeToolOutcome {
    Value { content: String, ui_data: Option<Value> },
    Error { content: String, ui_data: Option<Value> },
    /// 原生工具要求用户交互（如 `user_choice`）—— 由 `tool_executor` 转成
    /// `agent:user-interaction-request` 交给 UI（与 TS 引擎 `UserInteractionRequired` 同一通道）
    Interaction { interaction_type: String, interaction_data: Value },
    /// 用户暂存交互 — 由 `execute_single_step` 转换为 `__SHELVED__` 暂停标记
    Shelved,
}

impl NativeToolOutcome {
    /// 纯文本失败（无结构化信息 → UI 只能直显模型侧英文原文）
    pub(crate) fn error(content: impl Into<String>) -> Self {
        Self::Error {
            content: content.into(),
            ui_data: None,
        }
    }

    /// 带结构化 `ui_data` 的失败（D2 语义同 `Value`：`content` 给模型固定英文，`ui_data`
    /// 给 UI 按界面语言重建）。例：`execute_command` 退出码 >= 2 时仍下发
    /// `{ stdout, stderr, exitCode, pty, waitReason }`。
    pub(crate) fn error_with_ui(content: impl Into<String>, ui_data: Value) -> Self {
        Self::Error {
            content: content.into(),
            ui_data: Some(ui_data),
        }
    }
}

/// 原生工具执行上下文
pub struct NativeToolCtx<'a> {
    pub session_id: &'a str,
    pub tool_call_id: &'a str,
    pub cancel: &'a CancellationToken,
    pub sink: &'a dyn EventSink,
    pub bridge: &'a AgentBridgeState,
    pub security: &'a NativeToolSecurity,
    /// 会话持久化后端（消息查询工具用）。显式注入：Agent 引擎路径传入真实 `SessionRepo`；
    /// TS 引擎路径与测试用 [`noop_repo`]（可用性 false）。
    pub repo: &'a dyn SessionRepo,
    /// 本 agent 启用的技能名（`session.skills`）—— 技能工具用它做过滤与授权判断。
    pub skills: Option<&'a [String]>,
    /// 宿主环境（资源目录 / 数据目录）。显式注入：GUI = `TauriHost`，CLI = `CliHost`，
    /// 回退路径与测试 = `host::default_host()`。用途：`vision_analyze` 定位模型文件。
    /// ⚠️ 引擎核心里 `tauri::` 命中数必须保持 0，宿主差异全收在 `HostEnv` 后端。
    pub host: &'a dyn HostEnv,
    /// 应用配置仓储（`app_settings` 表）—— 需要读配置的原生工具用。显式注入：GUI / CLI 用
    /// 与会话库共连接的 `SqliteSettingsRepo`；TS 引擎路径与测试用 [`noop_settings`]（空表 →
    /// 工具按「未配置」处理）。用途：`web_search` 读 `searchProviders` / `defaultSearchProviderId`。
    pub settings: &'a dyn SettingsRepo,
    /// 长期记忆仓储（`memories` 表）。与会话库共用同一把连接锁，写入天然互斥。
    /// 回退路径（TS 引擎入口 / 无库环境）→ [`noop_memory`]：记忆工具如实回「本地存储不可用」。
    pub memory: &'a dyn MemoryRepo,
}

/// 无持久化后端的 `SessionRepo` 占位。⚠️ `is_available() == false`，消息查询工具会如实回
/// 「本地存储不可用」，而不是把空结果误报成「该会话还没有消息」。
pub fn noop_repo() -> &'static NoopSessionRepo {
    static REPO: once_cell::sync::Lazy<NoopSessionRepo> =
        once_cell::sync::Lazy::new(NoopSessionRepo::default);
    &REPO
}

/// 无持久化后端的 `SettingsRepo` 占位（TS 引擎路径与测试用）。`get_all()` 返回空表（不是 Err），
/// 依赖配置的工具因此得到「未配置」这种正常结论，而非误报工具失败。
pub fn noop_settings() -> &'static NoopSettingsRepo {
    static SETTINGS: once_cell::sync::Lazy<NoopSettingsRepo> =
        once_cell::sync::Lazy::new(NoopSettingsRepo::default);
    &SETTINGS
}

/// 无持久化后端的 `MemoryRepo` 占位。⚠️ `is_available() == false`，记忆工具如实回
/// 「本地存储不可用」，而不是把空结果误报成「没有相关记忆」。
pub fn noop_memory() -> &'static NoopMemoryRepo {
    static MEMORY: once_cell::sync::Lazy<NoopMemoryRepo> =
        once_cell::sync::Lazy::new(NoopMemoryRepo::default);
    &MEMORY
}

/// 是否由原生 Rust 直接执行（否则走 JS 桥）
pub fn is_native_tool(name: &str) -> bool {
    matches!(
        name,
        "execute_command"
            | "execute_script"
            | "read_file"
            | "edit_file"
            | "write_file"
            | "list_files"
            | "delete_file"
            | "file_info"
            | "copy_move_file"
            | "mkdir"
            | "search_files_by_name"
            | "search_text_in_files"
            | "search_knowledge_base"
            | "list_knowledge_bases"
            | "list_knowledge_base_documents"
            | "get_knowledge_base_document"
            | "delete_knowledge_base_document"
            | "write_to_knowledge_base"
            | "todo_write"
            | "user_choice"
            | "list_messages"
            | "read_messages"
            | "list_skills"
            | "read_skill_source"
            | "get_current_time"
            | "vision_analyze"
            | "web_fetch"
            | "web_search"
            | "memory_search"
            | "memory_recall"
            | "memory_write"
    )
}

/// 执行原生工具
pub async fn execute_native_tool(
    ctx: &NativeToolCtx<'_>,
    tool_name: &str,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    match tool_name {
        "execute_command" => execute::execute_command_tool(ctx, args).await,
        "execute_script" => execute::execute_script_tool(ctx, args).await,
        "read_file" => file::read_file_tool(ctx, args).await,
        "edit_file" => file::edit_file_tool(ctx, args).await,
        "write_file" => file::write_file_tool(ctx, args).await,
        "list_files" => file::list_files_tool(ctx, args).await,
        "delete_file" => file::delete_file_tool(ctx, args).await,
        "file_info" => file::file_info_tool(ctx, args).await,
        "copy_move_file" => file::copy_move_file_tool(ctx, args).await,
        "mkdir" => file::mkdir_tool(ctx, args).await,
        "search_files_by_name" => search::search_files_by_name_tool(ctx, args).await,
        "search_text_in_files" => search::search_text_in_files_tool(ctx, args).await,
        "search_knowledge_base" => knowledge_base::search_knowledge_base_tool(ctx, args).await,
        "list_knowledge_bases" => knowledge_base::list_knowledge_bases_tool(ctx, args).await,
        "list_knowledge_base_documents" => {
            knowledge_base::list_knowledge_base_documents_tool(ctx, args).await
        }
        "get_knowledge_base_document" => {
            knowledge_base::get_knowledge_base_document_tool(ctx, args).await
        }
        "delete_knowledge_base_document" => {
            knowledge_base::delete_knowledge_base_document_tool(ctx, args).await
        }
        "write_to_knowledge_base" => knowledge_base::write_to_knowledge_base_tool(ctx, args).await,
        "todo_write" => plan::todo_write_tool(ctx, args).await,
        "user_choice" => system::user_choice_tool(ctx, args).await,
        "list_messages" => chat::list_messages_tool(ctx, args).await,
        "read_messages" => chat::read_messages_tool(ctx, args).await,
        "list_skills" => skill::list_skills_tool(ctx, args).await,
        "read_skill_source" => skill::read_skill_source_tool(ctx, args).await,
        "get_current_time" => system::get_current_time_tool(ctx, args).await,
        "vision_analyze" => vision::vision_analyze_tool(ctx, args).await,
        "web_fetch" => web::web_fetch_tool(ctx, args).await,
        "web_search" => web::web_search_tool(ctx, args).await,
        "memory_search" => memory::memory_search_tool(ctx, args).await,
        "memory_recall" => memory::memory_recall_tool(ctx, args).await,
        "memory_write" => memory::memory_write_tool(ctx, args).await,
        _ => Err(format!("Tool \"{}\" not implemented natively", tool_name)),
    }
}

/// 供 **TS 引擎路径** 执行命令（`docs/pty-research.md` §7 #14）：把执行下沉到原生运行器
/// （沙盒优先 + ConPTY + 超时/取消/接管），经 `EventSink` 流式回传。
///
/// 与 `execute_native_tool` 的**唯一区别**：**不做风险分类与审批**（那由 TS 侧负责），
/// 本入口只执行一条已获批准的命令。`bypass` 用枚举而非两个 `bool`，避免非法组合。
pub async fn run_command_for_ts_engine(
    sink: &dyn EventSink,
    session_id: &str,
    tool_call_id: &str,
    command: &str,
    security: &NativeToolSecurity,
    timeout_secs: i64,
    bypass: execute::SandboxBypass,
) -> Result<NativeToolOutcome, String> {
    // TS 引擎的「终止」走 `agent_kill_command`（运行中命令注册表），不依赖这个 token，
    // 故用一个永不触发的 token（`run_command_native` 内部另有独立 kill 通道）。
    let cancel = CancellationToken::new();
    let bridge = AgentBridgeState::default();
    let ctx = NativeToolCtx {
        session_id,
        tool_call_id,
        cancel: &cancel,
        sink,
        bridge: &bridge,
        security,
        repo: noop_repo(),
        skills: None,
        // TS 引擎路径不经过 AgentEngine，拿不到构造期注入的宿主；execute_command 也不用
        // 宿主信息，故用进程级默认宿主。
        host: crate::host::default_host().as_ref(),
        settings: crate::agent::native_tools::noop_settings(),
        memory: crate::agent::native_tools::noop_memory(),
    };
    execute::run_command_native(&ctx, command, timeout_secs, bypass).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_native_dispatcher_write_read_search() {
        use super::test_util::test_security;
        use crate::agent::bridge::AgentBridgeState;
        use crate::agent::cancellation::CancellationToken;
        use crate::agent::event_sink::TestEventSink;
        use serde_json::json;

        let dir = std::env::temp_dir().join(format!("virlen_native_dispatch_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s1",
            tool_call_id: "tc_1",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: noop_repo(),
            memory: crate::agent::native_tools::noop_memory(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
        };

        // 1. write_file（相对路径 → workspace 下，自动建父目录）
        let args = json!({ "path": "a/b.txt", "content": "hello world" });
        let outcome = execute_native_tool(&ctx, "write_file", &args).await.unwrap();
        let content = match outcome {
            NativeToolOutcome::Value { content, .. } => content,
            other => panic!("expected value, got {:?}", other),
        };
        assert!(content.contains("b.txt"), "write result: {}", content);

        // 2. read_file
        let args = json!({ "path": "a/b.txt" });
        let outcome = execute_native_tool(&ctx, "read_file", &args).await.unwrap();
        let content = match outcome {
            NativeToolOutcome::Value { content, .. } => content,
            other => panic!("expected value, got {:?}", other),
        };
        assert!(content.contains("hello world"), "read result: {}", content);

        // 3. search_files_by_name
        let args = json!({ "path": ".", "query": "b.txt" });
        let outcome = execute_native_tool(&ctx, "search_files_by_name", &args).await.unwrap();
        let content = match outcome {
            NativeToolOutcome::Value { content, .. } => content,
            other => panic!("expected value, got {:?}", other),
        };
        assert!(content.contains("b.txt"), "search result: {}", content);

        // 4. 写权限越界（绝对路径在 workspace 外）应被拒绝
        let outside = std::env::temp_dir().join(format!("virlen_outside_{}", uuid::Uuid::new_v4()));
        let outside_str = outside.to_string_lossy().replace('\\', "/");
        if !outside_str.starts_with(&dir.to_string_lossy().replace('\\', "/")) {
            let args = json!({ "path": outside_str, "content": "x" });
            let outcome = execute_native_tool(&ctx, "write_file", &args).await;
            assert!(
                outcome.is_err(),
                "write outside workspace should fail"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// §7 #14：TS 引擎路径的执行入口必须复用原生运行器（沙盒 + PTY + uiData 标记）。
    /// 这里用「裸跑」security 避开沙盒 ACL 的前置开销，只验证「结果形状」。
    #[tokio::test]
    async fn test_ts_engine_runner_shares_native_runner() {
        use super::test_util::test_security_bare;
        use crate::agent::event_sink::TestEventSink;

        let dir = std::env::temp_dir().join(format!("virlen_ts_engine_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security_bare(&dir.to_string_lossy());
        let sink = TestEventSink::new();

        let outcome = run_command_for_ts_engine(
            &sink,
            "s_ts",
            "tc_ts",
            "echo hello_ts_engine",
            &sec,
            30,
            execute::SandboxBypass::None,
        )
        .await
        .expect("TS 引擎执行入口不应报错");

        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                assert!(content.contains("hello_ts_engine"), "content: {content}");
                let ui = ui_data.expect("原生运行器应下发 uiData");
                assert_eq!(ui.get("exitCode").and_then(|v| v.as_i64()), Some(0), "uiData: {ui}");
                // Windows → true（ConPTY）；其他平台 → false（管道）。两种情况都得有该标记。
                assert!(ui.get("pty").is_some(), "uiData 应带 pty 标记: {ui}");
                // 本次实际沙盒模式（UI 徽标用）—— 裸跑 security（sandbox_mode=off）下应为 "no_sandbox_disabled"。
                assert_eq!(
                    ui.get("sandbox").and_then(|v| v.as_str()),
                    Some("no_sandbox_disabled"),
                    "uiData 应带 sandbox 标记: {ui}"
                );
            }
            other => panic!("expected Value, got {other:?}"),
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
