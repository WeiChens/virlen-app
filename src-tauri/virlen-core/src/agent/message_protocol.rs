//! 工具协议清洗 —— **每次 LLM 请求组装前**把消息列表修成协议合法形态。
//!
//! 背景（线上缺陷，会话「检测结果UI标注审核」）：同一条 `assistant(tool_calls)` 的
//! `tool_call_id` 被写了两条 tool 消息 —— 前端在「运行还在收尾」时补的「程序中断」占位
//! 先落了库，引擎随后又把真实结果落库。服务端直接 400：
//!
//! ```text
//! Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
//! ```
//!
//! 同类还会 400 的脏数据：tool 消息的 `tool_call_id` 为空（老版本没落这个字段，全库 247 条）、
//! `tool_call_id` 在本次请求里没有任何 assistant 声明过（如请求窗口被裁在 tool 段中间）。
//!
//! 于是把「协议自愈」放在请求组装这一唯一收口上（GUI / CLI / 桥接 Provider 全覆盖），
//! 四条规则：
//! 1. **去重** —— 同一 `tool_call_id` 只留一条：真实结果优先于「程序中断」占位，同类留最新；
//! 2. **丢孤儿** —— `tool_call_id` 为空、或列表中没有任何 assistant 声明过它的 tool 消息直接丢弃；
//! 3. **归位** —— tool 消息必须紧跟在声明它的 `assistant(tool_calls)` 之后，错位的搬回去；
//! 4. **补占位** —— assistant 声明了但没有任何 tool 应答的调用，补一条占位结果（否则依旧 400）。
//!
//! 只修**请求副本**，不回写数据库（同步修库由前端 `message-repair` 负责，两者规则须一致）。

use super::types::Message;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 悬空 `tool_call` 的占位正文。
///
/// ⚠️ 与前端 `src/services/message-repair.ts::INTERRUPTED_TOOL_RESULT` 逐字一致（铁律 1）：
/// 同一条悬空调用可能被两侧各自补一次占位 —— 文案不同会让模型看到两种「中断」措辞。
pub const INTERRUPTED_TOOL_RESULT: &str = "程序中断";

/// 本次清洗的动作计数（全 0 = 消息列表本来就合法）
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolRepairStats {
    /// 删掉的重复 tool 返回条数（同一 `tool_call_id` 多条）
    pub removed_duplicate: usize,
    /// 删掉的孤儿 tool 消息条数（id 缺失 / 无人声明的 id）
    pub removed_orphan: usize,
    /// 搬回 assistant 之后的错位 tool 返回条数
    pub moved: usize,
    /// 为悬空调用补的占位条数
    pub filled: usize,
}

impl ProtocolRepairStats {
    /// 本次是否改动过消息列表
    pub fn changed(&self) -> bool {
        self.removed_duplicate + self.removed_orphan + self.moved + self.filled > 0
    }

    /// 改动总条数（埋点上报用）
    pub fn total(&self) -> usize {
        self.removed_duplicate + self.removed_orphan + self.moved + self.filled
    }
}

/// 是否为「程序中断」占位（去重时真实结果优先于它）
fn is_interrupted(msg: &Message) -> bool {
    msg.text_content() == INTERRUPTED_TOOL_RESULT
}

/// 同 id 的重复 tool 返回里，`candidate` 是否应取代 `kept`
fn is_better_result(candidate: &Message, kept: &Message) -> bool {
    // 真实结果 > 占位；同为真实 / 同为占位 → 保留靠后（最新）的一条
    !(is_interrupted(candidate) && !is_interrupted(kept))
}

/// 构造「程序中断」占位 tool 返回（仅进请求，不落库）
fn make_interrupted_result(tool_call_id: &str) -> Message {
    Message {
        id: format!("repair-{}", tool_call_id),
        role: "tool".to_string(),
        content: Value::String(INTERRUPTED_TOOL_RESULT.to_string()),
        tool_call_id: Some(tool_call_id.to_string()),
        is_error: Some(true),
        timestamp: 0,
        ..Default::default()
    }
}

/// 清洗消息列表（纯函数）。返回清洗后的列表与动作计数；无异常时列表内容不变。
pub fn repair_tool_protocol(messages: Vec<Message>) -> (Vec<Message>, ProtocolRepairStats) {
    let mut stats = ProtocolRepairStats::default();

    // 声明表：本次请求里 assistant 声明过的 tool_call_id（只有它们才配被 tool 消息应答）
    let mut declared: HashSet<&str> = HashSet::new();
    for m in &messages {
        if m.role != "assistant" {
            continue;
        }
        if let Some(tcs) = &m.tool_calls {
            for tc in tcs {
                if !tc.id.is_empty() {
                    declared.insert(tc.id.as_str());
                }
            }
        }
    }

    // 定去留：空 id / 无人声明 → 丢（孤儿）；同 id 多条 → 只留最优那条
    let mut keep = vec![true; messages.len()];
    let mut kept_by_id: HashMap<&str, usize> = HashMap::new();
    for (i, m) in messages.iter().enumerate() {
        if m.role != "tool" {
            continue;
        }
        let id = m.tool_call_id.as_deref().unwrap_or("").trim();
        if id.is_empty() || !declared.contains(id) {
            keep[i] = false;
            stats.removed_orphan += 1;
            continue;
        }
        match kept_by_id.get(id) {
            None => {
                kept_by_id.insert(id, i);
            }
            Some(&prev) => {
                stats.removed_duplicate += 1;
                if is_better_result(m, &messages[prev]) {
                    keep[prev] = false;
                    kept_by_id.insert(id, i);
                } else {
                    keep[i] = false;
                }
            }
        }
    }

    // tool_call_id → 去重后唯一存活的那条 tool 消息下标
    let mut tool_index: HashMap<&str, usize> = HashMap::new();
    for (i, m) in messages.iter().enumerate() {
        if keep[i] && m.role == "tool" {
            if let Some(id) = m.tool_call_id.as_deref() {
                tool_index.insert(id, i);
            }
        }
    }

    // 按 assistant 的 tool_calls 顺序重排：tool 消息只随它的 assistant 输出（归位 / 补占位都在这）
    let mut out: Vec<Message> = Vec::with_capacity(messages.len());
    for (i, m) in messages.iter().enumerate() {
        if m.role == "tool" {
            continue;
        }
        out.push(m.clone());
        let tcs = match &m.tool_calls {
            Some(tcs) if !tcs.is_empty() => tcs,
            _ => continue,
        };
        // 紧随其后的连续 tool 段：落在这里才算「位置正确」
        let mut run_end = i + 1;
        while run_end < messages.len() && messages[run_end].role == "tool" {
            run_end += 1;
        }
        let mut emitted: HashSet<&str> = HashSet::new();
        for tc in tcs {
            // 同一 assistant 重复声明同一 id 时只应答一次：否则清洗本身会把同一条 tool 返回输出两遍
            if tc.id.is_empty() || !emitted.insert(tc.id.as_str()) {
                continue;
            }
            match tool_index.get(tc.id.as_str()) {
                Some(&ti) if keep[ti] => {
                    if ti <= i || ti >= run_end {
                        stats.moved += 1;
                    }
                    out.push(messages[ti].clone());
                }
                _ => {
                    out.push(make_interrupted_result(&tc.id));
                    stats.filled += 1;
                }
            }
        }
    }

    (out, stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::ToolUseContent;
    use serde_json::json;

    fn assistant_with_calls(ids: &[&str]) -> Message {
        Message {
            id: format!("asst-{}", ids.join("-")),
            role: "assistant".to_string(),
            content: Value::String(String::new()),
            tool_calls: Some(
                ids.iter()
                    .map(|id| ToolUseContent {
                        type_: "tool_use".to_string(),
                        id: (*id).to_string(),
                        name: "read_file".to_string(),
                        input: json!({}),
                    })
                    .collect(),
            ),
            timestamp: 1,
            ..Default::default()
        }
    }

    fn tool_result(id: &str, content: &str) -> Message {
        Message {
            id: format!("tool-{}-{}", id, content),
            role: "tool".to_string(),
            content: Value::String(content.to_string()),
            tool_call_id: Some(id.to_string()),
            timestamp: 2,
            ..Default::default()
        }
    }

    fn user(content: &str) -> Message {
        Message {
            id: format!("user-{}", content),
            role: "user".to_string(),
            content: Value::String(content.to_string()),
            timestamp: 3,
            ..Default::default()
        }
    }

    /// 线上现场：同一条命令被取消后，「程序中断」占位与真实结果都落了库 → 必须只留真实结果
    #[test]
    fn keeps_real_result_over_interrupted_placeholder() {
        let messages = vec![
            assistant_with_calls(&["c1"]),
            tool_result("c1", INTERRUPTED_TOOL_RESULT),
            tool_result("c1", "Command cancelled by the user"),
        ];
        let (out, stats) = repair_tool_protocol(messages);

        assert_eq!(stats.removed_duplicate, 1);
        assert_eq!(stats.removed_orphan, 0);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].text_content(), "Command cancelled by the user");
    }

    /// 占位在后（引擎先写真实结果、补占位迟到）→ 保留真实结果
    #[test]
    fn keeps_real_result_even_if_placeholder_comes_last() {
        let messages = vec![
            assistant_with_calls(&["c1"]),
            tool_result("c1", "real"),
            tool_result("c1", INTERRUPTED_TOOL_RESULT),
        ];
        let (out, _) = repair_tool_protocol(messages);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].text_content(), "real");
    }

    /// 空 tool_call_id 的孤儿（老版本残留）会让服务端 400 → 请求前丢弃
    #[test]
    fn drops_orphan_result_without_id() {
        let mut orphan = tool_result("", "老数据：没有 tool_call_id");
        orphan.tool_call_id = Some(String::new());
        let messages = vec![
            user("hi"),
            assistant_with_calls(&["c1"]),
            tool_result("c1", "ok"),
            orphan,
        ];
        let (out, stats) = repair_tool_protocol(messages);

        assert_eq!(stats.removed_orphan, 1);
        assert_eq!(out.len(), 3);
        assert!(out
            .iter()
            .all(|m| m.role != "tool" || m.tool_call_id.as_deref() != Some("")));
    }

    /// id 没人声明（请求窗口被裁在 tool 段中间）：留着必 400，只能丢
    #[test]
    fn drops_result_whose_call_is_not_declared() {
        let messages = vec![user("hi"), tool_result("c_unknown", "ok")];
        let (out, stats) = repair_tool_protocol(messages);

        assert_eq!(stats.removed_orphan, 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].role, "user");
    }

    /// 悬空 tool_calls（崩溃残留、CLI 无前端修复）→ 补占位，否则服务端要求 tool 紧随其后
    #[test]
    fn fills_missing_result_with_placeholder() {
        let messages = vec![assistant_with_calls(&["c1", "c2"]), tool_result("c2", "ok")];
        let (out, stats) = repair_tool_protocol(messages);

        assert_eq!(stats.filled, 1);
        // c2 的返回本就紧贴在 assistant 之后，只是要排在补出来的 c1 之后 → 不算搬动
        assert_eq!(stats.moved, 0);
        assert_eq!(out.len(), 3);
        assert_eq!(out[1].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(out[1].text_content(), INTERRUPTED_TOOL_RESULT);
        assert_eq!(out[2].tool_call_id.as_deref(), Some("c2"));
    }

    /// 错位的返回搬回 assistant 之后（中间插了用户消息）
    #[test]
    fn moves_misplaced_result_back_after_its_call() {
        let messages = vec![
            assistant_with_calls(&["c1"]),
            user("插在中间的用户消息"),
            tool_result("c1", "real"),
        ];
        let (out, stats) = repair_tool_protocol(messages);

        assert_eq!(stats.moved, 1);
        assert_eq!(stats.filled, 0);
        assert_eq!(out[1].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(out[1].text_content(), "real");
        assert_eq!(out[2].role, "user");
    }

    /// 没有工具消息的普通历史原样返回，且不产生任何计数
    #[test]
    fn leaves_plain_history_untouched() {
        let messages = vec![
            user("hi"),
            Message {
                role: "assistant".into(),
                content: Value::String("yo".into()),
                id: "a".into(),
                timestamp: 1,
                ..Default::default()
            },
        ];
        let (out, stats) = repair_tool_protocol(messages.clone());

        assert!(!stats.changed());
        assert_eq!(out.len(), messages.len());
        assert_eq!(out[1].text_content(), "yo");
    }

    /// 幂等：清洗结果再清洗一次无变化
    #[test]
    fn repair_is_idempotent() {
        let messages = vec![
            assistant_with_calls(&["c1", "c2"]),
            tool_result("c1", INTERRUPTED_TOOL_RESULT),
            tool_result("c1", "real"),
            user("next"),
        ];
        let (first, stats1) = repair_tool_protocol(messages);
        assert!(stats1.changed());

        let (second, stats2) = repair_tool_protocol(first.clone());
        assert!(!stats2.changed(), "二次清洗不应再改动: {:?}", stats2);
        assert_eq!(second.len(), first.len());
        assert_eq!(second[1].text_content(), "real");
    }

    /// 同一 assistant 重复声明同一 tool_call_id（LLM 异常输出）：只应答一次，不得把返回输出两遍
    #[test]
    fn does_not_answer_the_same_call_twice() {
        let mut assistant = assistant_with_calls(&["c1", "c1"]);
        if let Some(tcs) = assistant.tool_calls.as_mut() {
            tcs[0].id = "c1".into();
        }
        let messages = vec![assistant, tool_result("c1", "real")];
        let (out, _) = repair_tool_protocol(messages);

        assert_eq!(out.len(), 2, "同一条 tool 返回只能出现一次: {:?}", out);
        assert_protocol_legal(&out);
    }

    /// 线上现场回放：「检测结果UI标注审核」会话尾部真实序列
    ///
    /// 引擎先落 `assistant(execute_script)`，命令被取消后前端补「程序中断」占位落库，
    /// 引擎随后又落了真实结果 —— 同一 `tool_call_id` 两条 tool 消息，发送即 400。
    #[test]
    fn replays_real_production_payload() {
        let raw = json!([
            { "id": "u1", "role": "user", "content": "再执行一次", "timestamp": 1 },
            { "id": "a1", "role": "assistant", "content": "", "timestamp": 2,
              "toolCalls": [{ "type": "tool_use", "id": "call_00_qXY", "name": "parse_document", "input": { "path": "a.xlsx" } }] },
            { "id": "t1", "role": "tool", "content": "📄 workbook", "toolCallId": "call_00_qXY", "timestamp": 3 },
            { "id": "a2", "role": "assistant", "content": "", "timestamp": 4,
              "toolCalls": [{ "type": "tool_use", "id": "call_00_3Hlsv", "name": "execute_script", "input": { "filePath": "x.ps1" } }] },
            { "id": "t2", "role": "tool", "content": INTERRUPTED_TOOL_RESULT, "toolCallId": "call_00_3Hlsv", "isError": true, "timestamp": 5 },
            { "id": "t3", "role": "tool", "content": "Command cancelled by the user", "toolCallId": "call_00_3Hlsv", "timestamp": 6 },
            { "id": "u2", "role": "user", "content": "再次执行", "timestamp": 7 }
        ]);
        let messages: Vec<Message> = serde_json::from_value(raw).unwrap();

        let (out, stats) = repair_tool_protocol(messages);

        assert_eq!(stats.removed_duplicate, 1, "同 id 的两条 tool 消息必须去重");
        assert_eq!(stats.filled, 0, "去重后不应再补占位");
        assert_eq!(out.len(), 6, "只少掉被去重的那条");
        assert_eq!(
            out[4].text_content(),
            "Command cancelled by the user",
            "留下的应是真实结果"
        );
        assert_eq!(out[5].role, "user");
    }

    /// 清洗结果必须满足协议：每条 tool 消息都能对应上前面未重复应答的 tool_call，且无重复 id
    fn assert_protocol_legal(messages: &[Message]) {
        let mut open: Vec<String> = Vec::new();
        for m in messages {
            match m.role.as_str() {
                "assistant" => {
                    if let Some(tcs) = &m.tool_calls {
                        for tc in tcs {
                            open.push(tc.id.clone());
                        }
                    }
                }
                "tool" => {
                    let id = m.tool_call_id.clone().unwrap_or_default();
                    let pos = open
                        .iter()
                        .position(|o| *o == id)
                        .unwrap_or_else(|| panic!("tool 消息无可应答的 tool_calls: {}", id));
                    open.remove(pos);
                }
                _ => {}
            }
        }
    }

    #[test]
    fn repaired_output_is_protocol_legal() {
        let messages = vec![
            assistant_with_calls(&["c1", "c2"]),
            tool_result("c1", INTERRUPTED_TOOL_RESULT),
            tool_result("c1", "real"),
            user("next"),
            assistant_with_calls(&["c3"]),
            user("插在中间的用户消息"),
            tool_result("c3", "ok"),
        ];
        let (out, _) = repair_tool_protocol(messages);
        assert_protocol_legal(&out);

        // c2 无返回 → 补了占位，同样合法
        assert_eq!(out.len(), 7);
    }
}
