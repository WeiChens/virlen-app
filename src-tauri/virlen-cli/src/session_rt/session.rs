//! 会话装载 —— 取/建一条会话，以及它与「工作目录 / Provider / 模型」的对齐
//!
//! 续用时 Provider / 模型的选择顺序：**命令行 > 会话自身 > app_settings 默认**；
//! 标题取 prompt 首行（与桌面端「截取首条用户消息」同口径）。

use serde_json::Value;
use virlen_core::session_db::SessionDb;
use virlen_core::agent::types::{
    Message, Session, SessionParams,
};

use super::*;

/// 取会话：`--session` 则续用（读历史消息），否则新建一条。
///
/// 续用时 Provider / 模型的选择顺序：**命令行 > 会话自身 > app_settings 默认**
/// （命令行给了却找不到会报错，见 [`resolve_connection`]）。
pub(crate) async fn load_or_create_session(
    db: &SessionDb,
    resources: &Resources,
    opts: &RunOptions,
) -> Result<(Session, Vec<Message>), String> {
    let now = virlen_core::telemetry::now_ms();
    let user_message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: Value::String(opts.prompt.clone()),
        timestamp: now,
        ..Default::default()
    };

    let Some(session_id) = opts.session_id.as_ref() else {
        // 新会话：标题取 prompt 首行（与桌面端的「截取首条用户消息」同口径）
        let session = new_session(resources, &title_from_prompt(&opts.prompt));
        return Ok((session, vec![user_message]));
    };

    let Some(mut session) = db
        .repo
        .get_session(session_id)
        .await
        .map_err(|e| format!("读取会话失败: {}", e))?
    else {
        return Err(format!(
            "会话不存在: {}（用 `virlen-cli run` 不带 --session 新建一条）",
            session_id
        ));
    };

    // 命令行显式指定 → 覆盖；否则沿用会话自身的 Provider / 模型
    if let Some(pid) = opts.provider_id.as_ref() {
        session.provider_config_id = pid.clone();
    }
    if let Some(mid) = opts.model_id.as_ref() {
        session.model_id = mid.clone();
    }
    // ⚠️ 会话的工作目录创建时定下、之后不可变（与桌面端 `getWorkspace(session.id)` 同语义）：
    // 续用路径一律不写回 —— 曾经的 bug 就是这里无条件覆盖，换个目录续跑就把会话的工作目录改掉
    // （桌面端看到的工作目录也跟着变）。
    if opts.append_system_prompt.is_some() {
        // 追加指令来自本次命令行 → 只影响本次调用（不写回会话的系统提示词）
        session.system_prompt = resources.system_prompt.clone();
    }
    session.params.stream = true;
    session.updated_at = now;

    let history = db
        .repo
        .get_messages(session_id)
        .await
        .map_err(|e| format!("读取会话消息失败: {}", e))?;

    let mut messages = history;
    messages.push(user_message);
    Ok((session, messages))
}

/// 会话标题：prompt 首行，最多 60 字符
pub(crate) fn title_from_prompt(prompt: &str) -> String {
    let first = prompt.lines().next().unwrap_or("").trim();
    if first.chars().count() <= 60 {
        return first.to_string();
    }
    first.chars().take(60).collect::<String>() + "…"
}

/// 新建一条会话元数据（**唯一一处** `Session` 字面量）。
///
/// `bootstrap`（一次性 `run`）与 `activate(None)`（`chat` 里的 `/new`）都走它，
/// 免得两处各写一份、日后只改了其中一份。
///
/// `title` 允许为空：TUI 里新会话还没有首条用户消息，标题在第一次提交时
/// 由 [`SessionRuntime::turn_messages`] 补齐（与桌面端「截取首条用户消息」同口径）。
pub(crate) fn new_session(resources: &Resources, title: &str) -> Session {
    let now = virlen_core::telemetry::now_ms();
    Session {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        messages: Vec::new(),
        provider_config_id: resources.provider.provider_id.clone(),
        model_id: resources.model_id.clone(),
        system_prompt: resources.system_prompt.clone(),
        params: SessionParams {
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: resources.max_tokens,
            stream: true,
            reasoning_effort: None,
        },
        created_at: now,
        updated_at: now,
        pinned: false,
        tags: Vec::new(),
        workspace: Some(resources.workspace.clone()),
        agent_id: None,
        allowed_tools: None,
        skills: None,
        system_prompt_manually_edited: None,
    }
}
