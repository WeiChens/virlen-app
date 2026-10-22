//! 压缩遮罩（P0-3）—— 把「上下文压缩」从**位置约定**升级为**显式区间**。
//!
//! ## 旧做法的问题
//! 压缩产物是一条 `role = "summary"` 的消息，追加在会话末尾；请求组装靠
//! 「从最后一条 summary 开始切片」（`provider::blocks::slice_messages` /
//! `getLastSummaryMessageIndex`）表达“更早的历史已被替换”。
//!
//! 这条约定把**语义**编码进了**位置**：
//! - 无法表达「只压中间一段、保留最近几轮」（保留尾部是这个设计的唯一出路）；
//! - 一旦 summary 被删除 / 移动 / 或者历史被窗口裁剪，边界就悄悄变了；
//! - 「已压缩区间」（`list_messages` / `read_messages` 的查询范围）也只能靠 summary 的 rowid 猜。
//!
//! ## 现在
//! 一次压缩在 `compactions` 表里写一条**不可变事实**：
//!
//! ```text
//! (session_id, start_message_id, end_message_id, summary_message_id)
//! ```
//!
//! 意思是「`[start, end]` 这段原始消息在模型上下文里由 `summary` 这条消息替代」。
//! 请求组装时用 [`apply_compaction_masks`] 按记录重建上下文：
//! - 遮罩区间被移除，summary 被放到**区间原来的位置**；
//! - 剩下的 summary 角色统一降级为 `user` —— 与两个协议（OpenAI / Anthropic）对
//!   `summary` 的处理完全等价，同时让 provider 不再按位置切片（上下文已在此处定稿）。
//!
//! **老会话没有记录 → 返回原样**，provider 继续走「最后一条 summary」切片，行为一字不变。

use crate::agent::types::Message;
use std::collections::{HashMap, HashSet};

/// 一条压缩记录（`compactions` 表的一行）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionMask {
    /// 被替代区间的第一条消息 id（含）
    pub start_message_id: String,
    /// 被替代区间的最后一条消息 id（含）
    pub end_message_id: String,
    /// 替代这条区间的 summary 消息 id
    pub summary_message_id: String,
}

/// 按压缩记录重建「模型上下文」。
///
/// - `masks` 为空 → 原样返回（老会话走 provider 的「最后一条 summary」切片）；
/// - 区间端点不在当前窗口里（已被分页 / 窗口裁掉）→ 跳过该条记录；
/// - 多条记录重叠 → 保留靠前的那条（压缩端不会产生重叠，这里只做防御）。
///
/// 返回的消息里**不再有 `summary` 角色**：summary 被放到区间原位并降级为 `user`，
/// 与协议层对 summary 的既有转换等价，从而避免 provider 再次按位置切片。
pub fn apply_compaction_masks(messages: &[Message], masks: &[CompactionMask]) -> Vec<Message> {
    if masks.is_empty() {
        return messages.to_vec();
    }

    let index_of: HashMap<&str, usize> = messages
        .iter()
        .enumerate()
        .map(|(i, m)| (m.id.as_str(), i))
        .collect();

    // 解析成下标，丢掉端点缺失 / 顺序颠倒的记录
    let mut spans: Vec<(usize, usize, usize)> = masks
        .iter()
        .filter_map(|mask| {
            let start = *index_of.get(mask.start_message_id.as_str())?;
            let end = *index_of.get(mask.end_message_id.as_str())?;
            let summary = *index_of.get(mask.summary_message_id.as_str())?;
            (end >= start).then_some((start, end, summary))
        })
        .collect();
    if spans.is_empty() {
        return messages.to_vec();
    }
    spans.sort_by_key(|(start, _, _)| *start);

    // 重叠防御：保留靠前的一条
    let mut accepted: Vec<(usize, usize, usize)> = Vec::new();
    for span in spans {
        match accepted.last() {
            Some(&(_, prev_end, _)) if span.0 <= prev_end => continue,
            _ => accepted.push(span),
        }
    }

    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    let mut cursor = 0usize;
    let mut emitted_summaries: HashSet<usize> = HashSet::new();

    for &(start, end, summary) in &accepted {
        // 区间之前的内容原样保留
        while cursor < start {
            push_original(messages, cursor, &emitted_summaries, &mut out);
            cursor += 1;
        }
        // 区间原位 → summary（角色降级，见模块头）
        let mut replaced = messages[summary].clone();
        replaced.role = "user".to_string();
        out.push(replaced);
        emitted_summaries.insert(summary);
        cursor = end + 1;
    }
    while cursor < messages.len() {
        push_original(messages, cursor, &emitted_summaries, &mut out);
        cursor += 1;
    }
    out
}

/// 压入一条未遮罩的原始消息（summary 角色统一降级；已被当作替代物用过的 summary 跳过）
fn push_original(
    messages: &[Message],
    index: usize,
    emitted_summaries: &HashSet<usize>,
    out: &mut Vec<Message>,
) {
    if emitted_summaries.contains(&index) {
        return; // 这条 summary 已经在遮罩位置输出过
    }
    let mut message = messages[index].clone();
    if message.role == "summary" {
        // 还剩的 summary 一定在遮罩区间之外（历史遗留 / 另一代压缩）：
        // 保留内容，但不能让 provider 按它的位置切片
        message.role = "user".to_string();
    }
    out.push(message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::ToolUseContent;
    use serde_json::json;

    fn message(id: &str, role: &str, content: &str) -> Message {
        Message {
            id: id.to_string(),
            role: role.to_string(),
            content: json!(content),
            timestamp: 1,
            ..Default::default()
        }
    }

    fn ids(messages: &[Message]) -> Vec<&str> {
        messages.iter().map(|m| m.id.as_str()).collect()
    }

    fn mask(start: &str, end: &str, summary: &str) -> CompactionMask {
        CompactionMask {
            start_message_id: start.into(),
            end_message_id: end.into(),
            summary_message_id: summary.into(),
        }
    }

    #[test]
    fn empty_masks_leave_messages_untouched() {
        let messages = vec![
            message("u1", "user", "问"),
            message("s1", "summary", "摘要"),
            message("a1", "assistant", "答"),
        ];
        assert_eq!(
            ids(&apply_compaction_masks(&messages, &[])),
            vec!["u1", "s1", "a1"]
        );
    }

    #[test]
    fn masked_span_is_replaced_in_place_by_the_summary() {
        let messages = vec![
            message("u1", "user", "第一轮"),
            message("a1", "assistant", "回答一"),
            message("u2", "user", "第二轮"),
            message("s1", "summary", "前两轮的摘要"),
        ];

        let out = apply_compaction_masks(&messages, &[mask("u1", "a1", "s1")]);
        // 遮罩区间被原位替换；summary 不再留在末尾（不重复），角色降级为 user
        assert_eq!(ids(&out), vec!["s1", "u2"]);
        assert_eq!(out[0].role, "user");
        assert_eq!(out[0].content, json!("前两轮的摘要"));
    }

    #[test]
    fn masks_apply_independently_and_keep_unmasked_tail() {
        let messages = vec![
            message("u1", "user", "一"),
            message("a1", "assistant", "二"),
            message("u2", "user", "三"),
            message("a2", "assistant", "四"),
            message("s1", "summary", "摘要一"),
            message("s2", "summary", "摘要二"),
        ];
        let masks = vec![mask("u1", "a1", "s1"), mask("u2", "a2", "s2")];

        // 两段都遮罩 → 只剩两条摘要（保留尾部为空）
        let out = apply_compaction_masks(&messages, &masks);
        assert_eq!(ids(&out), vec!["s1", "s2"]);
        assert!(out.iter().all(|m| m.role == "user"));

        // 只遮罩第一段 → 第二条 summary 也降级（不能让 provider 再按位置切片）
        let out = apply_compaction_masks(&messages, &masks[..1]);
        assert_eq!(ids(&out), vec!["s1", "u2", "a2", "s2"]);
        assert_eq!(out[3].role, "user");
    }

    #[test]
    fn missing_endpoints_are_skipped() {
        let messages = vec![
            message("u1", "user", "一"),
            message("s1", "summary", "摘要"),
        ];
        // 区间起点已被窗口裁掉 → 不改动
        assert_eq!(
            ids(&apply_compaction_masks(
                &messages,
                &[mask("gone", "u1", "s1")]
            )),
            vec!["u1", "s1"]
        );
    }

    #[test]
    fn reversed_span_is_ignored() {
        let messages = vec![
            message("u1", "user", "一"),
            message("u2", "user", "二"),
            message("s1", "summary", "摘要"),
        ];
        assert_eq!(
            ids(&apply_compaction_masks(
                &messages,
                &[mask("u2", "u1", "s1")]
            )),
            vec!["u1", "u2", "s1"]
        );
    }

    #[test]
    fn overlapping_masks_keep_the_earlier_span() {
        let messages = vec![
            message("u1", "user", "一"),
            message("u2", "user", "二"),
            message("u3", "user", "三"),
            message("s1", "summary", "摘要一"),
            message("s2", "summary", "摘要二"),
        ];
        let masks = vec![mask("u1", "u2", "s1"), mask("u2", "u3", "s2")];
        let out = apply_compaction_masks(&messages, &masks);
        assert_eq!(ids(&out), vec!["s1", "u3", "s2"]);
    }

    #[test]
    fn tool_protocol_survives_masking() {
        let mut assistant = message("a1", "assistant", "");
        assistant.tool_calls = Some(vec![ToolUseContent {
            type_: "tool_use".into(),
            id: "call_1".into(),
            name: "read_file".into(),
            input: json!({}),
        }]);
        let messages = vec![
            message("u1", "user", "读文件"),
            assistant,
            message("t1", "tool", "内容"),
            message("s1", "summary", "摘要"),
        ];
        // 成对区间（含 tool 段）整体被遮罩：不会留下悬空 tool 消息
        let out = apply_compaction_masks(&messages, &[mask("u1", "t1", "s1")]);
        assert_eq!(ids(&out), vec!["s1"]);
    }
}
