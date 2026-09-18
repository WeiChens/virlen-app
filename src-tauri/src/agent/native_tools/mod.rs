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
//! │   ├── common.rs          终端输出解码 / 命令解析与风险分类 / 运行中命令注册表 / run_command_native
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
//! └── knowledge_base/        知识库（6）
//!     ├── common.rs          rag_service / build_search_context
//!     ├── search_knowledge_base.rs        list_knowledge_bases.rs
//!     ├── list_knowledge_base_documents.rs  get_knowledge_base_document.rs
//!     └── delete_knowledge_base_document.rs write_to_knowledge_base.rs
//! ```
//!
//! 覆盖工具（与 JS `toolRegistry` 同名工具对齐）：
//! - `execute_command`：shell 命令执行（风险分类 → 审批 → 原生 spawn + 超时/取消）
//! - `execute_script`：写脚本文件并执行（可选执行后删除）
//! - `read_file` / `edit_file` / `write_file` / `list_files` / `delete_file` / `file_info`
//!   / `copy_move_file` / `mkdir`
//! - `search_files_by_name` / `search_text_in_files`
//! - `search_knowledge_base` / `list_knowledge_bases` / `list_knowledge_base_documents`
//!   / `get_knowledge_base_document` / `delete_knowledge_base_document` / `write_to_knowledge_base`
//!
//! 未覆盖的工具（skill、vision、web、user_choice 等）仍走 JS 桥。
//! 安全策略与前端 `securityService.resolveSafePath` / `securityPort.isPathAllowed` 对齐。

mod common;
mod execute;
mod file;
mod knowledge_base;
mod search;

#[cfg(test)]
pub(crate) mod test_util;

// 保持原有公开路径不变：crate::agent::native_tools::{is_path_allowed, resolve_safe_path}
#[allow(unused_imports)]
pub use common::{is_path_allowed, resolve_safe_path};
pub(crate) use execute::kill_running_command;
// PTY 会话交互：前端中途插键盘 / 改窗口尺寸（Step 1）
pub(crate) use execute::{pty_resize, pty_write};

use crate::agent::bridge::AgentBridgeState;
use crate::agent::cancellation::CancellationToken;
use crate::agent::event_sink::EventSink;
use crate::agent::types::NativeToolSecurity;
use serde_json::Value;

// ==================== 统一结果 ====================

/// 原生工具结果 — 与 `BridgeToolResult` 对齐，便于下游统一处理
#[derive(Debug, Clone)]
pub enum NativeToolOutcome {
    Value { content: String, ui_data: Option<Value> },
    Error(String),
    /// 保留：原生工具需要用户交互时（如 user_choice 原生化）返回此变体
    #[allow(dead_code)]
    Interaction { interaction_type: String, interaction_data: Value },
    /// 用户暂存交互 — 由 `execute_single_step` 转换为 `__SHELVED__` 暂停标记
    Shelved,
}

/// 原生工具执行上下文
pub struct NativeToolCtx<'a> {
    pub session_id: &'a str,
    pub tool_call_id: &'a str,
    pub cancel: &'a CancellationToken,
    pub sink: &'a dyn EventSink,
    pub bridge: &'a AgentBridgeState,
    pub security: &'a NativeToolSecurity,
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
        _ => Err(format!("Tool \"{}\" not implemented natively", tool_name)),
    }
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
                matches!(outcome, Err(_)),
                "write outside workspace should fail"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
