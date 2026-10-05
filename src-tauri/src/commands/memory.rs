//! 长期记忆（记忆功能 P0）的 **Tauri 命令层**（GUI 壳）
//!
//! 只做「参数兜底 + 转交 + 埋点」，业务语义全在 `virlen-core`：
//! 选取与渲染在 `agent::memory`，存取在 `session_db::memory`。
//!
//! ⚠️ 新增命令必须登记到 `src/lib.rs` 的 `generate_handler![...]`（铁律 4）；
//! 记忆正文是用户内容，**不得**进埋点（只上报条数 / 长度）。

use std::sync::Arc;

use virlen_core::agent::cancellation::CancellationToken;
use virlen_core::agent::memory::consolidate::{
    consolidate_now, ConsolidateDeps, ConsolidateOptions, ConsolidateReport,
};
use virlen_core::agent::memory::models::DistillProviderBuilder;
use virlen_core::agent::memory::prompt::{load_memory_section, MemoryPromptSection};
use virlen_core::agent::memory::tools::{
    run_recall, run_search, run_write, MemoryToolDeps, MemoryToolOutput, WriteRequest,
};
use virlen_core::agent::memory::{
    clamp_summary, is_valid_kind, is_valid_level, new_memory_id, MEMORY_SUMMARY_MAX_CHARS,
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
        record.id = new_memory_id();
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

// ==================== 蒸馏整理（P2） ====================

/// GUI 侧的 Provider 构建器：走与聊天**同一个** `DefaultProviderFactory`
///
/// 因此 gemini 等「桥接协议」也能用作蒸馏模型（GUI 有 JS 宿主）—— 与压缩 / 标题生成同一条路；
/// CLI（headless）没有 JS 宿主，改用 `create_native_provider`（见 `virlen-cli/src/memory.rs`）。
struct GuiProviderBuilder {
    bridge: Arc<virlen_core::agent::bridge::AgentBridgeState>,
    app: tauri::AppHandle,
}

impl DistillProviderBuilder for GuiProviderBuilder {
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

/// 整理长期记忆（「第二天」蒸馏）—— **幂等**，可重复调用。
///
/// 前端三个调用点：启动时（`src/main.ts` 的 `step('memory', ...)`）、面板「立即整理昨天」、
/// CLI（同一份 core 实现）。`only_day` 指定单日；`force` = 「重新整理」（覆盖该天旧的蒸馏产出）。
///
/// ⚠️ 不返回任何记忆正文以外的敏感信息：报告里只有日期 / 条数 / 状态 / 错误原因（供 UI 展示）。
#[tauri::command]
pub async fn cmd_memory_consolidate(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, Arc<virlen_core::agent::bridge::AgentBridgeState>>,
    memory: tauri::State<'_, Arc<dyn MemoryRepo>>,
    repo: tauri::State<'_, Arc<dyn virlen_core::session_db::SessionRepo>>,
    settings: tauri::State<'_, Arc<dyn SettingsRepo>>,
    only_day: Option<String>,
    force: Option<bool>,
) -> Result<ConsolidateReport, String> {
    let builder = GuiProviderBuilder {
        bridge: bridge.inner().clone(),
        app: app.clone(),
    };
    let cancel = CancellationToken::new();
    let deps = ConsolidateDeps {
        memory: memory.inner().as_ref(),
        sessions: repo.inner().as_ref(),
        settings: settings.inner().as_ref(),
        rag: virlen_core::rag::get_service().ok(),
        builder: &builder,
        cancel: &cancel,
    };
    let report = consolidate_now(
        deps,
        ConsolidateOptions {
            only_day: only_day.filter(|d| !d.trim().is_empty()),
            force: force.unwrap_or(false),
        },
    )
    .await?;
    // 埋点只报计数与状态（记忆正文是用户内容，绝不进埋点）
    crate::telemetry::track(
        "memory.consolidate",
        serde_json::json!({
            "status": report.status,
            "days": report.days.len(),
            "items": report.items,
            "details": report.details,
            "merged": report.merged,
            "calls": report.calls,
        }),
    );
    Ok(report)
}

/// 整理流水（面板状态行：「上次整理：哪天 / 几条 / 失败原因」）
#[tauri::command]
pub async fn cmd_memory_runs(
    state: tauri::State<'_, Arc<dyn MemoryRepo>>,
    limit: Option<usize>,
) -> Result<Vec<virlen_core::session_db::MemoryRun>, String> {
    state.list_runs(limit.unwrap_or(20)).await
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
