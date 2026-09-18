//! Agent 引擎模块 — Rust 原生聊天循环
//!
//! 移植自 `src/domain/engine/`（TS）。
//! 通过 Tauri 命令 + 事件桥与前端协作：
//! - 命令：agent_send_message / agent_cancel / agent_get_run_snapshot / agent_clear_run_snapshot
//! - 回执：agent_tool_response / agent_user_interaction_response / agent_provider_stream_event / agent_provider_stream_done
//! - 事件：agent:event（标准 AgentEvent）、agent:tool-request、agent:user-interaction-request、agent:provider-request

pub mod bridge;
pub mod cancellation;
pub mod engine;
pub mod event_sink;
pub mod iteration;
pub mod llm_loop;
pub mod llm_round;
pub mod native_tools;
pub mod package_cache_roots;
pub mod process_tree;
pub mod provider;
pub mod run_state;
pub mod storm_breaker;
pub mod tool_executor;
pub mod types;
pub mod verifier;

use crate::agent::bridge::AgentBridgeState;
use crate::agent::engine::AgentEngine;
use crate::agent::event_sink::TauriEventSink;
use crate::agent::provider::DefaultProviderFactory;
use crate::session_db::{self, NoopSessionRepo, SessionRepo};
use std::sync::Arc;
use tauri::Manager;

/// 初始化 Agent 引擎（在应用启动时调用）
pub fn init_agent_engine(app: &tauri::AppHandle) {
    let bridge = Arc::new(AgentBridgeState::default());
    let sink: Arc<dyn event_sink::EventSink> = Arc::new(TauriEventSink::new(app.clone()));
    // 会话持久化：SQLite 直落；初始化失败时回退 Noop（不持久化），聊天功能不受影响
    let repo: Arc<dyn SessionRepo> = match session_db::init_session_db(app) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[session_db] 初始化失败，回退到 Noop: {}", e);
            Arc::new(NoopSessionRepo)
        }
    };
    let engine = Arc::new(AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        repo.clone(),
        Arc::new(DefaultProviderFactory {
            bridge: bridge.clone(),
            sink: sink.clone(),
        }),
    ));
    app.manage(bridge);
    app.manage(engine);
    app.manage(repo);
}

// ==================== Tauri 命令 ====================

/// 发送消息 — 启动聊天循环（事件通过 agent:event 流式返回）
#[tauri::command]
pub async fn agent_send_message(
    state: tauri::State<'_, Arc<AgentEngine>>,
    options: types::SendMessageOptions,
) -> Result<(), String> {
    state.send_message(options).await
}

/// 取消当前正在处理的请求
#[tauri::command]
pub fn agent_cancel(state: tauri::State<'_, Arc<AgentEngine>>, session_id: String) {
    state.cancel(&session_id);
}

/// 终止指定 tool_call_id 正在运行的命令（前端 ToolOutput.kill 回调）
#[tauri::command]
pub fn agent_kill_command(tool_call_id: String) -> bool {
    native_tools::kill_running_command(&tool_call_id)
}

/// 向正在运行的 PTY 会话写入数据（用户中途插键盘，Step 1）。
///
/// `data` 是原始文本：普通按键、粘贴内容，或控制字节（`\x03` = Ctrl+C）。
/// ⚠️ `\x03` 只能影响「正在读 stdin 的进程」（shell 提示符 / REPL / `y/n` 提示）；
/// 中断主通道仍是 `agent_kill_command`（Job Object 杀树），见 docs/pty-research.md §5.6。
///
/// 会话 key 直接用 `toolCallId`，前端 `TerminalView` 已持有 → 无需新增映射事件；
/// 走 Tauri 命令而不经过引擎事件总线，因此不污染 `AgentEventType` 四方契约（铁律 2）。
#[tauri::command]
pub fn pty_write(tool_call_id: String, data: String) -> bool {
    native_tools::pty_write(&tool_call_id, &data)
}

/// 调整正在运行的 PTY 会话尺寸（前端终端 fit 后调用）。返回是否找到会话并调整成功。
#[tauri::command]
pub fn pty_resize(tool_call_id: String, cols: u16, rows: u16) -> bool {
    native_tools::pty_resize(&tool_call_id, cols, rows)
}

/// 向正在运行的 PTY 会话发送**命名控制键**（Step 2 ③）。
///
/// 前端只发键名（如 `["enter"]` / `["ctrl+c"]` / `["up"]`），映射表在 Rust 侧
/// （`pty_session::key_sequence`）—— 命名→字节只有一份实现（铁律 1 的同类问题）。
/// 未知键名逐个跳过；返回是否至少写入了一个有效键（会话不存在 / 全部无效 → false）。
#[tauri::command]
pub fn pty_key(tool_call_id: String, keys: Vec<String>) -> bool {
    native_tools::pty_key(&tool_call_id, &keys)
}

/// 设置 PTY 会话的「接管」状态（Step 2 ②）。
///
/// `held=true` 时运行器**冻结超时预算**（用户慢慢输密码 / 走 OAuth 跳转，不该被超时杀掉）；
/// `held=false`（交还）恢复按剩余预算继续。接管**不等于**取消：
/// `agent_kill_command` / `agent_cancel` 在接管期间仍可用。
/// 返回是否命中会话（命令已结束 → false，前端据此复位按钮）。
#[tauri::command]
pub fn pty_set_held(tool_call_id: String, held: bool) -> bool {
    native_tools::pty_set_held(&tool_call_id, held)
}

/// TS 引擎路径的「原生执行」入口（`docs/pty-research.md` §7 #14）。
///
/// 让 TS 引擎的 `execute_command` 也能享受 Rust 侧的原生能力：沙盒（受限令牌 + ACL）、
/// ConPTY（ANSI / 交互 / 用户插键盘）、统一超时/取消/接管、`uiData.pty` 标记。
///
/// 输出经 **`ipc::Channel`** 流式回传（而非 `app.emit`）：一步送到发起它的调用方，
/// **不经过引擎事件总线** → 不污染 `AgentEventType`（铁律 2），也无需前端安装/去重
/// 全局 `agent:tool-output` 监听（避免与 Rust 引擎路径重复 append）。
///
/// ⚠️ **审批不在这里做**：TS 侧 `execute_command` 已完成风险分类与审批（含 `confirm` / 绕过
/// 沙盒的强制审批）；本命令只负责「执行一条已获批准的命令」。
#[tauri::command]
pub async fn pty_run_command(
    session_id: String,
    tool_call_id: String,
    command: String,
    security: types::NativeToolSecurity,
    timeout_secs: i64,
    bypass_sandbox: bool,
    on_output: tauri::ipc::Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let sink = ChannelEventSink { channel: on_output };
    let outcome = native_tools::run_command_for_ts_engine(
        &sink,
        &session_id,
        &tool_call_id,
        &command,
        &security,
        timeout_secs,
        bypass_sandbox,
    )
    .await?;
    match outcome {
        native_tools::NativeToolOutcome::Value { content, ui_data } => {
            Ok(serde_json::json!({ "content": content, "uiData": ui_data }))
        }
        // 退出码 >= 2 等失败情况：原生运行器已把报告文本封进 Error
        native_tools::NativeToolOutcome::Error(msg) => Err(msg),
        other => Err(format!("unexpected outcome: {other:?}")),
    }
}

/// 把原生运行器的 `agent:tool-output` 事件转发到 `ipc::Channel`（其余事件忽略）。
struct ChannelEventSink {
    channel: tauri::ipc::Channel<serde_json::Value>,
}

impl event_sink::EventSink for ChannelEventSink {
    fn emit_agent_event(&self, _session_id: &str, _event: &types::AgentEvent) {}
    fn emit_raw(&self, event_name: &str, payload: serde_json::Value) {
        if event_name == "agent:tool-output" {
            let _ = self.channel.send(payload);
        }
    }
}

/// 获取当前会话的运行快照
#[tauri::command]
pub fn agent_get_run_snapshot(
    state: tauri::State<'_, Arc<AgentEngine>>,
    session_id: String,
) -> Option<types::RunSnapshot> {
    state.get_run_snapshot(&session_id)
}

/// 清除运行快照
#[tauri::command]
pub fn agent_clear_run_snapshot(
    state: tauri::State<'_, Arc<AgentEngine>>,
    session_id: String,
) {
    state.clear_run_snapshot(&session_id);
}

/// 销毁引擎（应用退出时）
#[tauri::command]
pub fn agent_dispose(state: tauri::State<'_, Arc<AgentEngine>>) {
    state.dispose();
}

// ==================== 桥接回执 ====================

/// JS 工具执行回执
#[tauri::command]
pub async fn agent_tool_response(
    state: tauri::State<'_, Arc<AgentBridgeState>>,
    request_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    bridge::handle_tool_response(state.inner().as_ref(), &request_id, payload).await;
    Ok(())
}

/// JS 用户交互回执
#[tauri::command]
pub async fn agent_user_interaction_response(
    state: tauri::State<'_, Arc<AgentBridgeState>>,
    request_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    bridge::handle_user_interaction_response(state.inner().as_ref(), &request_id, payload).await;
    Ok(())
}

/// JS Provider 流事件（流式桥）
#[tauri::command]
pub async fn agent_provider_stream_event(
    state: tauri::State<'_, Arc<AgentBridgeState>>,
    request_id: String,
    event: serde_json::Value,
) -> Result<(), String> {
    bridge::handle_provider_stream_event(state.inner().as_ref(), &request_id, event).await;
    Ok(())
}

/// JS Provider 流结束 / 非流式结果
#[tauri::command]
pub async fn agent_provider_stream_done(
    state: tauri::State<'_, Arc<AgentBridgeState>>,
    request_id: String,
    result: Option<types::Message>,
    error: Option<String>,
) -> Result<(), String> {
    bridge::handle_provider_stream_done(state.inner().as_ref(), &request_id, result, error).await;
    Ok(())
}
