//! 长期记忆（记忆功能 P0）的 **Tauri 命令层**（GUI 壳）
//!
//! 只做「参数兜底 + 转交 + 埋点」，业务语义全在 `virlen-core`：
//! 选取与渲染在 `agent::memory`，存取在 `session_db::memory`。
//!
//! ⚠️ 新增命令必须登记到 `src/lib.rs` 的 `generate_handler![...]`（铁律 4）；
//! 记忆正文是用户内容，**不得**进埋点（只上报条数 / 长度）。

use std::sync::Arc;

use virlen_core::agent::memory::prompt::{load_memory_section, MemoryPromptSection};
use virlen_core::agent::memory::tools::{
    run_recall, run_search, run_write, MemoryToolDeps, MemoryToolOutput, WriteRequest,
};
use virlen_core::agent::memory::{
    clamp_summary, is_valid_kind, is_valid_level, MEMORY_SUMMARY_MAX_CHARS,
};
// 记忆 DTO / 级别常量只有一份（住在持久化层），命令层从这里取
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

/// 新增 / 编辑一条记忆（面板「保存」与 P1 的 `memory_write` 工具共用同一条路径）
///
/// 项目路径的**服务端不变量**（UI 与工具都要守住，这里是最後一道）：
/// - 只有 `kind = project` 才能带路径（别的分类带上就变成「只在某个目录下可见」，没人找得到）；
/// - 空白串收敛为 `None`（= 不限定项目）；
/// - 超长拒绝（路径是用户输入，不能无界落库）。
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
        // 新条目的 id 由仓储发（它会查一遍主键，避免短 id 撞车时静默覆盖别的记忆）
        record.id = state.new_id().await;
    }
    if record.origin.trim().is_empty() {
        record.origin = "user".to_string();
    }
    record.summary = summary;

    // ⚠️ 不能直接用 `scope_for_write(kind, 传进来的路径)`（那个函数算的是「当前工作目录」）——
    // 面板保存的是**用户显式指定**的路径，这里只做「仅 project 保留 + 空白收敛 + 长度校验」。
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
    // 面板新增 / 编辑保存后走**同一条闸门**（§3.3）：只在本地判定 + 入队，绝不等 LLM；
    // 任何失败只打日志（记忆已经写好了，统计不该牵连它）。
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
            // 只上报「有没有详情链接 / 有没有项目作用域」，不上报路径本身与内容
            "has_detail": record.detail_doc_id.is_some(),
            "scoped": record.project_path.is_some(),
        }),
    );
    Ok(())
}

/// 删除一条记忆；返回是否真的删到。
///
/// ⚠️ **连带删掉它的详情文档**（详情正文在专用知识库「记忆详情」里，条目只是指向它的 link）——
/// 只删条目会在知识库里留下一份永远不会被引用的正文，用户清理记忆时越积越多。
/// 详情删失败不影响「记忆已删」这个事实（孤儿文档可在知识库页手动删），但会如实记进埋点。
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
            // null = 这条本来就没有详情；false = 详情没删掉（知识库里可能留下孤儿文档）
            "detail_removed": out.detail_removed,
        }),
    );
    Ok(out.removed)
}

/// 改级别（普通 ↔ 永久）；非法级别直接拒绝（这是权限级字段：永久 = 全量注入）
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

/// 注入后记一次使用（`hits += 1` / `last_used_at = now`）—— top-k 排序的输入。
///
/// 由前端在建会话之后**异步**调用（不阻塞建会话）；失败只丢统计，不影响对话。
#[tauri::command]
pub async fn cmd_memory_touch(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    ids: Vec<String>,
) -> Result<(), String> {
    state.touch(&ids, crate::telemetry::now_ms()).await
}

/// 取建会话用的注入段（`# Memory`）。
///
/// 前端拿到的是**渲染好的文本**：选取规则（top-k / 预算裁剪）只有 Rust 一份实现，
/// 前端只负责把它插进系统提示词（见 `services/agent-service.ts`）。
/// 段字符数与预算一并返回（面板常驻行的「字符数 / 预算」直接用它 —— 与裁剪判定同一个数）。
///
/// `for_preview`（设置页看预览 / 预算行）为 `true` 时**不打截断告警埋点**：
/// 否则每次打开面板都会抬高告警计数，指标就废了。
///
/// `workspace`：本次会话的工作目录（会话指定 > Agent 默认）。面板预览传设置里的**默认工作目录**，
/// 于是预览与真实会话用的是同一套作用域规则，只是工作目录不同。
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
        // 预算被撑满说明记忆总量已超过注入能力 —— 需要用户清理，不该静默
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

/// 记忆正文的硬上限（字符）—— 设置页用来提示「超出会被截断」
#[tauri::command]
pub fn cmd_memory_limits() -> serde_json::Value {
    serde_json::json!({
        "summaryMaxChars": MEMORY_SUMMARY_MAX_CHARS,
        "summaryHintChars": virlen_core::agent::memory::MEMORY_SUMMARY_HINT_CHARS,
        // 注入段预算：设置页的常驻行显示「字符数 / 预算」，两侧同源
        "promptBudgetChars": virlen_core::agent::memory::MEMORY_PROMPT_MAX_CHARS,
    })
}

/// 导出全部记忆（含停用）为 JSON 文本。
///
/// **返回文本、不写文件**：路径要由用户在对话框里选，而选路径只有前端有（Tauri dialog 插件）；
/// Rust 侧写死一个路径等于替用户决定位置。CLI 侧的出口是 `--out`（它本来就有路径参数）。
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

// ==================== 工具等价命令（P1） ====================
//
// 三个 `memory_*` 工具的 GUI 孪生：语义实现在 `agent::memory::tools`（与原生工具**同一份**），
// 这里只把依赖装好、把结果原样交给前端。用途有二：
// 1. 前端回退路径的执行器（`infrastructure/tools/memory/`）→ 与 Rust 引擎行为一致；
// 2. 设置页 / 调试入口可以直接复用（不必新写一份查询逻辑）。

/// 组装记忆操作依赖（与原生工具的 `native_tools/memory/common.rs::deps` 同口径：
/// RAG 未初始化 → `None`，工具降级为「详情不可读写」，不影响记忆条目本身）。
///
/// `workspace`：会话工作目录 —— 写入时给 `kind = project` 定作用域，检索时筛掉别的项目的记忆。
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

/// `memory_search` 的等价命令（关键词检索长期记忆）
///
/// `workspace`：会话工作目录 —— 与注入同一套项目作用域，别的项目的记忆不会返回
/// （结果里的 `hiddenByScope` 说明有多少条被藏起来）。
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

/// `memory_recall` 的等价命令（按 id 取一条记忆的详情正文）
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

/// `memory_write` 的等价命令（`session_id` 由前端传入，写入时记进 `source_session_id`）
///
/// `workspace`：会话工作目录 —— `kind = project` 时作为这条记忆的项目作用域
/// （与原生工具同口径：模型不必猜路径）。
///
/// `#[allow(too_many_arguments)]`：Tauri 命令参数逐个从 JS `invoke` 传入，
/// 收成结构体会要求前端改调用形状（与 `commands/agent.rs` 同口径）。
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

// ==================== 再蒸馏（P2′） ====================

/// GUI 侧的 Provider 构建器：走与聊天**同一个** `DefaultProviderFactory`
///
/// 因此 gemini 等「桥接协议」也能用作再蒸馏模型（GUI 有 JS 宿主）—— 与压缩 / 标题生成同一条路；
/// CLI（headless）没有 JS 宿主，改用 `create_native_provider`。
struct GuiRedistillBuilder {
    bridge: Arc<virlen_core::agent::bridge::AgentBridgeState>,
    app: tauri::AppHandle,
}

impl virlen_core::agent::memory::redistill::models::MemoryProviderBuilder for GuiRedistillBuilder {
    fn build(
        &self,
        conn: &virlen_core::agent::types::ProviderConnection,
    ) -> Result<Box<dyn virlen_core::agent::provider::Provider>, String> {
        // `ProviderFactory::create` 不是固有方法（trait 方法），必须把 trait 带进来
        use virlen_core::agent::provider::ProviderFactory;
        let factory = virlen_core::agent::provider::DefaultProviderFactory {
            bridge: self.bridge.clone(),
            sink: Arc::new(crate::commands::agent::TauriEventSink::new(self.app.clone())),
        };
        Ok(factory.create(conn))
    }
}

/// GUI 侧的调度宿主：把一次后台整理派发到 tauri 的异步运行时。
///
/// 句柄（记忆 / 会话 / 配置仓储）从 `State` 取（core 不认识 tauri，装配全在宿主侧）；
/// 取不到（库没打开 / 正在启动）就返回 `false` —— 请求留在队列里，下次触发或下次启动再来。
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
            // 取消令牌由 core 创建（`pump`）并交到宿主再带回来：退出时 `shutdown()` 取消它
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
                    // 失败只打日志 / 埋点：这是后台增强能力，不该打扰用户
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

/// 启动时判定一次（补跑上次退出没跑完 / 本次启动就已越线的库）—— **不引入定时器**。
///
/// 异步、非阻塞：`.setup()` 不等它；判定失败只打日志（后台增强能力不该拖慢启动）。
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

/// 手动触发一次（面板 / 排障用；`force` = 忽略冷却与幂等判定）
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

/// 整理流水（排障 / 未来的面板「整理记录」区）
#[tauri::command]
pub async fn cmd_memory_redistill_runs(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    limit: Option<usize>,
) -> Result<Vec<virlen_core::session_db::MemoryRedistillRun>, String> {
    state.list_redistill_runs(limit.unwrap_or(20)).await
}

/// 埋点：**只报计数与状态** —— 记忆正文是用户内容，绝不进埋点（安全红线）。
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
