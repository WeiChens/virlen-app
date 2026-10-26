//! Agent 引擎的 Tauri 命令层。引擎本体在 virlen-core（零 tauri::），本文件只做注入宿主、
//! 暴露命令、转交回执。
//!
//! ⚠️ 事件名与载荷形态不得改动（AgentEventType 是四方共享契约）。

use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;

use virlen_core::agent::bridge::{self, AgentBridgeState};
use virlen_core::agent::cancellation::CancellationToken;
use virlen_core::agent::compress;
use virlen_core::agent::engine::AgentEngine;
use virlen_core::agent::event_sink::{self, EventSink};
use virlen_core::agent::host::HostEnv;
use virlen_core::agent::provider::{DefaultProviderFactory, ProviderFactory};
use virlen_core::agent::types::AgentEvent;
use virlen_core::agent::usage;
use virlen_core::agent::{native_tools, prompts, provider, title, tool_defs, types};
use virlen_core::session_db::{
    MemoryRepo, NoopMemoryRepo, NoopSessionRepo, NoopSettingsRepo, SessionRepo, SettingsRepo,
};

use super::session_db::{init_session_db, manage_noop_settings};

/// 事件出口（Tauri）：把引擎事件转发到前端窗口。core 只认 EventSink trait。
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

/// 后台服务结束通知的 GUI 出口：Rust 把已组装好的消息交来，前端只负责落进消息列表。
/// 返回 false 时通知留在 Rust 队列，下次请求前注入。事件名不进 AgentEventType。
pub struct TauriServiceNoticeHost {
    app: tauri::AppHandle,
}

impl TauriServiceNoticeHost {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl native_tools::ServiceNoticeHost for TauriServiceNoticeHost {
    fn present_service_notice(&self, session_id: &str, message: serde_json::Value) -> bool {
        self.app
            .emit(
                "agent:service-exit",
                serde_json::json!({ "sessionId": session_id, "message": message }),
            )
            .is_ok()
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
    // 应用配置仓储（app_settings）：init_session_db 已注册（失败时 Noop），
    // 把同一实例交给引擎，原生工具 web_search 才能读到与 CLI 相同的配置
    let settings: Arc<dyn SettingsRepo> = app
        .try_state::<Arc<dyn SettingsRepo>>()
        .map(|s| s.inner().clone())
        .unwrap_or_else(|| Arc::new(NoopSettingsRepo));
    // 长期记忆仓储：同一把连接；库打不开时退化为 Noop（工具如实说「本地存储不可用」）
    let memory: Arc<dyn MemoryRepo> = app
        .try_state::<Arc<dyn MemoryRepo>>()
        .map(|s| s.inner().clone())
        .unwrap_or_else(|| Arc::new(NoopMemoryRepo));
    // 宿主环境（GUI）：资源目录 + 数据目录；headless / CLI 换 CliHost 即可
    let host = crate::host::TauriHost::new(app.clone());
    // 图片附件目录 = `<data_dir>/attachments`（与 `virlen.db` 同级）：
    // 登记进程级实例，`virlen-attachment` 协议处理器与外置写入才能指向同一份根。
    virlen_core::attachment::init_global(&host.data_dir());
    let engine = Arc::new(AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        repo.clone(),
        Arc::new(DefaultProviderFactory {
            bridge: bridge.clone(),
            sink: sink.clone(),
        }),
        Arc::new(host),
        settings,
        memory,
    ));
    app.manage(bridge);
    app.manage(engine);
    app.manage(repo);
    // 后台服务结束通知的界面出口（必须在引擎能起服务之前接上）
    native_tools::attach_service_notice_host(Arc::new(TauriServiceNoticeHost::new(app.clone())));
    // 用户终端的输出推送出口（`terminal:output`）：接上以后键入回显不再等轮询
    native_tools::attach_output_host(Arc::new(
        crate::commands::terminal::TauriTerminalOutputHost::new(app.clone()),
    ));
    // 记忆再蒸馏调度宿主：挂上后立刻尝试排空一次，之后由写路径闸门唤醒
    virlen_core::agent::memory::redistill::sched::attach_host(Arc::new(
        crate::commands::memory::GuiRedistillRuntime::new(app.clone()),
    ));
    // 启动补跑：此刻队列是空的，先判定一次
    crate::commands::memory::request_redistill_on_startup(app);
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

/// 向正在运行的 PTY 会话写入数据（用户中途插键盘）。
///
/// data 是原始文本：按键 / 粘贴 / 控制字节（\x03 = Ctrl+C，只影响正在读 stdin 的进程）。
/// 中断主通道仍是 agent_kill_command。会话 key 直接用 toolCallId。
#[tauri::command]
pub fn pty_write(tool_call_id: String, data: String) -> bool {
    native_tools::pty_write(&tool_call_id, &data)
}

/// 调整正在运行的 PTY 会话尺寸（前端终端 fit 后调用）。返回是否找到会话并调整成功。
#[tauri::command]
pub fn pty_resize(tool_call_id: String, cols: u16, rows: u16) -> bool {
    native_tools::pty_resize(&tool_call_id, cols, rows)
}

/// 向 PTY 发送命名控制键：前端只发键名，映射表在 Rust 侧（只有一份实现）。
#[tauri::command]
pub fn pty_key(tool_call_id: String, keys: Vec<String>) -> bool {
    native_tools::pty_key(&tool_call_id, &keys)
}

/// 设置 PTY 会话的接管状态。held=true 时冻结超时预算；接管不等于取消（kill / cancel 仍可用）。
/// 返回是否命中会话（命令已结束 → false，前端据此复位按钮）。
#[tauri::command]
pub fn pty_set_held(tool_call_id: String, held: bool) -> bool {
    native_tools::pty_set_held(&tool_call_id, held)
}

/// 原生执行入口（前端回退路径用）：沙盒 + ConPTY + 统一超时取消。
/// 输出经 ipc::Channel 流式回传，不经引擎事件总线。
/// 审批不在这里做：调用方负责风险分类。isError = true 是工具级失败，调用级异常仍走 Err。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn pty_run_command(
    session_id: String,
    tool_call_id: String,
    command: String,
    security: types::NativeToolSecurity,
    timeout_secs: i64,
    bypass_sandbox: bool,
    bypass_by_rule: bool,
    on_output: tauri::ipc::Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let sink = ChannelEventSink { channel: on_output };
    // 两个 bool 入参 → 脱壳原因枚举；优先级与 Rust 侧一致（命中规则优先于本轮审批）
    let bypass = if bypass_by_rule {
        native_tools::SandboxBypass::Rule
    } else if bypass_sandbox {
        native_tools::SandboxBypass::Requested
    } else {
        native_tools::SandboxBypass::None
    };
    let outcome = native_tools::run_command_for_ts_engine(
        &sink,
        &session_id,
        &tool_call_id,
        &command,
        &security,
        timeout_secs,
        bypass,
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
        // 实时输出与沙盒模式都要送到发起方；其余事件忽略
        if event_name == "agent:tool-output" || event_name == "agent:tool-env" {
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

/// 列出工具定义（Rust 侧 definitions.json 是权威源；前端经此取值，浏览器 dev 直读同一份）。
/// platform 省略时用当前平台，显式传入用于取其它平台变体。
#[tauri::command]
pub fn cmd_list_tool_definitions(platform: Option<String>) -> Vec<types::ToolDefinition> {
    match platform.as_deref() {
        Some(p) => tool_defs::list_tool_definitions_for(p),
        None => tool_defs::list_tool_definitions(),
    }
}

/// 列出全部模型侧提示词文本（权威源在 core，与工具定义同一模式）。提示词是静态文本，无入参。
#[tauri::command]
pub fn cmd_agent_prompts() -> prompts::PromptTexts {
    prompts::all_prompt_texts()
}

/// 供应商目录（模板表 + 推理强度档位）—— 权威源在 core 的 provider_catalog.json。
/// 返回 Result：目录是数据，被改坏时给可读错误而不是 panic。
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

/// 上下文压缩（GUI）—— 与 CLI 走同一份实现。
/// raw 模式纯本地渲染；ai 模式用 DefaultProviderFactory（有 JS 宿主）。
/// 落库由前端完成，记账在此完成（与 CLI 同一入口，kind = compress）。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cmd_compress_context(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<AgentBridgeState>>,
    repo: tauri::State<'_, Arc<dyn SessionRepo>>,
    session: types::Session,
    mut messages: Vec<types::Message>,
    tool_defs: Vec<types::ToolDefinition>,
    mode: String,
    provider: Option<types::ProviderConnection>,
) -> Result<CompressResultDto, String> {
    let mode =
        compress::CompressMode::parse(&mode).ok_or_else(|| format!("未知的压缩方式: {}", mode))?;
    // 图片引用还原：库里只存 `attachment://<sha256>.<ext>`（见 `virlen_core::attachment`），
    // 而压缩入参是**前端 store 直传的历史**，里面仍是引用 —— 上游拿到这个私有协议只会
    // 400 `Unsupported image_url format`。与引擎组装聊天请求同口径（`AgentEngine::run` 亦调
    // `resolve_messages`）。`raw` 模式纯本地渲染、不发给模型，故不还原（省一次读盘 + base64）。
    if mode == compress::CompressMode::Ai {
        match virlen_core::attachment::global() {
            Some(store) => {
                store.resolve_messages(&mut messages);
            }
            // 未初始化时不阻断：与「失败只降级、不阻断」的约定一致，只是上游可能仍报 400
            None => eprintln!("[compress] 附件存储未初始化，图片引用无法还原"),
        }
    }
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
    // 遮罩记录（P0-3）：区间 = 本次压缩实际覆盖的切片（与 `compress` 内部同源）。
    // 落库失败不影响本次压缩：下次请求会回退到旧的「最后一条 summary」位置切片。
    let slice = compress::compress_slice(&messages);
    if let (Some(first), Some(last)) = (slice.first(), slice.last()) {
        if let Err(e) = repo
            .inner()
            .record_compaction(&session.id, &first.id, &last.id, &out.message.id)
            .await
        {
            eprintln!("[session_db] 写入压缩记录失败（按旧规则切片）: {}", e);
        }
    }
    // 记账：AI 摘要是一次真实消费；raw 没有模型调用 → 不记账
    if let Some(llm) = &out.llm {
        // AI 摘要那次请求的传输侧事实（raw / 桥接协议拿不到 → 落 0）
        let request_metrics = provider_obj.as_ref().and_then(|p| p.take_request_metrics());
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
            request_metrics,
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

/// 会话标题生成（GUI）—— 与 CLI 走同一份实现，避免 TS / Rust 两实现漂移。
/// 落库由调用方完成；记账在此完成（kind = title）。
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
    let request_metrics = provider_obj.take_request_metrics();
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
            request_metrics,
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
