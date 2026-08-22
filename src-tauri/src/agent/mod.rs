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
