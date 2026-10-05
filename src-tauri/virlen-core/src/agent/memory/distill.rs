//! 记忆蒸馏（P2）—— **一天素材 + 现有记忆 → 一次非流式 LLM 调用 → 记忆条目**
//!
//! 与 `agent::title` 同构：本模块只做「组装请求 → 解析模型输出」这一件事，**不落库、不记账**
//!（落库在 [`crate::agent::memory::store`]，编排与记账在 [`crate::agent::memory::consolidate`]）。
//! 这样整条「提示词长什么样、模型说人话时怎么办、模型说胡话时怎么办」都能用固定输入逐字断言。
//!
//! 三条硬约定：
//! - 模型侧文案固定英文（提示词在 `prompts/memory-distill.md`）；记忆正文**与素材同语言**——它是数据，不是提示词；
//! - 解析**绝不猜**「永久」：只有模型明确写 `permanent` 才落永久，其余（含缺失 / 非法 / 大小写不符）一律 `normal`
//!   —— 永久记忆是全量注入的，猜错的代价是**长期污染所有会话**；
//! - 分类错了不值得丢整条记忆（`kind` 只是标签），未知值收敛到 `fact`；而**正文为空**则直接丢弃（宁缺勿滥）。

use crate::agent::cancellation::CancellationToken;
use crate::agent::memory::{
    clamp_summary, is_valid_kind, MEMORY_DETAIL_MAX_CHARS, MEMORY_DETAIL_MIN_CHARS,
    MEMORY_DETAIL_TITLE_MAX_CHARS, MEMORY_DISTILL_MAX_INPUT_CHARS, MEMORY_EXISTING_MAX_CHARS,
    MEMORY_EXISTING_MAX_ITEMS, MEMORY_MAX_ITEMS_PER_DAY, MEMORY_MAX_TAGS,
};
use crate::agent::prompts;
use crate::agent::provider::Provider;
use crate::agent::types::{ChatRequest, Message, TokenUsage};
use crate::session_db::{MemoryRecord, SessionMaterial, MEMORY_LEVEL_NORMAL, MEMORY_LEVEL_PERMANENT};
use serde_json::Value;

/// 蒸馏调用的 `max_tokens`。
///
/// ⚠️ **必须显式钳制**：GUI 会话默认 `maxTokens` 是 `2000000`（不限制），原样透传给服务端会被
/// 直接拒掉（400 `Invalid max_tokens value`）。这里给一个够用的固定值：
/// 10 条记忆 + 最多几条 8k 字符的详情，8000 token 有余量。
pub const MEMORY_DISTILL_MAX_TOKENS: i64 = 8_000;

/// 蒸馏调用的温度：要与不要之间取低值（`title.rs` 是 0.3；这里要严格 JSON，取 0.2）
pub const MEMORY_DISTILL_TEMPERATURE: f64 = 0.2;

/// 模型必须输出的顶层键（提示词里也写了；解析失败即整次丢弃）
const MEMORIES_KEY: &str = "memories";

/// 一条蒸馏出来的记忆（尚未落库）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DistilledMemory {
    /// 正文（已按硬上限截断）
    pub summary: String,
    /// `user` | `project` | `decision` | `fact`（未知值已收敛为 `fact`）
    pub kind: String,
    /// `normal` | `permanent`（只有模型明确写了 `permanent` 才会是它）
    pub level: String,
    pub tags: Vec<String>,
    /// 需要落知识库的详情（标题与正文成对出现；否则都是 `None`）
    pub detail_title: Option<String>,
    pub detail_body: Option<String>,
}

/// 一次蒸馏调用的产物
#[derive(Debug, Clone)]
pub struct DistillOutput {
    pub items: Vec<DistilledMemory>,
    /// provider 未回报用量时为 `None`（不记账 —— 与 `title.rs` 同一取舍）
    pub usage: Option<TokenUsage>,
    /// 墙钟耗时（含首字延迟），供用量账本算 tok/s
    pub duration_ms: i64,
}

/// 组装蒸馏提示词：把两个占位符换成「现有记忆参照块」与「当天素材」。
///
/// 替换顺序固定为 `existing → material`：素材是用户内容，先替换它的话，素材里出现的
/// `{{existing}}` 字样会被当模板再替换一次（提示词注入面）。
pub fn build_prompt(materials: &[SessionMaterial], existing: &[MemoryRecord]) -> String {
    let material = render_material(materials, MEMORY_DISTILL_MAX_INPUT_CHARS);
    let existing_text = render_existing(existing);
    prompts::MEMORY_DISTILL
        .replace("{{existing}}", &existing_text)
        .replace("{{material}}", &material)
}

/// 渲染「现有记忆」参照块（去重对照用；**不带 id**：给模型看 id 只会诱发它把 id 抄进正文）
pub fn render_existing(existing: &[MemoryRecord]) -> String {
    let mut items: Vec<&MemoryRecord> = existing.iter().filter(|m| !m.disabled).collect();
    // 新的在前（近因更可能相关），同时间按 id 升序保证全序
    items.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    items.truncate(MEMORY_EXISTING_MAX_ITEMS);

    let mut out = String::new();
    for m in items {
        let line = format!("- [{}] {}", m.kind, m.summary.trim());
        if out.chars().count() + line.chars().count() > MEMORY_EXISTING_MAX_CHARS {
            out.push_str("\n…(older memories omitted)");
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line);
    }
    if out.trim().is_empty() {
        "(none)".to_string()
    } else {
        out
    }
}

/// 渲染当天素材（会话块按活动时间旧 → 新；超预算时**从最早的会话开始丢**）。
pub fn render_material(materials: &[SessionMaterial], max_chars: usize) -> String {
    let blocks: Vec<String> = materials
        .iter()
        .filter(|m| !m.text().trim().is_empty())
        .map(render_material_block)
        .collect();

    let mut kept: Vec<&str> = Vec::new();
    let mut used = 0usize;
    for block in blocks.iter().rev() {
        let n = block.chars().count();
        if !kept.is_empty() && used + n > max_chars {
            break;
        }
        used += n;
        kept.push(block.as_str());
    }
    kept.reverse();
    let joined = kept.join("\n\n");
    if joined.chars().count() <= max_chars {
        return joined;
    }
    // 单个块就超预算：保留它的**尾部**（结论通常在最后），前面加一句说明
    let skip = joined.chars().count() - max_chars;
    let tail: String = joined.chars().skip(skip).collect();
    format!("…(earlier part omitted)\n{}", tail)
}

/// 单个会话的素材块：元信息行 + 正文（摘要优先，无摘要时是正文摘录）
fn render_material_block(m: &SessionMaterial) -> String {
    let title = if m.title.trim().is_empty() {
        m.session_id.as_str()
    } else {
        m.title.trim()
    };
    let mut meta = format!("### Session: {}", title);
    if let Some(ws) = m.workspace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        meta.push_str(&format!(" | workspace: {}", ws));
    }
    if m.is_fallback() {
        // 告诉模型这批素材没有摘要（只是当天对话的摘录）—— 它会更保守，少产出而不是硬猜
        meta.push_str(" | source: dialogue excerpt (no compression summary)");
    } else {
        meta.push_str(" | source: compression summary");
    }
    format!("{}\n{}", meta, m.text().trim())
}

/// 组装请求：单条 user 消息（模板已内联素材），非流式、不带工具、禁用思考。
///
/// 为什么禁用思考：蒸馏的产出是严格 JSON，思考只会把 `max_tokens` 吃在推理上（`title.rs`
/// 踩过同一个坑 —— 预算被 reasoning 吃光后正文为空）。
pub fn build_request(model: &str, prompt: String) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        messages: vec![Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: "user".to_string(),
            content: Value::String(prompt),
            timestamp: crate::telemetry::now_ms(),
            ..Default::default()
        }],
        // 提示词自带全部规则，不需要系统提示词（与 `title.rs` 一致）
        system_prompt: None,
        tools: Vec::new(),
        temperature: MEMORY_DISTILL_TEMPERATURE,
        // 中性值：`top_p` 与 `temperature` 不建议同时调（本模块只调 temperature）
        top_p: 1.0,
        max_tokens: MEMORY_DISTILL_MAX_TOKENS,
        stream: false,
        tool_choice: "none".to_string(),
        reasoning_effort: None,
        thinking: Some(false),
    }
}

/// 执行一次蒸馏调用（**不落库、不记账**）。
///
/// 失败一律返回 `Err`：调用方（`consolidate`）据此换下一个候选模型，三次都失败就让这一天记 `failed`
/// —— 绝不写「半截」记忆（解析不出来就等于这一天白跑）。
pub async fn distill_once(
    provider: &dyn Provider,
    model: &str,
    prompt: String,
    cancel: &CancellationToken,
) -> Result<DistillOutput, String> {
    let request = build_request(model, prompt);
    let started = crate::telemetry::now_ms();
    let response = provider.chat(&request, cancel).await?;
    let duration_ms = crate::telemetry::now_ms() - started;

    let raw = match &response.content {
        Value::String(s) => s.clone(),
        other => content_text(other),
    };
    let items = parse_distill_response(&raw)?;
    Ok(DistillOutput {
        items,
        usage: response.usage,
        duration_ms,
    })
}

/// 从模型输出里解析记忆条目（**纯函数**，容错但绝不猜测）。
///
/// 容错的是「包装」：前面可能有解释文字、外面可能包了 ```json 围栏、后面可能还有一句总结 ——
/// 这些都不影响判断。不容错的是「内容」：没有 JSON、没有 `memories`、正文为空，都按失败 / 丢弃处理。
pub fn parse_distill_response(raw: &str) -> Result<Vec<DistilledMemory>, String> {
    let json = extract_json_object(raw)
        .ok_or_else(|| "模型输出里找不到 JSON 对象（期望 {{\"memories\":[…]}}）".to_string())?;
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("模型输出不是合法 JSON: {}", e))?;
    let list = value
        .get(MEMORIES_KEY)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("模型输出的 JSON 缺少 `{}` 数组", MEMORIES_KEY))?;

    let mut out: Vec<DistilledMemory> = Vec::new();
    for item in list {
        if out.len() >= MEMORY_MAX_ITEMS_PER_DAY {
            break; // 跑飞的兜底：宁可截断，也不要一天写进几百条
        }
        if let Some(m) = parse_distill_item(item) {
            out.push(m);
        }
    }
    Ok(out)
}

/// 解析单条（返回 `None` = 这一条不可用，跳过；不影响同批其它条目）
fn parse_distill_item(item: &Value) -> Option<DistilledMemory> {
    let raw_summary = item.get("summary").and_then(Value::as_str)?;
    let summary = clamp_summary(raw_summary);
    if summary.is_empty() {
        return None; // 空正文：宁缺勿滥
    }

    let kind = item
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let kind = if is_valid_kind(kind) {
        kind.to_string()
    } else {
        // 分类只是标签，错一个不值得丢整条记忆（与「未知级别一律降级」不同：这里是**中性**收敛）
        "fact".to_string()
    };

    // 只有**明确写出** permanent 才落永久（大小写 / 空格不符 → 普通）
    let level = match item.get("level").and_then(Value::as_str).map(str::trim) {
        Some(MEMORY_LEVEL_PERMANENT) => MEMORY_LEVEL_PERMANENT.to_string(),
        _ => MEMORY_LEVEL_NORMAL.to_string(),
    };

    let tags: Vec<String> = item
        .get("tags")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(MEMORY_MAX_TAGS)
                .collect()
        })
        .unwrap_or_default();

    let (detail_title, detail_body) = parse_detail(item);
    Some(DistilledMemory {
        summary,
        kind,
        level,
        tags,
        detail_title,
        detail_body,
    })
}

/// 详情：`needs_detail` 为真时**必须**同时给出标题与够长的正文，否则当没有详情处理。
fn parse_detail(item: &Value) -> (Option<String>, Option<String>) {
    if !item
        .get("needs_detail")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return (None, None);
    }
    let title = item
        .get("detail_title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let body = item
        .get("detail_body")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (title, body) {
        (Some(t), Some(b)) if b.chars().count() >= MEMORY_DETAIL_MIN_CHARS => (
            Some(t.chars().take(MEMORY_DETAIL_TITLE_MAX_CHARS).collect()),
            Some(b.chars().take(MEMORY_DETAIL_MAX_CHARS).collect()),
        ),
        // 只给了一半 / 正文太短 / 太长到只剩开头：都不落详情（摘要即全文，工具会如实说明）
        _ => (None, None),
    }
}

/// 取第一对花括号之间的内容（跳过 markdown 围栏与前后寒暄）
fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&raw[start..=end])
}

/// content 为块数组时拼出文本（块之间用换行分隔 —— 与 `session_db` 的纯文本提取同口径）
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .map(|b| b.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::{SessionParams, StreamEvent};
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    fn material(session: &str, title: &str, text: &str, updated_at: i64) -> SessionMaterial {
        SessionMaterial {
            session_id: session.into(),
            title: title.into(),
            workspace: Some("/work/app".into()),
            agent_id: None,
            summary: Some(text.into()),
            transcript: String::new(),
            updated_at,
        }
    }

    fn fallback_material(session: &str, text: &str, updated_at: i64) -> SessionMaterial {
        SessionMaterial {
            session_id: session.into(),
            title: String::new(),
            workspace: None,
            agent_id: None,
            summary: None,
            transcript: text.into(),
            updated_at,
        }
    }

    fn memory(summary: &str, kind: &str, created_at: i64) -> MemoryRecord {
        MemoryRecord {
            id: format!("m_{}", created_at),
            level: MEMORY_LEVEL_NORMAL.into(),
            kind: kind.into(),
            summary: summary.into(),
            created_at,
            ..Default::default()
        }
    }

    // ── 解析：容错包装 ──

    #[test]
    fn parses_fenced_json_with_surrounding_prose() {
        let raw = "Sure, here is the result:\n```json\n{\"memories\":[{\"summary\":\"用户偏好中文回复\",\"kind\":\"user\"}]}\n```\nHope that helps!";
        let items = parse_distill_response(raw).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].summary, "用户偏好中文回复");
        assert_eq!(items[0].kind, "user");
        assert_eq!(items[0].level, MEMORY_LEVEL_NORMAL, "缺 level → 普通");
        assert!(items[0].tags.is_empty());
        assert!(items[0].detail_body.is_none());
    }

    #[test]
    fn empty_memories_list_is_a_valid_answer() {
        // 「今天没什么值得记的」是合法答案，不是错误（宁缺勿滥）
        assert!(parse_distill_response("{\"memories\":[]}").unwrap().is_empty());
    }

    #[test]
    fn rejects_output_without_usable_json() {
        assert!(parse_distill_response("抱歉，我无法完成").is_err());
        assert!(parse_distill_response("").is_err());
        assert!(parse_distill_response("{not json}").is_err());
        assert!(parse_distill_response("{\"items\":[]}").is_err(), "顶层键必须是 memories");
        assert!(parse_distill_response("{\"memories\":{}}").is_err());
    }

    // ── 解析：单条校验 ──

    #[test]
    fn drops_empty_summary_and_keeps_the_rest() {
        let raw = r#"{"memories":[
            {"summary":"   ","kind":"fact"},
            {"summary":"有内容的一条","kind":"project"}
        ]}"#;
        let items = parse_distill_response(raw).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].summary, "有内容的一条");
    }

    #[test]
    fn unknown_kind_falls_back_to_fact_but_wrong_level_never_becomes_permanent() {
        let raw = r#"{"memories":[
            {"summary":"分类写错了","kind":"note","level":"PERMANENT"},
            {"summary":"级别写错了","kind":"decision","level":"high"}
        ]}"#;
        let items = parse_distill_response(raw).unwrap();
        assert_eq!(items[0].kind, "fact", "未知分类收敛为 fact（标签不值得丢整条）");
        assert_eq!(items[0].level, MEMORY_LEVEL_NORMAL, "未知级别一律普通 —— 绝不猜永久");
        assert_eq!(items[1].kind, "decision");
        assert_eq!(items[1].level, MEMORY_LEVEL_NORMAL);
    }

    #[test]
    fn explicit_permanent_is_accepted() {
        // 已定稿：不设确认门，模型可直接产出永久（用户靠面板降级兜底）
        let raw = r#"{"memories":[{"summary":"用户要求所有回复用中文","kind":"user","level":"permanent"}]}"#;
        let items = parse_distill_response(raw).unwrap();
        assert_eq!(items[0].level, MEMORY_LEVEL_PERMANENT);
    }

    #[test]
    fn over_long_summary_is_truncated_not_dropped() {
        let long = "字".repeat(crate::agent::memory::MEMORY_SUMMARY_MAX_CHARS + 30);
        let raw = format!(r#"{{"memories":[{{"summary":"{}","kind":"fact"}}]}}"#, long);
        let items = parse_distill_response(&raw).unwrap();
        assert_eq!(
            items[0].summary.chars().count(),
            crate::agent::memory::MEMORY_SUMMARY_MAX_CHARS + 1,
            "150 字符 + 省略号"
        );
    }

    #[test]
    fn tags_are_trimmed_capped_and_typed() {
        let raw = r#"{"memories":[{"summary":"x","kind":"fact","tags":[" virlen-app ","", "记忆", 42, "第四个"]}]}"#;
        let items = parse_distill_response(raw).unwrap();
        assert_eq!(items[0].tags, vec!["virlen-app", "记忆", "第四个"]);
    }

    #[test]
    fn needs_detail_requires_a_complete_and_long_enough_body() {
        let long_body = "详".repeat(MEMORY_DETAIL_MIN_CHARS);
        let raw = format!(
            r#"{{"memories":[
                {{"summary":"只有标题","kind":"fact","needs_detail":true,"detail_title":"标题"}},
                {{"summary":"正文太短","kind":"fact","needs_detail":true,"detail_title":"标题","detail_body":"太短"}},
                {{"summary":"完整详情","kind":"decision","needs_detail":true,"detail_title":"设计要点","detail_body":"{}"}},
                {{"summary":"不需要详情","kind":"fact","needs_detail":false,"detail_title":"被忽略","detail_body":"{}"}}
            ]}}"#,
            long_body, long_body
        );
        let items = parse_distill_response(&raw).unwrap();
        assert!(items[0].detail_body.is_none(), "缺正文 → 摘要即全文");
        assert!(items[1].detail_body.is_none(), "过短 → 不值得落知识库");
        assert_eq!(items[2].detail_title.as_deref(), Some("设计要点"));
        assert_eq!(
            items[2].detail_body.as_ref().unwrap().chars().count(),
            MEMORY_DETAIL_MIN_CHARS
        );
        assert!(items[3].detail_body.is_none(), "needs_detail=false 时不看详情字段");
    }

    #[test]
    fn detail_title_and_body_are_capped() {
        let title = "标".repeat(MEMORY_DETAIL_TITLE_MAX_CHARS + 20);
        let body = "详".repeat(MEMORY_DETAIL_MAX_CHARS + 100);
        let raw = format!(
            r#"{{"memories":[{{"summary":"x","kind":"fact","needs_detail":true,"detail_title":"{}","detail_body":"{}"}}]}}"#,
            title, body
        );
        let items = parse_distill_response(&raw).unwrap();
        assert_eq!(
            items[0].detail_title.as_ref().unwrap().chars().count(),
            MEMORY_DETAIL_TITLE_MAX_CHARS
        );
        assert_eq!(
            items[0].detail_body.as_ref().unwrap().chars().count(),
            MEMORY_DETAIL_MAX_CHARS
        );
    }

    #[test]
    fn items_are_capped_per_day() {
        let one = r#"{"summary":"x","kind":"fact"}"#;
        let raw = format!(
            "{{\"memories\":[{}]}}",
            (0..MEMORY_MAX_ITEMS_PER_DAY + 5)
                .map(|_| one)
                .collect::<Vec<_>>()
                .join(",")
        );
        let items = parse_distill_response(&raw).unwrap();
        assert_eq!(items.len(), MEMORY_MAX_ITEMS_PER_DAY);
    }

    // ── 素材渲染 ──

    #[test]
    fn material_prefers_summary_and_marks_fallback_sources() {
        let out = render_material(
            &[
                material("s1", "记忆功能", "摘要内容", 10),
                fallback_material("s2", "user: 帮我看看\nassistant: 好的", 20),
            ],
            MEMORY_DISTILL_MAX_INPUT_CHARS,
        );
        assert!(out.contains("### Session: 记忆功能 | workspace: /work/app | source: compression summary"));
        assert!(out.contains("摘要内容"));
        assert!(out.contains("### Session: s2 | source: dialogue excerpt (no compression summary)"));
        assert!(out.contains("user: 帮我看看"));
    }

    #[test]
    fn material_drops_the_oldest_blocks_when_over_budget() {
        let old = material("s_old", "旧会话", &"旧".repeat(4000), 1);
        let new = material("s_new", "新会话", &"新".repeat(4000), 2);
        let out = render_material(&[old, new], 4500);
        assert!(!out.contains("旧会话"), "超预算先丢最早的会话");
        assert!(out.contains("新会话"));
        assert!(out.chars().count() <= 4500);
    }

    #[test]
    fn existing_block_lists_kind_and_summary_newest_first() {
        let out = render_existing(&[
            memory("旧记忆", "user", 10),
            memory("新记忆", "project", 20),
        ]);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "- [project] 新记忆");
        assert_eq!(lines[1], "- [user] 旧记忆");
        // 没有记忆时给 (none)，而不是空串（空串会让模型把「现有记忆」理解成缺失上下文）
        assert_eq!(render_existing(&[]), "(none)");
    }

    #[test]
    fn existing_block_skips_disabled_and_respects_budget() {
        let mut off = memory("已停用", "fact", 30);
        off.disabled = true;
        assert_eq!(render_existing(&[off]), "(none)");

        let many: Vec<MemoryRecord> = (0..MEMORY_EXISTING_MAX_ITEMS + 10)
            .map(|i| memory(&"记".repeat(80), "fact", i as i64))
            .collect();
        let out = render_existing(&many);
        assert!(out.chars().count() <= MEMORY_EXISTING_MAX_CHARS + 40);
        assert!(out.contains("omitted") || out.lines().count() <= MEMORY_EXISTING_MAX_ITEMS);
    }

    // ── 提示词组装 ──

    #[test]
    fn prompt_replaces_both_placeholders() {
        let prompt = build_prompt(
            &[material("s1", "记忆功能", "在 virlen-app 实现记忆功能", 1)],
            &[memory("用户偏好中文", "user", 1)],
        );
        assert!(!prompt.contains("{{material}}"));
        assert!(!prompt.contains("{{existing}}"));
        assert!(prompt.contains("在 virlen-app 实现记忆功能"));
        assert!(prompt.contains("- [user] 用户偏好中文"));
        assert!(prompt.contains("# Memory Distillation"));
    }

    // ── 调用（含请求形状断言） ──

    struct CapturingProvider {
        reply: Value,
        usage: Option<TokenUsage>,
        seen: Arc<Mutex<Option<ChatRequest>>>,
    }

    #[async_trait]
    impl Provider for CapturingProvider {
        async fn chat(
            &self,
            request: &ChatRequest,
            _cancel: &CancellationToken,
        ) -> Result<Message, String> {
            *self.seen.lock().unwrap() = Some(request.clone());
            Ok(Message {
                id: "resp".into(),
                role: "assistant".into(),
                content: self.reply.clone(),
                usage: self.usage.clone(),
                timestamp: 0,
                ..Default::default()
            })
        }

        async fn chat_stream(
            &self,
            _request: &ChatRequest,
            _cancel: &CancellationToken,
            _on_event: &mut (dyn FnMut(StreamEvent) + Send),
        ) -> Result<(), String> {
            unreachable!("蒸馏只走非流式 chat")
        }
    }

    #[tokio::test]
    async fn distill_once_sets_request_shape_and_parses() {
        let seen = Arc::new(Mutex::new(None));
        let provider = CapturingProvider {
            reply: Value::String("{\"memories\":[{\"summary\":\"记忆功能上线\",\"kind\":\"project\"}]}".into()),
            usage: Some(TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                cached_tokens: None,
                cache_write_tokens: None,
            }),
            seen: seen.clone(),
        };
        let out = distill_once(&provider, "m1", "PROMPT".into(), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.usage.as_ref().unwrap().total_tokens, 120);

        let req = seen.lock().unwrap().clone().expect("必须发出请求");
        assert_eq!(req.model, "m1");
        assert_eq!(req.temperature, MEMORY_DISTILL_TEMPERATURE);
        assert_eq!(req.max_tokens, MEMORY_DISTILL_MAX_TOKENS, "max_tokens 必须钳制");
        assert!(!req.stream);
        assert_eq!(req.tool_choice, "none");
        assert!(req.tools.is_empty());
        assert!(req.system_prompt.is_none());
        assert_eq!(req.thinking, Some(false), "思考模式必须关（否则预算被 reasoning 吃掉）");
        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].content, Value::String("PROMPT".into()));
    }

    #[tokio::test]
    async fn distill_once_fails_on_unparsable_output() {
        let provider = CapturingProvider {
            reply: Value::String("我不太确定，也许可以记一下？".into()),
            usage: None,
            seen: Arc::new(Mutex::new(None)),
        };
        let err = distill_once(&provider, "m1", "P".into(), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("JSON"), "{}", err);
    }

    #[test]
    fn content_text_handles_blocks_and_null() {
        assert_eq!(content_text(&Value::Null), "");
        let blocks = serde_json::json!([
            { "type": "text", "text": "a" },
            { "type": "tool_use", "id": "x" },
            { "type": "text", "text": "b" }
        ]);
        assert_eq!(content_text(&blocks), "a\nb");
    }

    /// 会话参数 / 会话结构只为让 `Session` 构造可用（本模块不依赖它）
    #[allow(dead_code)]
    fn _unused_session_params() -> SessionParams {
        SessionParams {
            temperature: 0.0,
            top_p: 0.0,
            max_tokens: 0,
            stream: false,
            reasoning_effort: None,
        }
    }
}
