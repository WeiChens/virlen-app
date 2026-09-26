//! 上下文压缩的**执行链**（`chat` 的 TUI 与顺序输出模式共用）
//!
//! 为什么单独一层：这条链步骤多且顺序敏感 —— 「读全量历史 → 判定是否值得压 → 建 provider
//! → 调用 core 的压缩 → **落库** → **记账** → 刷新会话快照」。TUI 与顺序输出模式都要它，
//! 复制第二份就会分叉（CLI 侧的同类教训见 `session_rt/mod.rs` 文件头）。
//!
//! 判定 / 口径 / 渲染都**不在这里**：它们全在 `virlen_core::agent::compress`（与 TS 同语义）。
//! 本模块只负责「按 CLI 的约定把那一刻接起来」。
//!
//! ⚠️ 落库是**追加一条 summary**，不是替换整表：请求组装时引擎会丢掉最后一个 summary
//! 之前的全部消息（`provider::blocks::slice_messages`），因此旧消息留在库里不影响下一轮请求，
//! 而且模型侧的查询工具（`list_messages` / `read_messages`）正是靠它们检索「已压缩区间」。

use virlen_core::agent::cancellation::CancellationToken;
use virlen_core::agent::compress as agent_compress;
use virlen_core::agent::compress::{CompressMode, CONTEXT_WINDOW_TOKENS};
use virlen_core::agent::provider::create_native_provider;
use virlen_core::agent::usage;
use serde_json::{Map, Value};

use super::SessionRuntime;

/// 压缩没能完成的原因
///
/// 为什么要分两类：两者对用户是**不同的事** ——「上下文很充裕，无需压缩」是正常反馈（提示级），
/// 「模型调用 / 落库失败」才是错误。都渲染成「错误」会让人以为功能坏了。
#[derive(Debug, Clone)]
pub(crate) enum CompressError {
    /// 被闸拦下（上下文充裕 / 还没有用量数据）—— 不是失败，是「不需要做」
    Skipped(String),
    /// 真失败（provider 不可用 / 模型调用失败 / 落库失败）
    Failed(String),
}

impl CompressError {
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Skipped(m) | Self::Failed(m) => m,
        }
    }
}

/// 一次压缩的结果（供两种界面各自呈现）
#[derive(Debug, Clone)]
pub(crate) struct CompressReport {
    pub(crate) mode: CompressMode,
    /// 压缩前的上下文占用（`None` = 库里还没有用量数据；此时按 [`should_compress`] 已拦截）
    pub(crate) before: Option<i64>,
    /// 压缩后的上下文占用（本地估算）
    pub(crate) after: i64,
    /// 正文压缩省略的字符数（AI 摘要恒为 0）
    pub(crate) omitted_chars: usize,
    /// 压缩后的消息条数（含新追加的 summary）
    pub(crate) message_count: usize,
    /// 本次压缩墙钟耗时（含 AI 摘要的模型调用）
    pub(crate) elapsed_ms: i64,
    /// AI 模式那次模型调用的用量（`raw` 模式为 `None`）
    pub(crate) llm: Option<agent_compress::LlmCall>,
}

/// 设置里的默认压缩方式（`app_settings.contextCompressMode`）——与桌面端同一键
///
/// 两种界面共用：TUI 用它「预选并标默认」，顺序输出模式直接拿它当 `/compress` 的方式
/// （那边没有选择面板）。CLI 不自己发明默认值：读不到就返回 `None`。
pub(crate) fn default_compress_mode(settings: &Map<String, Value>) -> Option<CompressMode> {
    settings
        .get("contextCompressMode")
        .and_then(Value::as_str)
        .and_then(CompressMode::parse)
}

/// 取当前会话的上下文占用（读库尾窗；口径见 [`agent_compress::context_tokens`]）。
///
/// 为什么读库而不是用内存里的快照：`rt.messages` 只到「本次用户消息」，
/// 最新一条带 `usage` 的助手消息还没进去 —— 而占用恰恰要那一条。
/// 尾窗 30 条足够定位（每轮助手消息都带 usage），不必把整段历史拉进内存。
pub(crate) async fn current_context_tokens(rt: &SessionRuntime) -> Option<i64> {
    match rt
        .db
        .repo
        .get_message_page(&rt.session.id, CONTEXT_TAIL_WINDOW, None)
        .await
    {
        Ok(page) => agent_compress::context_tokens(&page.messages),
        Err(_) => None,
    }
}

/// 尾窗条数：只要覆盖「最近若干轮」即可命中最新一条带用量的消息
const CONTEXT_TAIL_WINDOW: usize = 30;

/// 压缩当前会话（`mode` 由调用方选定 / 由用户在选择面板里选出）。
///
/// 返回 `Err` 的文案已是**可直接展示**的中文句子（含数字与建议），调用方只加自己的前缀。
pub(crate) async fn compress_session(
    rt: &mut SessionRuntime,
    mode: CompressMode,
) -> Result<CompressReport, CompressError> {
    if !rt.db.repo.is_available() {
        return Err(CompressError::Failed(
            "本地存储不可用，读不到历史消息".to_string(),
        ));
    }

    // 压缩必须基于**全量历史**（不是尾窗）：正文压缩要把整段历史渲染进摘要
    let messages = rt
        .db
        .repo
        .get_messages(&rt.session.id)
        .await
        .map_err(|e| CompressError::Failed(format!("读取会话消息失败: {}", e)))?;

    let before = agent_compress::context_tokens(&messages);
    // 与桌面端同一条闸（TS `COMPRESS_MIN_RATIO = 0.4`）：上下文充裕时不做无用功，
    // 但必须**明说是哪一条闸拦下的**，否则用户会以为功能坏了
    if !agent_compress::should_compress(before) {
        return Err(CompressError::Skipped(match before {
            Some(n) => format!(
                "当前上下文很充裕（{}%，{} / {}），无需压缩",
                agent_compress::context_percent(n),
                agent_compress::format_tokens(n),
                agent_compress::format_tokens(CONTEXT_WINDOW_TOKENS)
            ),
            None => "该会话还没有用量数据（先发一条消息），暂时无法判断上下文占用".to_string(),
        }));
    }

    // AI 摘要需要真正的 Provider：headless 只支持原生协议（openai 兼容 / anthropic）。
    // gemini 等走 JS 桥的协议在这里会**直接报错**，而不是发出去挂死（见 core 的同名函数）。
    let provider = match mode {
        CompressMode::Ai => Some(
            create_native_provider(&rt.resources.provider).map_err(CompressError::Failed)?,
        ),
        CompressMode::Raw => None,
    };

    let started = virlen_core::telemetry::now_ms();
    let out = agent_compress::compress(
        agent_compress::CompressInput {
            mode,
            session: &rt.session,
            messages: &messages,
            tool_defs: &rt.resources.tool_defs,
            provider: provider.as_deref(),
        },
        &CancellationToken::new(),
    )
    .await
    .map_err(CompressError::Failed)?;
    let elapsed_ms = virlen_core::telemetry::now_ms() - started;

    // 落库（先落库，再让界面报成功 —— 与引擎「先落库再 emit」同一条口径）
    rt.db
        .repo
        .append_messages(&rt.session.id, std::slice::from_ref(&out.message))
        .await
        .map_err(|e| CompressError::Failed(format!("压缩结果落库失败: {}", e)))?;

    // 记账：AI 摘要是一次真实消费（与 TS `recordUsage({kind:'compress'})` 对称）；
    // 正文压缩没有模型调用 → 不记账。
    if let Some(llm) = &out.llm {
        usage::record_usage(
            rt.db.repo.as_ref(),
            &rt.session.id,
            &rt.session,
            &rt.resources.provider.provider_type,
            &rt.resources.provider.provider_id,
            "compress",
            None,
            None,
            Some(llm.usage.clone()),
            llm.estimated,
            Some(llm.duration_ms),
        )
        .await;
    }

    // 快照同步：库里那份才是权威历史 → 压缩后 = 原历史 + summary
    rt.messages = messages;
    rt.messages.push(out.message);

    Ok(CompressReport {
        mode,
        before,
        after: out.context_tokens,
        omitted_chars: out.omitted_chars,
        message_count: rt.messages.len(),
        elapsed_ms,
        llm: out.llm,
    })
}

/// 压缩结果的一行摘要（两种界面共用同一句话，避免口径分叉）
pub(crate) fn report_line(r: &CompressReport) -> String {
    let fmt = |v: Option<i64>| match v {
        Some(n) => format!(
            "{}（{}%）",
            agent_compress::format_tokens(n),
            agent_compress::context_percent(n)
        ),
        None => "-".to_string(),
    };
    let detail = if r.omitted_chars > 0 {
        format!("省略 {} 字符", r.omitted_chars)
    } else {
        "正文一字不删".to_string()
    };
    // AI 摘要那次**模型调用**的真实消耗（已记入用量账本）：
    // 与「压缩后占用」是两个口径，分开写才不会让人以为压缩花了 90k 却只省下 8k
    let call = match &r.llm {
        Some(c) => format!(
            "，摘要调用 {} tok{}",
            agent_compress::format_tokens(c.usage.total_tokens),
            if c.estimated { "（估算）" } else { "" }
        ),
        None => String::new(),
    };
    format!(
        "✔ 上下文已压缩（{}）：占用 {} → {}，消息 {} 条，{}，用时 {} ms{}",
        r.mode.label(),
        fmt(r.before),
        fmt(Some(r.after)),
        r.message_count,
        detail,
        r.elapsed_ms,
        call
    )
}

/// 「占用」的一行展示（状态行 / `/status` / 收尾行共用）
pub(crate) fn context_line(used: Option<i64>) -> String {
    match used {
        Some(n) => format!(
            "{} / {}（{}%）",
            agent_compress::format_tokens(n),
            agent_compress::format_tokens(CONTEXT_WINDOW_TOKENS),
            agent_compress::context_percent(n)
        ),
        None => format!("- / {}（本会话还没有用量数据）", agent_compress::format_tokens(CONTEXT_WINDOW_TOKENS)),
    }
}
