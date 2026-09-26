//! Agent 引擎的 **Tauri 命令层**（GUI 壳）
//!
//! 引擎本体在 `virlen-core`（零 `tauri::`）；本文件只做三件事：
//! 1. 把 [`TauriEventSink`] / `TauriHost` 注入引擎（[`init_agent_engine`]）；
//! 2. 暴露命令：`agent_send_message` / `agent_cancel` / `agent_kill_command` / `pty_*`
//!    / `agent_get_run_snapshot` / `agent_clear_run_snapshot` / `agent_dispose`
//!    / `cmd_list_tool_definitions` / `cmd_agent_prompts` / `cmd_provider_catalog`；
//! 3. 把 JS 侧回执转交引擎：`agent_tool_response` / `agent_user_interaction_response`
//!    / `agent_round_boundary_response` / `agent_provider_stream_event` / `agent_provider_stream_done`。
//!
//! 事件名与载荷形态**不得改动**（铁律 2：`AgentEventType` 是 TS emit / Rust emit /
//! `chat-service` / `rust-engine.ts` 四方共享契约）。

use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;

use virlen_core::agent::bridge::{self, AgentBridgeState};
use virlen_core::agent::cancellation::CancellationToken;
use virlen_core::agent::compress;
use virlen_core::agent::engine::AgentEngine;
use virlen_core::agent::event_sink::{self, EventSink};
use virlen_core::agent::provider::{DefaultProviderFactory, ProviderFactory};
use virlen_core::agent::types::AgentEvent;
use virlen_core::agent::usage;
use virlen_core::agent::{native_tools, prompts, provider, title, tool_defs, types};
use virlen_core::session_db::{NoopSessionRepo, NoopSettingsRepo, SessionRepo, SettingsRepo};

use super::session_db::{init_session_db, manage_noop_settings};

/// 事件出口（Tauri）：把引擎事件转发到前端窗口
///
/// core 侧只认 `EventSink` trait，本实现是**唯一**把事件绑到 Tauri emit 的地方。
pub struct TauriEventSink {
    app: tauri::AppHandle,
}

impl TauriEventSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_agent_event(&self, session_id: &str, event: &AgentEvent) {
        let payload = serde_json::json!({
            "sessionId": session_id,
            "event": event,
        });
        let _ = self.app.emit("agent:event", payload);
    }

    fn emit_raw(&self, event_name: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event_name, payload);
    }
}

/// 初始化 Agent 引擎（在应用启动时调用）
pub fn init_agent_engine(app: &tauri::AppHandle) {
    let bridge = Arc::new(AgentBridgeState::default());
    let sink: Arc<dyn event_sink::EventSink> = Arc::new(TauriEventSink::new(app.clone()));
    // 会话持久化：SQLite 直落；初始化失败时回退 Noop（不持久化），聊天功能不受影响
    let repo: Arc<dyn SessionRepo> = match init_session_db(app) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[session_db] 初始化失败，回退到 Noop: {}", e);
            // 配置仓储也要有兜底：否则设置页的 `cmd_settings_*` 会因「状态未注册」失败
            manage_noop_settings(app);
            Arc::new(NoopSessionRepo)
        }
    };
    // 应用配置仓储（`app_settings`）：`init_session_db` 已注册（失败分支注册 Noop），
    // 这里取同一个实例交给引擎 —— 原生工具 `web_search` 因此能读到与 CLI 相同的搜索源配置。
    let settings: Arc<dyn SettingsRepo> = app
        .try_state::<Arc<dyn SettingsRepo>>()
        .map(|s| s.inner().clone())
        .unwrap_or_else(|| Arc::new(NoopSettingsRepo));
    let engine = Arc::new(AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        repo.clone(),
        Arc::new(DefaultProviderFactory {
            bridge: bridge.clone(),
            sink: sink.clone(),
        }),
        // 宿主环境（GUI）：资源目录（视觉模型）+ 数据目录（会话库）。
        // 引擎核心只认 `HostEnv` trait，因此 headless / CLI 换 `CliHost` 即可。
        Arc::new(crate::host::TauriHost::new(app.clone())),
        settings,
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
/// ⚠️ `\x03` 只能影响「正在读 stdin 的进程」（shell 提示符 / REPL / `y/n` 提示）；中断主通道仍是
/// `agent_kill_command`（Job Object 杀树），见 docs/pty-research.md §5.6。
///
/// 会话 key 直接用 `toolCallId`，前端 `TerminalView` 已持有 → 无需新增映射事件；走 Tauri 命令而不
/// 经过引擎事件总线，因此不污染 `AgentEventType` 四方契约（铁律 2）。
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

/// 原生执行入口（前端回退路径用，`docs/pty-research.md` §7 #14）。
///
/// 让前端回退路径的 `execute_command` 也能享受 Rust 侧的原生能力：沙盒（受限令牌 + ACL）、ConPTY
/// （ANSI / 交互 / 用户插键盘）、统一超时/取消/接管、`uiData.pty` 标记。
///
/// 输出经 `ipc::Channel` 流式回传（而非 `app.emit`）：一步送到发起它的调用方，不经过引擎事件总线
/// → 不污染 `AgentEventType`（铁律 2），也无需前端安装/去重全局 `agent:tool-output` 监听（避免与
/// Rust 引擎路径重复 append）。
///
/// ⚠️ 审批不在这里做：前端 `execute_command` 已完成风险分类与审批（含 `confirm` / 绕过沙盒的强制
/// 审批）；本命令只负责「执行一条已获批准的命令」。
///
/// 返回 `{ content, uiData, isError }`：`isError = false` → 正常结果；`isError = true` → 工具级失败
/// （如退出码 >= 2），`content` 是模型侧英文报告。
///
/// ⚠️ 旧实现用 `Err(String)` 回失败，只能传一个字符串 → 结构化 `uiData` 丢失，中文界面下只能直显
/// 英文失败报告（遗留项 L6）。真正的「调用级」异常（沙盒只读拒绝等）仍走 `Err`。
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
        native_tools::NativeToolOutcome::Value { content, ui_data } => Ok(serde_json::json!({
            "content": content,
            "uiData": ui_data,
            "isError": false,
        })),
        // 退出码 >= 2 等失败：报告文本进 `content`（给模型），结构化字段进 `uiData`（给 UI）
        native_tools::NativeToolOutcome::Error { content, ui_data } => Ok(serde_json::json!({
            "content": content,
            "uiData": ui_data,
            "isError": true,
        })),
        native_tools::NativeToolOutcome::Interaction { .. } => {
            Err("unexpected outcome: interaction".to_string())
        }
        native_tools::NativeToolOutcome::Shelved => {
            Err("unexpected outcome: shelved".to_string())
        }
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

/// 列出工具定义（**机制 C**：Rust 侧 `agent/tool_defs/definitions.json` 是权威源）
///
/// 前端 `toolRegistry` 在 Tauri 环境经此取值；浏览器 dev / vitest 则直读同一份 JSON
/// （零漂移，不需要「快照 + 差异检查」那套）。
///
/// `platform` 省略时用当前平台（`std::env::consts::OS`）；显式传入主要用于取其它平台
/// 变体（测试、跨平台预览）。
#[tauri::command]
pub fn cmd_list_tool_definitions(platform: Option<String>) -> Vec<types::ToolDefinition> {
    match platform.as_deref() {
        Some(p) => tool_defs::list_tool_definitions_for(p),
        None => tool_defs::list_tool_definitions(),
    }
}

/// 列出全部模型侧提示词文本（**提示词 md 的唯一源在 `virlen-core`**，前端经此取值）
///
/// 与 `cmd_list_tool_definitions` 同一模式：权威源在 Rust，前端不再自带副本；
/// 浏览器 dev / vitest 直读 core 目录里的同一份 md（零漂移，不需要「快照 diff」那套）。
///
/// 提示词是**静态文本**（无平台变体、无运行期参数），因此没有入参、也无需预热缓存。
#[tauri::command]
pub fn cmd_agent_prompts() -> prompts::PromptTexts {
    prompts::all_prompt_texts()
}

/// 供应商目录（模板表 + 推理强度档位表）—— **权威源在 core**
///（`virlen-core/src/agent/provider/provider_catalog.json`）
///
/// 与 `cmd_agent_prompts` 同一模式：CLI 与 GUI 读同一份数据；前端浏览器 dev / vitest
/// 直读 core 目录里**同一份** json（`?raw`），因此两条路径不可能漂移。
///
/// 返回 `Result`：目录是**数据**，被改坏时应当给调用方一个可读错误，而不是 panic。
#[tauri::command]
pub fn cmd_provider_catalog() -> Result<provider::catalog::ProviderCatalog, String> {
    provider::catalog::provider_catalog()
}

/// 上下文压缩结果（GUI / CLI 共用 `virlen_core::agent::compress` 的实现）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressResultDto {
    /// 实际使用的压缩方式（`ai` / `raw`）
    pub mode: String,
    /// 摘要正文（= `message.content` 的字符串形态）
    pub summary: String,
    /// 待**追加**到会话末尾的 summary 消息（含 `usage` / `uiData`）
    pub message: types::Message,
    /// `raw` 模式省略的字符数（`ai` 恒为 0）
    pub omitted_chars: usize,
    /// 压缩后的上下文占用（本地估算）
    pub context_tokens: i64,
    /// `ai` 模式那次模型调用的记账信息（已由后端写入账本）；`raw` 为 `None`
    pub llm: Option<CompressLlmDto>,
}

/// `ai` 模式那次模型调用的记账信息
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressLlmDto {
    pub usage: types::TokenUsage,
    pub estimated: bool,
    pub duration_ms: i64,
}

/// 上下文压缩（GUI）—— 与 CLI 走**同一份** `virlen_core::agent::compress` 实现。
///
/// 为什么放后端：TS 侧原有一份 `compress-context.ts`（「同语义两实现」），统一到 core 后 GUI 与
/// CLI 的压缩口径只有一份，不会再漂移。
///
/// - `raw` 模式：纯本地渲染，不需要 provider；
/// - `ai` 模式：用 [`DefaultProviderFactory`]（GUI 有 JS 宿主，Gemini 等桥接协议照常走双向桥，与
///   正常聊天完全同一条路）。headless / CLI 没有 JS 宿主，走的是 `create_native_provider`。
///
/// 落库由前端完成（`cmd_replace_session_messages`）；记账在此完成（与 CLI 同一入口
/// `agent::usage::record_usage`，kind = `compress`，且不刷新会话时间）。
/// ⚠️ `#[allow(too_many_arguments)]`：Tauri 命令参数逐个从 JS 传，收结构体会要求前端改调用形状。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cmd_compress_context(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<AgentBridgeState>>,
    repo: tauri::State<'_, Arc<dyn SessionRepo>>,
    session: types::Session,
    messages: Vec<types::Message>,
    tool_defs: Vec<types::ToolDefinition>,
    mode: String,
    provider: Option<types::ProviderConnection>,
) -> Result<CompressResultDto, String> {
    let mode =
        compress::CompressMode::parse(&mode).ok_or_else(|| format!("未知的压缩方式: {}", mode))?;
    let provider_obj: Option<Box<dyn provider::Provider>> = match mode {
        compress::CompressMode::Ai => {
            let conn = provider.as_ref().ok_or_else(|| {
                "AI 摘要需要可用的 Provider（当前会话没有可用连接）".to_string()
            })?;
            // 与正常聊天同一个工厂：GUI 有 JS 宿主，gemini 等桥接协议照常工作
            let factory = DefaultProviderFactory {
                bridge: bridge.inner().clone(),
                sink: Arc::new(TauriEventSink::new(app.clone())),
            };
            Some(factory.create(conn))
        }
        compress::CompressMode::Raw => None,
    };
    let out = compress::compress(
        compress::CompressInput {
            mode,
            session: &session,
            messages: &messages,
            tool_defs: &tool_defs,
            provider: provider_obj.as_deref(),
        },
        &CancellationToken::new(),
    )
    .await?;
    // 记账：AI 摘要是一次真实消费（与 CLI 同一入口）；raw 没有模型调用 → `llm` 为 None → 不记账
    if let Some(llm) = &out.llm {
        let (ptype, pid) = provider
            .as_ref()
            .map(|p| (p.provider_type.as_str(), p.provider_id.as_str()))
            .unwrap_or(("", ""));
        usage::record_usage(
            repo.inner().as_ref(),
            &session.id,
            &session,
            ptype,
            pid,
            "compress",
            None,
            None,
            Some(llm.usage.clone()),
            llm.estimated,
            Some(llm.duration_ms),
        )
        .await;
    }
    Ok(CompressResultDto {
        mode: out.mode.as_str().to_string(),
        summary: out.summary,
        message: out.message,
        omitted_chars: out.omitted_chars,
        context_tokens: out.context_tokens,
        llm: out.llm.map(|l| CompressLlmDto {
            usage: l.usage,
            estimated: l.estimated,
            duration_ms: l.duration_ms,
        }),
    })
}

/// 会话标题生成结果（GUI DTO）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleResultDto {
    /// 清洗后的标题（保证非空）
    pub title: String,
    /// 那次模型调用的用量；provider 未回报时为 `None`
    pub usage: Option<types::TokenUsage>,
    /// 本次请求的墙钟耗时（含首字延迟）
    pub duration_ms: i64,
}

/// 会话标题生成（GUI）—— 与 CLI 走**同一份** `virlen_core::agent::title`。
///
/// 为什么放后端：TS 侧原有一份 `generate-title.ts`，与 Rust 那份是「同语义两实现」；
/// 统一到 core 后只有一份，不会再漂移。GUI 用 [`DefaultProviderFactory`]（有 JS 宿主，
/// Gemini 等桥接协议照常走双向桥，与正常聊天完全同一条路）；headless / CLI 走
/// `create_native_provider`（见 `virlen-cli/src/session_rt`）。
///
/// 落库（把标题写回会话）由调用方完成；**记账在此完成**（与 CLI 同一入口
/// `agent::usage::record_usage`，kind = `title`；provider 未回报 usage 时不记）。
#[tauri::command]
pub async fn cmd_generate_title(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<AgentBridgeState>>,
    repo: tauri::State<'_, Arc<dyn SessionRepo>>,
    session: types::Session,
    messages: Vec<types::Message>,
    provider: types::ProviderConnection,
) -> Result<TitleResultDto, String> {
    let factory = DefaultProviderFactory {
        bridge: bridge.inner().clone(),
        sink: Arc::new(TauriEventSink::new(app.clone())),
    };
    let provider_obj = factory.create(&provider);
    let out = title::generate_title(
        &session,
        &messages,
        provider_obj.as_ref(),
        &CancellationToken::new(),
    )
    .await?;
    if let Some(u) = &out.usage {
        usage::record_usage(
            repo.inner().as_ref(),
            &session.id,
            &session,
            &provider.provider_type,
            &provider.provider_id,
            "title",
            None,
            None,
            Some(u.clone()),
            false,
            Some(out.duration_ms),
        )
        .await;
    }
    Ok(TitleResultDto {
        title: out.title,
        usage: out.usage,
        duration_ms: out.duration_ms,
    })
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

/// JS 轮次边界回执（工具回复后、下一次 LLM 请求前要注入的消息，无则空数组）
#[tauri::command]
pub async fn agent_round_boundary_response(
    state: tauri::State<'_, Arc<AgentBridgeState>>,
    request_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    bridge::handle_round_boundary_response(state.inner().as_ref(), &request_id, payload).await;
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
