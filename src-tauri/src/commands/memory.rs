//! 长期记忆的 Tauri 命令层（GUI 壳）：只做参数兜底 + 转交 + 埋点，业务语义在 virlen-core。
//! 记忆正文是用户内容，不得进埋点（只上报条数 / 长度）。

use std::sync::Arc;

use virlen_core::agent::memory::prompt::{load_memory_section, MemoryPromptSection};
use virlen_core::agent::memory::tools::{
    run_recall, run_search, run_write, MemoryToolDeps, MemoryToolOutput, WriteRequest,
};
use virlen_core::agent::memory::{
    clamp_summary, is_valid_kind, is_valid_level, MEMORY_SUMMARY_MAX_CHARS,
};
// 记忆 DTO / 级别常量住在持久化层，命令层从这里取
use virlen_core::agent::memory::scope::MEMORY_PROJECT_PATH_MAX_CHARS;
use virlen_core::session_db::{
    MemoryRecord, MemoryRepo, SettingsRepo, MEMORY_KIND_PROJECT, MEMORY_LEVEL_NORMAL,
};

/// 列出记忆（设置页面板的数据源）
#[tauri::command]
pub async fn cmd_memory_list(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    include_disabled: Option<bool>,
) -> Result<Vec<MemoryRecord>, String> {
    state.list(None, include_disabled.unwrap_or(true)).await
}

/// 新增 / 编辑一条记忆（面板保存与 `memory_write` 工具共用）。
///
/// 项目路径的服务端不变量：只有 kind = project 才能带；空白收敛为 None；超长拒绝。
#[tauri::command]
pub async fn cmd_memory_upsert(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    mut record: MemoryRecord,
) -> Result<(), String> {
    let summary = clamp_summary(&record.summary);
    if summary.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }
    if !is_valid_level(&record.level) {
        record.level = MEMORY_LEVEL_NORMAL.to_string();
    }
    if !is_valid_kind(&record.kind) {
        record.kind = "fact".to_string();
    }
    if record.id.trim().is_empty() {
        // 新条目的 id 由仓储发（会查主键，避免短 id 撞车时静默覆盖）
        record.id = state.new_id().await;
    }
    if record.origin.trim().is_empty() {
        record.origin = "user".to_string();
    }
    record.summary = summary;

    // ⚠️ 不能用 `scope_for_write(kind, 路径)`（那个算的是当前工作目录）：
    // 面板保存的是用户显式指定的路径，这里只做「仅 project 保留 + 空白收敛 + 长度校验」。
    let path = if record.kind == MEMORY_KIND_PROJECT {
        record
            .project_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    } else {
        None
    };
    if let Some(p) = path.as_deref() {
        if p.chars().count() > MEMORY_PROJECT_PATH_MAX_CHARS {
            return Err(format!(
                "项目路径过长（最多 {} 字符）",
                MEMORY_PROJECT_PATH_MAX_CHARS
            ));
        }
    }
    record.project_path = path;

    state.upsert(&record).await?;
    // 保存后过同一条再蒸馏闸门：只本地判定 + 入队，不等 LLM；失败只打日志
    virlen_core::agent::memory::redistill::sched::request(
        state.inner().as_ref(),
        settings.inner().as_ref(),
        crate::telemetry::now_ms(),
    )
    .await;
    crate::telemetry::track(
        "memory.upsert",
        serde_json::json!({
            "level": record.level,
            "kind": record.kind,
            "chars": record.summary.chars().count(),
            // 只上报「有没有详情链接 / 有没有项目作用域」，不上报路径与内容
            "has_detail": record.detail_doc_id.is_some(),
            "scoped": record.project_path.is_some(),
        }),
    );
    Ok(())
}

/// 删除一条记忆；返回是否真删到。
///
/// 连带删掉它的详情文档：只删条目会在知识库里留下永不引用的孤儿正文。
/// 详情删失败不影响「记忆已删」，但会如实记进埋点。
#[tauri::command]
pub async fn cmd_memory_delete(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    id: String,
) -> Result<bool, String> {
    let out = virlen_core::agent::memory::store::forget_memory(
        state.inner().as_ref(),
        virlen_core::rag::get_service().ok(),
        &id,
    )
    .await?;
    crate::telemetry::track(
        "memory.delete",
        serde_json::json!({
            "removed": out.removed,
            // null = 本来就没有详情；false = 详情没删掉（知识库可能留下孤儿文档）
            "detail_removed": out.detail_removed,
        }),
    );
    Ok(out.removed)
}

/// 改级别（普通 ↔ 永久）；永久 = 全量注入，非法值直接拒
#[tauri::command]
pub async fn cmd_memory_set_level(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    id: String,
    level: String,
) -> Result<bool, String> {
    if !is_valid_level(&level) {
        return Err(format!("未知的记忆级别: {}", level));
    }
    let hit = state.set_level(&id, &level).await?;
    crate::telemetry::track("memory.set_level", serde_json::json!({ "level": level }));
    Ok(hit)
}

/// 单条启用 / 禁用（禁用 = 不注入、不参与召回）
#[tauri::command]
pub async fn cmd_memory_set_disabled(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    id: String,
    disabled: bool,
) -> Result<bool, String> {
    state.set_disabled(&id, disabled).await
}

/// 注入后记一次使用（hits += 1 / last_used_at = now）—— top-k 排序的输入。
/// 由前端建会话后异步调用；失败只丢统计。
#[tauri::command]
pub async fn cmd_memory_touch(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    ids: Vec<String>,
) -> Result<(), String> {
    state.touch(&ids, crate::telemetry::now_ms()).await
}

/// 取建会话用的注入段（`# Memory`），返回渲染好的文本（选取规则只有 Rust 一份实现）。
///
/// for_preview 为 true 时不打截断告警埋点，否则每次开面板都会抬高告警计数。
/// workspace：会话工作目录（会话指定 > Agent 默认），预览传设置里的默认工作目录。
#[tauri::command]
pub async fn cmd_memory_prompt_section(
    memory: tauri::State<'_, Arc<dyn MemoryRepo>>,
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    workspace: Option<String>,
    for_preview: Option<bool>,
) -> Result<MemoryPromptSection, String> {
    let section = load_memory_section(
        memory.inner().as_ref(),
        settings.inner().as_ref(),
        workspace.as_deref(),
        crate::telemetry::now_ms(),
    )
    .await;
    if for_preview != Some(true)
        && (section.dropped_normal > 0 || section.dropped_permanent > 0)
    {
        // 预算被撑满说明记忆已超过注入能力 —— 需要用户清理，不该静默
        crate::telemetry::track(
            "memory.inject.truncated",
            serde_json::json!({
                "dropped_normal": section.dropped_normal,
                "dropped_permanent": section.dropped_permanent,
                "injected": section.ids.len(),
                "chars": section.chars,
                "budget": section.budget,
            }),
        );
    }
    Ok(section)
}

/// 记忆正文硬上限（字符）—— 设置页用来提示「超出会被截断」
#[tauri::command]
pub fn cmd_memory_limits() -> serde_json::Value {
    serde_json::json!({
        "summaryMaxChars": MEMORY_SUMMARY_MAX_CHARS,
        "summaryHintChars": virlen_core::agent::memory::MEMORY_SUMMARY_HINT_CHARS,
        // 注入段预算：设置页常驻行显示「字符数 / 预算」，两侧同源
        "promptBudgetChars": virlen_core::agent::memory::MEMORY_PROMPT_MAX_CHARS,
    })
}

/// 导出全部记忆（含停用）为 JSON 文本。
///
/// 返回文本、不写文件：路径要由用户在 Tauri dialog 里选。
#[tauri::command]
pub async fn cmd_memory_export(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
) -> Result<String, String> {
    let all = state.list(None, true).await?;
    let json = virlen_core::agent::memory::export::export_json(&all, crate::telemetry::now_ms())?;
    // 只上报条数与体积（记忆正文是用户内容，绝不进埋点）
    crate::telemetry::track(
        "memory.export",
        serde_json::json!({ "count": all.len(), "chars": json.chars().count() }),
    );
    Ok(json)
}

// ==================== 工具等价命令 ====================
// `memory_*` 工具的 GUI 孪生：语义在 agent::memory::tools（与原生工具同一份），
// 这里只装依赖、把结果原样交给前端（前端回退路径与设置页调试复用）。

/// 组装记忆操作依赖（RAG 未初始化则降级为「详情不可读写」）。
/// workspace：写入时给 kind = project 定作用域，检索时筛掉别的项目的记忆。
fn memory_deps<'a>(
    memory: &'a dyn MemoryRepo,
    settings: &'a dyn SettingsRepo,
    session_id: Option<&'a str>,
    workspace: Option<&'a str>,
) -> MemoryToolDeps<'a> {
    MemoryToolDeps {
        repo: memory,
        settings,
        rag: virlen_core::rag::get_service().ok(),
        session_id: session_id.unwrap_or(""),
        workspace: workspace.unwrap_or(""),
        now_ms: crate::telemetry::now_ms(),
    }
}

/// `memory_search` 等价命令（关键词检索）
///
/// workspace 与注入同一套项目作用域；结果里的 hiddenByScope 说明藏了多少条。
#[tauri::command]
pub async fn cmd_memory_search(
    memory: tauri::State<'_, Arc<dyn MemoryRepo>>,
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    query: String,
    level: Option<String>,
    kind: Option<String>,
    limit: Option<i64>,
    workspace: Option<String>,
) -> Result<MemoryToolOutput, String> {
    let deps = memory_deps(
        memory.inner().as_ref(),
        settings.inner().as_ref(),
        None,
        workspace.as_deref(),
    );
    let out = run_search(
        &deps,
        &query,
        level.as_deref(),
        kind.as_deref(),
        limit,
    )
    .await?;
    crate::telemetry::track(
        "memory.search",
        serde_json::json!({
            "count": out.ui_data.get("count").and_then(|v| v.as_i64()).unwrap_or(0),
            // 不上报查询词与命中的正文（用户内容不进埋点）
            "has_query": !query.trim().is_empty(),
        }),
    );
    Ok(out)
}

/// `memory_recall` 等价命令（按 id 取详情正文）
#[tauri::command]
pub async fn cmd_memory_recall(
    memory: tauri::State<'_, Arc<dyn MemoryRepo>>,
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    memory_id: String,
) -> Result<MemoryToolOutput, String> {
    let deps = memory_deps(
        memory.inner().as_ref(),
        settings.inner().as_ref(),
        None,
        None,
    );
    let out = run_recall(&deps, &memory_id).await?;
    crate::telemetry::track(
        "memory.recall",
        serde_json::json!({
            "found": out.ui_data.get("found").and_then(|v| v.as_bool()).unwrap_or(false),
            "has_detail": out.ui_data.get("hasDetail").and_then(|v| v.as_bool()).unwrap_or(false),
        }),
    );
    Ok(out)
}

/// `memory_write` 等价命令（session_id 写进 source_session_id）。
/// workspace：kind = project 时作为项目作用域。
///
/// `#[allow(too_many_arguments)]`：Tauri 命令逐个从 JS 传参，收结构体会要求前端改形状。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cmd_memory_write(
    memory: tauri::State<'_, Arc<dyn MemoryRepo>>,
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    summary: String,
    kind: String,
    level: Option<String>,
    detail: Option<String>,
    session_id: Option<String>,
    workspace: Option<String>,
) -> Result<MemoryToolOutput, String> {
    let deps = memory_deps(
        memory.inner().as_ref(),
        settings.inner().as_ref(),
        session_id.as_deref(),
        workspace.as_deref(),
    );
    let out = run_write(
        &deps,
        WriteRequest {
            summary: &summary,
            kind: &kind,
            level: level.as_deref(),
            detail: detail.as_deref(),
        },
    )
    .await?;
    crate::telemetry::track(
        "memory.write",
        serde_json::json!({
            "level": out.ui_data.get("level").and_then(|v| v.as_str()).unwrap_or(""),
            "kind": out.ui_data.get("kind").and_then(|v| v.as_str()).unwrap_or(""),
            "has_detail": out.ui_data.get("hasDetail").and_then(|v| v.as_bool()).unwrap_or(false),
            // 只上报「有没有项目作用域」，不上报路径本身
            "scoped": out.ui_data.get("projectPath").map(|v| !v.is_null()).unwrap_or(false),
            "chars": out.ui_data.get("chars").and_then(|v| v.as_i64()).unwrap_or(0),
        }),
    );
    Ok(out)
}

// ==================== 再蒸馏 ====================

/// GUI 的 Provider 构建器：走与聊天同一个 DefaultProviderFactory（gemini 等桥接协议也能用）。
struct GuiRedistillBuilder {
    bridge: Arc<virlen_core::agent::bridge::AgentBridgeState>,
    app: tauri::AppHandle,
}

impl virlen_core::agent::memory::redistill::models::MemoryProviderBuilder for GuiRedistillBuilder {
    fn build(
        &self,
        conn: &virlen_core::agent::types::ProviderConnection,
    ) -> Result<Box<dyn virlen_core::agent::provider::Provider>, String> {
        // trait 方法，必须把 ProviderFactory 带进来
        use virlen_core::agent::provider::ProviderFactory;
        let factory = virlen_core::agent::provider::DefaultProviderFactory {
            bridge: self.bridge.clone(),
            sink: Arc::new(crate::commands::agent::TauriEventSink::new(self.app.clone())),
        };
        Ok(factory.create(conn))
    }
}

/// GUI 的调度宿主：把后台整理派发到 tauri 异步运行时。
/// 仓储从 State 取；取不到就返回 false，请求留在队列里等下次触发。
pub struct GuiRedistillRuntime {
    app: tauri::AppHandle,
}

impl GuiRedistillRuntime {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl virlen_core::agent::memory::redistill::sched::MemoryRedistillRuntime for GuiRedistillRuntime {
    fn spawn_redistill(&self, cancel: virlen_core::agent::cancellation::CancellationToken) -> bool {
        use tauri::Manager;
        let app = self.app.clone();
        let bridge = match app.try_state::<Arc<virlen_core::agent::bridge::AgentBridgeState>>() {
            Some(s) => s.inner().clone(),
            None => return false,
        };
        let memory = match app.try_state::<Arc<dyn MemoryRepo>>() {
            Some(s) => s.inner().clone(),
            None => return false,
        };
        let repo = match app.try_state::<Arc<dyn virlen_core::session_db::SessionRepo>>() {
            Some(s) => s.inner().clone(),
            None => return false,
        };
        let settings = match app.try_state::<Arc<dyn SettingsRepo>>() {
            Some(s) => s.inner().clone(),
            None => return false,
        };

        tauri::async_runtime::spawn(async move {
            // 取消令牌由 core 创建并交回宿主：退出时 shutdown() 取消它
            let builder = GuiRedistillBuilder {
                bridge,
                app: app.clone(),
            };
            let rag = virlen_core::rag::get_service().ok();
            let outcome = virlen_core::agent::memory::redistill::sched::execute_pending(
                memory.as_ref(),
                repo.as_ref(),
                settings.as_ref(),
                rag,
                &builder,
                cancel,
            )
            .await;
            if let Some(result) = outcome {
                match result {
                    Ok(report) => track_redistill(&report, "auto"),
                    // 失败只打日志 / 埋点：后台增强能力不该打扰用户
                    Err(e) => eprintln!("[memory] 再蒸馏失败: {}", e),
                }
            }
        });
        true
    }

    fn shutdown(&self) {
        virlen_core::agent::memory::redistill::sched::shutdown();
    }
}

/// 启动时判定一次（补跑上次未完成 / 已越线的库），不引入定时器。异步、非阻塞，失败只打日志。
pub fn request_redistill_on_startup(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let memory = app
            .try_state::<Arc<dyn MemoryRepo>>()
            .map(|s| s.inner().clone());
        let settings = app
            .try_state::<Arc<dyn SettingsRepo>>()
            .map(|s| s.inner().clone());
        if let (Some(memory), Some(settings)) = (memory, settings) {
            virlen_core::agent::memory::redistill::sched::request(
                memory.as_ref(),
                settings.as_ref(),
                crate::telemetry::now_ms(),
            )
            .await;
        }
    });
}

/// 手动触发一次（排障用；force = 忽略冷却与幂等判定）
#[tauri::command]
pub async fn cmd_memory_redistill(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<virlen_core::agent::bridge::AgentBridgeState>>,
    memory: tauri::State<'_, Arc<dyn MemoryRepo>>,
    repo: tauri::State<'_, Arc<dyn virlen_core::session_db::SessionRepo>>,
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    task: Option<String>,
    force: Option<bool>,
) -> Result<virlen_core::agent::memory::redistill::RedistillReport, String> {
    use virlen_core::agent::memory::redistill::{RedistillTask, sched::run_direct};
    let builder = GuiRedistillBuilder {
        bridge: bridge.inner().clone(),
        app: app.clone(),
    };
    let task = match task.as_deref().map(str::trim) {
        Some("purge") => RedistillTask::PurgeOnly,
        _ => RedistillTask::Full,
    };
    let report = run_direct(
        memory.inner().as_ref(),
        repo.inner().as_ref(),
        settings.inner().as_ref(),
        virlen_core::rag::get_service().ok(),
        &builder,
        task,
        force.unwrap_or(false),
    )
    .await?;
    track_redistill(&report, "manual");
    Ok(report)
}

/// 整理流水（排障用）
#[tauri::command]
pub async fn cmd_memory_redistill_runs(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    limit: Option<usize>,
) -> Result<Vec<virlen_core::session_db::MemoryRedistillRun>, String> {
    state.list_redistill_runs(limit.unwrap_or(20)).await
}

/// 埋点只报计数与状态，记忆正文绝不进埋点。
fn track_redistill(report: &virlen_core::agent::memory::redistill::RedistillReport, trigger: &str) {
    let first = report.batches.first();
    crate::telemetry::track(
        "memory.redistill",
        serde_json::json!({
            "trigger": trigger,
            "status": report.status,
            "task": report.task,
            "batches": report.batches.len(),
            "items_in": report.items_in,
            "items_out": report.items_out,
            "calls": report.calls,
            "purged": report.purged,
            "purged_failed": report.purged_failed,
            // 第一个批次的细节（一次触发最多 3 批，报第一批就够定位问题）
            "batch_status": first.map(|b| b.status.clone()),
            "drifted": first.map(|b| b.drifted).unwrap_or(0),
            "unarchived": first.map(|b| b.unarchived).unwrap_or(0),
            "reason": first.and_then(|b| b.reason.clone()),
            "model": first.and_then(|b| b.model.clone()),
        }),
    );
}
