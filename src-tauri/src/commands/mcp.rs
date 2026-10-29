//! MCP 的 Tauri 命令层（薄壳）：语义全在 `virlen_core::mcp`，本文件只做
//! 「取状态 / 落库 + reload / 转发事件」。
//!
//! 两条纪律：
//! 1. **定义走 `cmd_mcp_tool_definitions` 同步返回当前快照**，绝不等连接 —— 否则启动会被
//!    `npx` 冷启动拖死（方案 §8.5）。
//! 2. 事件用**独立 Tauri 事件**（`mcp:changed` / `mcp:status`），不塞进 `agent:event`
//!    （`AgentEventType` 是四方共享契约，加一种要改四处）。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use virlen_core::agent::types::ToolDefinition;
use virlen_core::mcp::{
    load_configs, parse_import, probe, save_configs, validate_configs, ImportResult, McpChangeSink,
    McpHost, McpManager, McpServerConfig, McpServerStatus, McpToolInfo,
};
use virlen_core::session_db::{NoopSettingsRepo, SettingsRepo};

// ==================== 事件出口 ====================

/// 快照变化 → 前端（`mcpStore` 与定义缓存失效）。
pub struct TauriMcpSink {
    app: tauri::AppHandle,
}

impl TauriMcpSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl McpChangeSink for TauriMcpSink {
    fn publish(&self, statuses: &[McpServerStatus], epoch: u64, tools_changed: bool) {
        // 状态每次都发（胶囊 / 工具清单实时刷新）
        let _ = self.app.emit("mcp:status", statuses);
        // 只在工具集合真的变了时才要求前端失效定义缓存（状态抖动不该触发重拉）
        if tools_changed {
            let _ = self.app.emit("mcp:changed", json!({ "epoch": epoch }));
        }
    }
}

// ==================== 初始化 ====================

/// 初始化 MCP（在 `init_agent_engine` 里调用一次）。
///
/// 顺序很关键：**先**挂上空管理器（同步）→ 再异步读配置。这样：
/// - 引擎与命令层任何时刻都有可用的宿主（未连上时 `definitions()` 为空，不阻塞）；
/// - 配置读失败只影响服务器列表，不影响聊天。
pub fn init_mcp(app: &tauri::AppHandle) {
    let manager = McpManager::new(Vec::new(), Some(Arc::new(TauriMcpSink::new(app.clone()))));
    app.manage(manager.clone());
    // 引擎分发：命中 `mcp__` 前缀时走它（未挂载时是 Noop，会给明确错误）
    virlen_core::mcp::attach(manager.clone());

    let settings = settings_of(app);
    // `.setup()` 回调没有 tokio reactor 上下文，必须用 Tauri 自己的运行时派发
    tauri::async_runtime::spawn(async move {
        match load_configs(&*settings).await {
            Ok(configs) if !configs.is_empty() => manager.reload(configs).await,
            Ok(_) => {}
            Err(error) => eprintln!("[mcp] 读取配置失败：{error}"),
        }
    });
}

/// 配置仓储（库打不开时是 Noop：命令如实报「本地存储不可用」而不是假装成功）
fn settings_of(app: &tauri::AppHandle) -> Arc<dyn SettingsRepo> {
    app.try_state::<Arc<dyn SettingsRepo>>()
        .map(|state| state.inner().clone())
        .unwrap_or_else(|| Arc::new(NoopSettingsRepo))
}

fn manager_of(app: &tauri::AppHandle) -> Result<Arc<McpManager>, String> {
    app.try_state::<Arc<McpManager>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "MCP 管理器尚未初始化".to_string())
}

/// 落库 + 热更（所有写命令的公共尾巴）
async fn persist_and_reload(
    app: &tauri::AppHandle,
    manager: &Arc<McpManager>,
    configs: Vec<McpServerConfig>,
) -> Result<(), String> {
    validate_configs(&configs)?;
    let settings = settings_of(app);
    save_configs(&*settings, &configs).await?;
    manager.reload(configs).await;
    Ok(())
}

// ==================== 命令 ====================

/// 列表页的一次性拉取：配置 + 状态 + 世代
#[tauri::command]
pub async fn cmd_mcp_list(app: tauri::AppHandle) -> Result<Value, String> {
    let manager = manager_of(&app)?;
    Ok(json!({
        "configs": manager.configs(),
        "statuses": manager.statuses(),
        "epoch": manager.epoch(),
    }))
}

/// 新增 / 编辑（整条覆盖；立即落 `app_settings.mcpServers` 并 reload）
#[tauri::command]
pub async fn cmd_mcp_upsert(
    app: tauri::AppHandle,
    config: McpServerConfig,
) -> Result<Value, String> {
    let manager = manager_of(&app)?;
    let mut configs = manager.configs();
    match configs.iter().position(|item| item.id == config.id) {
        Some(index) => configs[index] = config.clone(),
        None => {
            // 重名只在「新增」时是硬冲突；改名撞车由 validate_configs 兜住
            if configs.iter().any(|item| item.name == config.name) {
                return Err(format!("服务器名重复：{}", config.name));
            }
            configs.push(config.clone());
        }
    }
    persist_and_reload(&app, &manager, configs).await?;
    Ok(json!({ "ok": true, "id": config.id }))
}

/// 删除（dispose 掉连接 + 杀进程树）
#[tauri::command]
pub async fn cmd_mcp_remove(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let manager = manager_of(&app)?;
    let configs: Vec<McpServerConfig> = manager
        .configs()
        .into_iter()
        .filter(|item| item.id != id)
        .collect();
    persist_and_reload(&app, &manager, configs).await?;
    Ok(json!({ "ok": true }))
}

/// 启停（关掉即断连并注销工具；打开即重新建连）
#[tauri::command]
pub async fn cmd_mcp_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    let manager = manager_of(&app)?;
    let mut configs = manager.configs();
    let Some(config) = configs.iter_mut().find(|item| item.id == id) else {
        return Err(format!("找不到 MCP 服务器：{id}"));
    };
    config.enabled = enabled;
    persist_and_reload(&app, &manager, configs).await?;
    Ok(json!({ "ok": true }))
}

/// 手动重连（无 id = 全部）；`failed` 的服务器也由此复活
#[tauri::command]
pub async fn cmd_mcp_reload(app: tauri::AppHandle, id: Option<String>) -> Result<Value, String> {
    let manager = manager_of(&app)?;
    manager.reconnect(id.as_deref());
    Ok(json!({ "ok": true }))
}

/// 当前快照里的 MCP 工具定义（**同步返回**，不等连接）
#[tauri::command]
pub async fn cmd_mcp_tool_definitions(app: tauri::AppHandle) -> Result<Vec<ToolDefinition>, String> {
    Ok(manager_of(&app)?.definitions())
}

/// 全部服务器状态
#[tauri::command]
pub async fn cmd_mcp_status(app: tauri::AppHandle) -> Result<Vec<McpServerStatus>, String> {
    Ok(manager_of(&app)?.statuses())
}

/// 「测试连接」：临时连一次、列工具、立刻关掉（不落库、不影响正在跑的服务器）。
///
/// 连接失败是**这个按钮的正常结果**（不是命令异常），因此回 `{ ok:false, error }`
/// 让设置页原地显示原因，而不是抛一个前端要 try/catch 的异常。
#[tauri::command]
pub async fn cmd_mcp_test(config: McpServerConfig) -> Result<Value, String> {
    match probe(&config).await {
        Ok(tools) => Ok(json!({
            "ok": true,
            "toolCount": tools.len(),
            "tools": tools,
        })),
        Err(error) => Ok(json!({
            "ok": false,
            "toolCount": 0,
            "tools": Vec::<McpToolInfo>::new(),
            "error": error,
        })),
    }
}

/// 从 Claude Desktop 风格的 `mcpServers` JSON 导入（同名的跳过，不覆盖）
#[tauri::command]
pub async fn cmd_mcp_import(app: tauri::AppHandle, json: String) -> Result<ImportResult, String> {
    let manager = manager_of(&app)?;
    let existing = manager.configs();
    let result = parse_import(&json, &existing)?;
    if !result.imported.is_empty() {
        let mut configs = existing;
        configs.extend(result.imported.iter().cloned());
        persist_and_reload(&app, &manager, configs).await?;
    }
    Ok(result)
}

/// 要注入系统提示词的服务器说明书（已带归属前缀 + 32 KB 总量截断；没有 → `null`）。
///
/// 建会话时调一次：MCP 说明书与记忆一样属于「会话建立那一刻的背景」，中途变更不影响已建会话
/// （保 prompt cache，且不把用户已经发出去的那一轮上下文改写掉）。
///
/// `allowedServers`：会话所属 Agent 白名单折算出的**服务器名**（不是公开工具名）。
/// `null` = 不过滤（无白名单的宿主）；空数组 = 一个都不注 —— 必须与「工具实际下发」同口径，
/// 否则提示词会教模型用一批它完全看不到的工具。
#[tauri::command]
pub async fn cmd_mcp_instructions(
    app: tauri::AppHandle,
    allowed_servers: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    Ok(manager_of(&app)?.instructions(allowed_servers.as_deref()))
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 「测试连接」对**非法配置**也要给结构化结果（不是 panic / 不是 Err）
    #[tokio::test]
    async fn test_command_reports_errors_inline() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "id": "x", "name": "bad name with spaces",
            "transport": "stdio", "command": "npx",
            "reconnect": { "enabled": false },
        }))
        .unwrap();
        let value = cmd_mcp_test(config).await.unwrap();
        assert_eq!(value["ok"], false);
        assert!(!value["error"].as_str().unwrap_or_default().is_empty());
        assert_eq!(value["toolCount"], 0);
    }
}
