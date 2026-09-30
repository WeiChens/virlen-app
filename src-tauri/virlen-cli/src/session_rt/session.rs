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
    // ⚠️ 会话的工作目录创建时定下、之后不可变（与桌面端 `getWorkspace(session.id)` 同语义）：续用路径一律
    // 不写回 —— 无条件覆盖会让「换个目录续跑」把会话的工作目录改掉。
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

// ==================== 模型清单与切换（`/model`） ====================

/// `/model` 不带参数时的清单文本：当前模型 + 可用模型（当前那个打 `*`）。
///
/// 候选来自 `Resources::models`（= `app_settings.providers[].models`）—— 与
/// `--model` 的校验同一份数据，因此「命令行能指定的」与「界面里能切到的」不会分叉。
pub(crate) fn models_text(rt: &SessionRuntime) -> String {
    let mut s = format!(
        "当前模型: {} · Provider {}（{}）\n可用模型:",
        rt.resources.model_id,
        rt.resources.provider.provider_id,
        rt.resources.provider.provider_type
    );
    if rt.resources.models.is_empty() {
        s.push_str(" （无 —— 用 `virlen-cli provider edit` 补模型后重启会话）");
        return s;
    }
    for m in &rt.resources.models {
        s.push_str(&format!(
            "\n  {} {}",
            if *m == rt.resources.model_id { "*" } else { " " },
            m
        ));
    }
    s.push_str("\n切换: /model <模型id>");
    s
}

/// 切换当前会话使用的模型（`/model <id>`）：**校验 → 改内存 → 落库**。
///
/// 校验与 `--model` 同一条口径（[`resolve_connection`]）：给了却没配就报错，
/// 绝不静默换一个 —— 「以为在用 A 模型、实际跑 B 模型」是最难排查的一类问题。
///
/// 落库走 `upsert_session`（先落库再交给界面，与引擎「先落库再 emit」同一条约定）：
/// 用户切完模型直接退出时，下次 `--session` 续跑必须看到的是新模型。
/// 返回可直接展示的中文句子。
pub(crate) async fn switch_model(rt: &mut SessionRuntime, model: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("模型 id 不能为空".to_string());
    }
    if !rt.resources.models.iter().any(|m| m == model) {
        return Err(format!(
            "Provider `{}` 未配置模型 `{}`（可用: {}；要新增请用 `virlen-cli provider edit`）",
            rt.resources.provider.provider_id,
            model,
            if rt.resources.models.is_empty() {
                "无".to_string()
            } else {
                rt.resources.models.join(", ")
            }
        ));
    }
    let previous = rt.resources.model_id.clone();
    if previous == model {
        return Ok(format!("模型未变（仍是 {}）", model));
    }
    rt.resources.model_id = model.to_string();
    rt.session.model_id = model.to_string();
    // 会话时间 = 用户最后一次动作的时间（与桌面端切模型同语义）
    rt.session.updated_at = virlen_core::telemetry::now_ms();
    rt.db
        .repo
        .upsert_session(&rt.session)
        .await
        .map_err(|e| format!("模型已切换为 {}，但落库失败: {}", model, e))?;
    Ok(format!("模型已切换: {} → {}", previous, model))
}

/// 消息内容 → 纯文本（string 或 text block 数组；与引擎侧同一口径）。
///
/// 它**不属于 TUI**（原住在 `tui/sink.rs`）：`session show` 要看消息正文，
/// 而反过来让命令层依赖界面层是错的，所以搬到「与界面无关」的这里。
pub(crate) fn message_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    b.get("text").and_then(Value::as_str).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}
