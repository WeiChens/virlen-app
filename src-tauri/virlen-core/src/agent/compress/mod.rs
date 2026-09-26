//! 上下文压缩 —— 把早期对话历史替换成一条 `summary` 消息（本模块是唯一实现）
//!
//! ## 两种模式
//!
//! - [`CompressMode::Ai`]：一次非流式模型调用（提示词 `prompts::COMPRESS_CONTEXT`），最省 token，但慢、且本身要花钱；
//! - [`CompressMode::Raw`]：正文压缩，纯本地渲染（[`raw::build_raw_summary`]），毫秒级零消耗；正文一字不
//!   删，只丢深度思考并省略超长工具输出。
//!
//! 产物只有一条 `role = "summary"` 消息，由调用方追加到会话末尾；生效机制不在本模块：请求组装时
//! `provider::blocks::slice_messages` 会丢掉最后一个 summary 之前的全部消息，所以 summary 正文必须自包含。
//! ⚠️ 旧消息仍留在库里 —— `list_messages` / `read_messages` 靠它们检索「已压缩区间」，删掉那两个工具就
//! 失去意义。
//!
//! ## 清单保活
//!
//! 活跃清单若落在压缩区间内，模型此后就看不到它（表现：压缩后 AI 忘记清单）。对策：把清单原文
//! （[`render_todo_content`]）补在 summary 正文末尾（[`todo_recap`]）。
//! ⚠️ 不能把清单快照的 `tool` 消息原样搬到 summary 之后：`tool` 消息必须紧跟带 `tool_calls` 的
//! assistant 消息，否则 OpenAI / Anthropic 直接报错。
//!
//! ## 已知差异与坑
//!
//! - token 计数：本模块只有 [`estimate_tokens`] 的 CJK 感知粗估，所以 `ui_data.contextTokens` 是估算值
//!   （`ai` 模式下 `usage.totalTokens` 仍是 provider 回报的真实值）；
//! - 截断单位：按字符（码点），阈值附近与 TS 的 UTF-16 口径可能差 ±1 字符；
//! - `max_tokens` 必须钳到 [`DEFAULT_SUMMARY_MAX_TOKENS`]：GUI 会话默认的 `2000000`（语义是「不限制
//!   输出」）会被模型以 400 `Invalid max_tokens value` 拒掉（见 `ai::summary_max_tokens`）。

pub mod ai;
pub mod raw;
#[cfg(test)]
mod tests;

use crate::agent::cancellation::CancellationToken;
use crate::agent::native_tools::plan::render_todo_content;
use crate::agent::provider::Provider;
use crate::agent::types::{Message, Session, TokenUsage, ToolDefinition};
use serde_json::{json, Value};

/// 上下文窗口的**默认值**（token）—— 100% 对应多少。
///
/// 实际取值来自 `app_settings.contextWindowTokens`（CLI 与桌面端读**同一个键**，
/// 见 [`window_tokens_from_settings`]）；本常量仅作缺省 / 兜底。
pub const CONTEXT_WINDOW_TOKENS: i64 = 200_000;

/// `app_settings` 里「上下文窗口」的键名 —— 与 TS `SettingsStore.contextWindowTokens` 同名。
pub const CONTEXT_WINDOW_KEY: &str = "contextWindowTokens";

/// 从 `app_settings` 读取「100% 对应的上下文窗口」（token）。
///
/// 缺失 / 非法 / 非正数 → 回退到默认 [`CONTEXT_WINDOW_TOKENS`]。CLI 与桌面端读的是
/// **同一个键**，因此两端口径始终一致。
pub fn window_tokens_from_settings(settings: &serde_json::Map<String, Value>) -> i64 {
    settings
        .get(CONTEXT_WINDOW_KEY)
        .and_then(Value::as_i64)
        .filter(|n| *n > 0)
        .unwrap_or(CONTEXT_WINDOW_TOKENS)
}

/// 低于该占用比例不触发压缩 —— 与 TS `token-ring.tsx::COMPRESS_MIN_RATIO` 同值
pub const COMPRESS_MIN_RATIO: f64 = 0.4;

/// `ai` 摘要请求的 `max_tokens` 兜底（会话未配置时用）
pub const DEFAULT_SUMMARY_MAX_TOKENS: i64 = 4096;

// ==================== 压缩方式 ====================

/// 压缩方式 —— 与 TS `CompressMode`（`'ai' | 'raw'`）取值一致
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressMode {
    /// LLM 摘要（省 token，但需一次模型调用）
    Ai,
    /// 正文压缩（本地渲染，毫秒级）
    Raw,
}

impl CompressMode {
    /// 全量模式（面板 / 帮助文本的展示顺序即它）
    pub const ALL: [CompressMode; 2] = [CompressMode::Ai, CompressMode::Raw];

    /// 落库 / `ui_data` 里的取值（与 TS 字符串一致）
    pub fn as_str(self) -> &'static str {
        match self {
            CompressMode::Ai => "ai",
            CompressMode::Raw => "raw",
        }
    }

    /// 解析用户输入（大小写不敏感，容忍首尾空白）
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ai" => Some(CompressMode::Ai),
            "raw" => Some(CompressMode::Raw),
            _ => None,
        }
    }

    /// 用户可见的名字（与 GUI 同一批文案：i18n 的「AI 摘要」/「正文压缩」）
    pub fn label(self) -> &'static str {
        match self {
            CompressMode::Ai => "AI 摘要",
            CompressMode::Raw => "正文压缩",
        }
    }
}

// ==================== 上下文占用（口径） ====================

/// 会话的「当前上下文占用」token —— 与 TS `token-ring.tsx::findContextTokens` **同口径**。
///
/// 从最后一条往前、命中即止，两个口径必须区分（见 TS `compress-context.ts` 的注释）：
/// - `uiData.contextTokens > 0`：压缩产物的「压缩后上下文大小」（本地估算）**优先**；
/// - 否则该消息的 `usage.totalTokens`：那一轮调用的真实 token（供应商回报）。
///
/// AI 摘要消息的 `usage` 是**那次摘要调用**的消耗（prompt 含压缩前的全部历史），
/// 拿它当占用会显示成「压缩后反而更大」，所以带 `contextTokens` 的消息一律优先。
pub fn context_tokens(messages: &[Message]) -> Option<i64> {
    for m in messages.iter().rev() {
        if let Some(ctx) = m
            .ui_data
            .as_ref()
            .and_then(|u| u.get("contextTokens"))
            .and_then(Value::as_i64)
        {
            if ctx > 0 {
                return Some(ctx);
            }
        }
        if let Some(u) = &m.usage {
            return Some(u.total_tokens);
        }
    }
    None
}

/// 占用比例（0.0 ~ 1.0；超过窗口按 1.0 截断）—— 与 TS `Math.min(used / MAX, 1)` 一致。
///
/// `window` = 100% 对应的上下文窗口（见 [`window_tokens_from_settings`]）；非正数回退默认值，
/// 避免除零。
pub fn context_ratio(used: i64, window: i64) -> f64 {
    let w = if window > 0 {
        window
    } else {
        CONTEXT_WINDOW_TOKENS
    };
    (used as f64 / w as f64).clamp(0.0, 1.0)
}

/// 占用百分比（四舍五入的整数）—— 与 TS `Math.round(ratio * 100)` 一致
pub fn context_percent(used: i64, window: i64) -> u32 {
    (context_ratio(used, window) * 100.0).round() as u32
}

/// 是否「值得压缩」—— 占用充裕时按 TS/GUI 同口径拦下（`< 40%`）
///
/// `None`（还没有任何用量数据）视为不满足：没有数据就不该假设上下文快满了。
pub fn should_compress(used: Option<i64>, window: i64) -> bool {
    match used {
        Some(n) => context_ratio(n, window) >= COMPRESS_MIN_RATIO,
        None => false,
    }
}

/// `200000 → 200k`、`12500 → 12.5k`（整数 k 不带多余的 `.0`）—— 与 TS `formatTokens` 同口径
pub fn format_tokens(tokens: i64) -> String {
    if tokens < 1000 {
        return tokens.to_string();
    }
    let k = tokens as f64 / 1000.0;
    if (k.fract()).abs() < f64::EPSILON {
        format!("{}k", k as i64)
    } else {
        format!("{:.1}k", k)
    }
}

// ==================== token 粗估 ====================

/// 字符是否属于 CJK / 全角区（与 CLI 表格渲染的 `is_wide` 同一批区间）
fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
    )
}

/// 本地**粗估** token 数（仅在拿不到 provider 真实用量时使用）。
///
/// 口径：CJK 按 ~0.6 token/字符（DeepSeek 类 BPE 对中文约 1.5 字符/token），
/// 其余按 4 字符/token。TS 的兜底是纯 `chars / 4` —— 那对中文会低估 3~4 倍，
/// 因此这里对 CJK 单独加权（差异见本模块文件头第 1 条）。
pub fn estimate_tokens(text: &str) -> i64 {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    (cjk as f64 * 0.6 + other as f64 / 4.0).ceil() as i64
}

/// 多段文本拼起来粗估（TS `estimateTokens(...texts)` 是「先 join 再计数」，同语义）
pub fn estimate_tokens_concat(parts: &[&str]) -> i64 {
    let joined = parts.concat();
    estimate_tokens(&joined)
}

// ==================== 压缩输入切片 ====================

/// 最后一个 summary 消息的下标（没有则 `None`）
pub fn last_summary_index(messages: &[Message]) -> Option<usize> {
    messages.iter().rposition(|m| m.role == "summary")
}

/// 参与压缩的消息切片 —— 与 TS 一致：**从最后一个 summary 起算**（含它本身，供下一次叠加）。
///
/// 为什么含它：上一次的摘要已经是「更早历史的压缩形态」，这次压缩要在它之上叠加；
/// 若从它**之后**开始，上一次摘要的内容就会永久丢失。
pub fn compress_slice(messages: &[Message]) -> &[Message] {
    match last_summary_index(messages) {
        Some(i) => &messages[i..],
        None => messages,
    }
}

/// 最后一条「清单快照」消息的下标（`uiData.type == "todo"`）。
///
/// 与 TS `pickCurrentTodos` 同义：模型 `todo_write` 的 tool_result 与用户改清单的 feedback
/// 消息是**同构**的权威载体，谁最新谁生效（不限 role）。
pub fn last_todo_index(messages: &[Message]) -> Option<usize> {
    messages.iter().rposition(|m| {
        m.ui_data
            .as_ref()
            .and_then(|u| u.get("type"))
            .and_then(Value::as_str)
            == Some("todo")
    })
}

/// 「当前活跃清单」的文本回执 —— 压缩时补进 summary 正文，让模型压缩后仍记得清单。
///
/// 仅在清单快照**落在本次压缩区间内**（`index >= slice_start`）时返回：它马上会被新的
/// summary 覆盖、模型将看不到；若它在更早的 summary 之前，说明上一次压缩已处理过，补了会重复。
/// 渲染复用 [`render_todo_content`]（与 tool_result 的正文逐字同格式，铁律 1）。
pub fn todo_recap(messages: &[Message], slice_start: usize) -> Option<String> {
    let i = last_todo_index(messages)?;
    if i < slice_start {
        return None;
    }
    let todos = messages[i]
        .ui_data
        .as_ref()
        .and_then(|u| u.get("todos"))
        .and_then(Value::as_array)?;
    Some(render_todo_content(todos, &[]))
}

// ==================== 压缩 ====================

/// 压缩入参
pub struct CompressInput<'a> {
    pub mode: CompressMode,
    pub session: &'a Session,
    /// 会话全量消息（本函数内部按 [`compress_slice`] 切片）
    pub messages: &'a [Message],
    /// 已按 `allowedTools` 过滤后的工具定义（与一次正常请求下发的完全一致）
    pub tool_defs: &'a [ToolDefinition],
    /// `ai` 模式**必需**；`raw` 模式忽略
    pub provider: Option<&'a dyn Provider>,
}

/// `ai` 模式那次模型调用的记账信息（供调用方写用量账本）
#[derive(Debug, Clone)]
pub struct LlmCall {
    pub usage: TokenUsage,
    /// `true` = provider 没回报 usage，值为本地估算（账本里要标出来）
    pub estimated: bool,
    pub duration_ms: i64,
}

/// 压缩结果
#[derive(Debug, Clone)]
pub struct CompressOutput {
    pub mode: CompressMode,
    /// 摘要正文（= `message.content` 的字符串形态）
    pub summary: String,
    /// 待**追加**到会话末尾的 summary 消息（含 `usage` / `ui_data`）
    pub message: Message,
    /// `raw` 模式省略的字符数（`ai` 模式恒为 0）
    pub omitted_chars: usize,
    /// 压缩后的上下文占用（本地估算）—— 与 `message.uiData.contextTokens` 同值
    pub context_tokens: i64,
    /// `ai` 模式的那次模型调用（`raw` 模式为 `None`）
    pub llm: Option<LlmCall>,
}

/// 压缩后的上下文占用估算：`systemPrompt + 工具 schema + 摘要`。
///
/// 与 TS 同口径（`compress-context.ts` 的 `contextTokens`）：**这是「下一轮请求的上下文大小」**，
/// 与「这次摘要调用花了多少」是**两个口径**，不可混用。
fn post_compress_tokens(session: &Session, tool_defs: &[ToolDefinition], summary: &str) -> i64 {
    let tools_json = if tool_defs.is_empty() {
        String::new()
    } else {
        serde_json::to_string(tool_defs).unwrap_or_default()
    };
    estimate_tokens_concat(&[&session.system_prompt, &tools_json, summary])
}

/// 压缩会话上下文（按 `mode` 分派）。
///
/// 只做「算出那条 summary 消息」这一件事 —— **不落库、不记账**（那是调用方的职责：
/// 落库 = `repo.append_messages(session_id, &[out.message])`，
/// 记账 = `agent::usage::record_usage(..., kind = "compress", usage = out.llm.usage, ...)`）。
/// 这样本模块保持无 I/O，单测可以直接跑。
pub async fn compress(
    input: CompressInput<'_>,
    cancel: &CancellationToken,
) -> Result<CompressOutput, String> {
    let slice = compress_slice(input.messages);
    // 与 TS 同一条闸：只有 1 条就没得压（压缩的意义是「多条 → 一条」）
    if slice.len() <= 1 {
        return Err("没有可压缩的消息（至少需要 2 条）".to_string());
    }

    // 清单保活：把「当前活跃清单」补进摘要正文（见 [`todo_recap`] 与模块头）。
    let recap = todo_recap(
        input.messages,
        last_summary_index(input.messages).unwrap_or(0),
    );
    let with_recap = |s: String| match &recap {
        Some(r) => format!("{}\n\n{}", s, r),
        None => s,
    };

    match input.mode {
        CompressMode::Raw => {
            let raw::RawCompressResult {
                summary,
                omitted_chars,
            } = raw::build_raw_summary(slice);
            // 摘要正文必须自包含：末尾补上当前清单（见 [`todo_recap`]）
            let summary = with_recap(summary);
            let ctx = post_compress_tokens(input.session, input.tool_defs, &summary);
            Ok(CompressOutput {
                mode: CompressMode::Raw,
                message: summary_message(CompressMode::Raw, &summary, raw_usage(ctx), ctx),
                summary,
                omitted_chars,
                context_tokens: ctx,
                // 纯本地渲染：不校验 provider、不发请求、不记账（与 TS 一致）
                llm: None,
            })
        }
        CompressMode::Ai => {
            let provider = input
                .provider
                .ok_or_else(|| "AI 摘要需要可用的 Provider（当前会话没有可用连接）".to_string())?;
            let out = ai::summarize(input.session, slice, input.tool_defs, provider, cancel).await?;
            // 摘要正文必须自包含：末尾补上当前清单（见 [`todo_recap`]）
            let content = with_recap(out.content);
            let ctx = post_compress_tokens(input.session, input.tool_defs, &content);
            Ok(CompressOutput {
                mode: CompressMode::Ai,
                message: summary_message(
                    CompressMode::Ai,
                    &content,
                    out.usage.clone(),
                    ctx,
                ),
                summary: content,
                omitted_chars: 0,
                context_tokens: ctx,
                llm: Some(LlmCall {
                    usage: out.usage,
                    estimated: out.estimated,
                    duration_ms: out.duration_ms,
                }),
            })
        }
    }
}

/// `raw` 模式的 `usage`：没有模型调用，用量就是「压缩后的上下文占用」本身
/// （与 TS 一致：`{ promptTokens: contextTokens, completionTokens: 0, totalTokens: contextTokens }`）。
/// 它落库时由调用方标 `estimated` —— 不是供应商回报的值。
fn raw_usage(context_tokens: i64) -> TokenUsage {
    TokenUsage {
        prompt_tokens: context_tokens,
        completion_tokens: 0,
        total_tokens: context_tokens,
        cached_tokens: None,
    }
}

/// 组装 summary 消息（两种模式同构，只有 `usage` / `ui_data` 的取值来源不同）
fn summary_message(mode: CompressMode, content: &str, usage: TokenUsage, ctx: i64) -> Message {
    Message {
        id: uuid::Uuid::new_v4().to_string(),
        role: "summary".to_string(),
        content: Value::String(content.to_string()),
        timestamp: crate::telemetry::now_ms(),
        usage: Some(usage),
        // 供 UI 区分压缩方式（compressMode）与展示「压缩后占用」（contextTokens）
        ui_data: Some(json!({
            "compressMode": mode.as_str(),
            "contextTokens": ctx,
        })),
        ..Default::default()
    }
}
