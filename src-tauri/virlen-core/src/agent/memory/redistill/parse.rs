//! 再蒸馏的模型输出解析（**纯函数**，容错但绝不猜）
//!
//! 容错的是「包装」：前后可能有寒暄、外面可能包了 ```json 围栏、后面可能还有一句总结 —— 都不影响判断。
//! 不容错的是「内容」：没有 JSON、没有 `groups`、条目缺 `summary` / `source_ids`，一律丢（或整次失败）。
//!
//! 与「一天素材 → 记忆」的旧实现同款取舍：**解析层只管形状，不管语义** ——
//! 「引用的 id 是否存在」「压缩比够不够」都在 `plan::validate_drafts` 里判（两者各自单测）。

use serde_json::Value;

use super::plan::MergeDraft;

/// 模型必须输出的顶层键（提示词里也写了；缺了就整次丢弃）
const GROUPS_KEY: &str = "groups";

/// 解析模型输出：`{"groups":[{"source_ids":[…],"summary":"…","kind":"…","tags":[…],"detail":"…"}]}`
pub fn parse_redistill_response(raw: &str) -> Result<Vec<MergeDraft>, String> {
    let json = extract_json_object(raw)
        .ok_or_else(|| "模型输出里找不到 JSON 对象（期望 {\"groups\":[…]})".to_string())?;
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("模型输出不是合法 JSON: {}", e))?;
    let list = value
        .get(GROUPS_KEY)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("模型输出的 JSON 缺少 `{}` 数组", GROUPS_KEY))?;
    Ok(list.iter().filter_map(parse_draft_item).collect())
}

/// 解析单条（`None` = 这一条形状不可用，跳过；不影响同批其它条目）
fn parse_draft_item(item: &Value) -> Option<MergeDraft> {
    // 键名宽容（提示词写 `source_ids`，模型偶尔会写成驼峰）
    let source_ids: Vec<String> = item
        .get("source_ids")
        .or_else(|| item.get("sourceIds"))
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if source_ids.is_empty() {
        return None; // 没有溯源就没有合并的依据（校验层也无从判越界）
    }
    let summary = item.get("summary").and_then(Value::as_str)?.to_string();
    if summary.trim().is_empty() {
        return None; // 空正文：宁缺勿滥
    }
    let kind = item
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tags: Vec<String> = item
        .get("tags")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let detail = item
        .get("detail")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    Some(MergeDraft {
        source_ids,
        summary,
        kind,
        tags,
        detail,
    })
}

/// 取第一对花括号之间的内容（跳过 markdown 围栏与前后寒暄）
pub fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&raw[start..=end])
}

/// content 为块数组时拼出文本（块之间用换行分隔 —— 与 `session_db` 的纯文本提取同口径）
pub fn content_text(content: &Value) -> String {
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

    #[test]
    fn parses_fenced_json_with_surrounding_prose() {
        let raw = "Sure, here is the result:\n```json\n{\"groups\":[{\"source_ids\":[\"m_1\",\"m_2\"],\"summary\":\"合并后的一句话\",\"kind\":\"project\",\"tags\":[\" virlen-app \"]}]}\n```\nHope that helps!";
        let drafts = parse_redistill_response(raw).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].source_ids, vec!["m_1", "m_2"]);
        assert_eq!(drafts[0].summary, "合并后的一句话");
        assert_eq!(drafts[0].kind, "project");
        assert_eq!(drafts[0].tags, vec!["virlen-app"]);
        assert!(drafts[0].detail.is_none());
    }

    #[test]
    fn empty_groups_is_a_valid_answer() {
        // 「压不动了」是合法且常见的答案（提示词里明说了）
        assert!(parse_redistill_response("{\"groups\":[]}").unwrap().is_empty());
    }

    #[test]
    fn rejects_output_without_usable_json() {
        assert!(parse_redistill_response("抱歉，我无法完成").is_err());
        assert!(parse_redistill_response("").is_err());
        assert!(parse_redistill_response("{not json}").is_err());
        assert!(parse_redistill_response("{\"memories\":[]}").is_err(), "顶层键必须是 groups");
        assert!(parse_redistill_response("{\"groups\":{}}").is_err());
    }

    #[test]
    fn drops_items_missing_shape_and_keeps_the_rest() {
        let raw = r#"{"groups":[
            {"summary":"没有来源","kind":"fact"},
            {"source_ids":[],"summary":"空来源","kind":"fact"},
            {"source_ids":["m_1"],"kind":"fact"},
            {"source_ids":["m_2"],"summary":"   ","kind":"fact"},
            {"source_ids":["m_3","m_4"],"summary":"合格的","kind":"decision","sourceIds":["ignored"]}
        ]}"#;
        let drafts = parse_redistill_response(raw).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].summary, "合格的");
        assert_eq!(drafts[0].kind, "decision");
    }

    #[test]
    fn parses_detail_and_lenient_key_names() {
        let raw = r#"{"groups":[{"sourceIds":["m_1","m_2"],"summary":"x","kind":"fact","detail":"  详细说明  "}]}"#;
        let drafts = parse_redistill_response(raw).unwrap();
        assert_eq!(drafts[0].detail.as_deref(), Some("详细说明"));
    }

    #[test]
    fn extract_json_object_handles_prose_and_fences() {
        assert_eq!(extract_json_object("a{\"x\":1}b"), Some("{\"x\":1}"));
        assert_eq!(extract_json_object("{\"x\":{\"y\":2}} tail"), Some("{\"x\":{\"y\":2}}"));
        assert_eq!(extract_json_object("no json here"), None);
        assert_eq!(extract_json_object("} {"), None, "倒序的花括号不算");
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
}
