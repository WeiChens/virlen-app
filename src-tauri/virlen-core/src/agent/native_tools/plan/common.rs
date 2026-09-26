//! plan — 任务清单纯函数（无状态 / 无 IO）
//!
//! ⚠️ 与 TS 侧 `src/domain/todo/state.ts` 逐字对齐（铁律 1）：Rust 原生路径（默认引擎）与 JS 回退路径必
//! 须产出同一份 `content`（给模型）与同一份 `uiData`（给 UI），改一边必须同步另一边。
//!
//! 此处只移植工具执行真正用到的那部分（归一化 / 统计 / 软校验 / 渲染）；`diffTodos` / `pickCurrentTodos`
//! / `shouldShowTodoEntry` 等只服务「用户编辑清单」的 UI 与注入逻辑，仍留在 TS 侧（那是 JS 的天然职责）。

use serde_json::{json, Map, Value};

/// 清单上限（与 TS `domain/todo/types.ts::MAX_TODOS` 对齐）：超过直接报错，不静默截断
pub(crate) const MAX_TODOS: usize = 50;
/// 单条正文长度上限（与 TS `MAX_CONTENT_LEN` 对齐，防止模型塞进一整篇文档）
const MAX_CONTENT_LEN: usize = 300;
/// 单条备注长度上限（与 TS `MAX_NOTE_LEN` 对齐）
const MAX_NOTE_LEN: usize = 120;

const VALID_STATUS: [&str; 3] = ["pending", "in_progress", "completed"];

/// 按 **UTF-16 code unit** 截断 —— 与 JS `String.prototype.slice(0, max)` 同一计数口径。
///
/// ⚠️ 不能用 `chars().take(max)`：那是 Unicode 标量值计数，含 emoji（星形平面字符，JS 里算 2 个单位）时
/// 切点会与 TS 侧不同 → 同一输入两侧产出不同文本（铁律 1）。
fn clip_utf16(s: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in s.chars() {
        let len = ch.len_utf16();
        if units + len > max {
            break;
        }
        units += len;
        out.push(ch);
    }
    out
}

/// 取字符串字段并裁剪（非字符串 → 空串），等价 TS `clip(v, max)`（先 `trim()` 再截断）
fn clip(v: Option<&Value>, max: usize) -> String {
    match v {
        Some(Value::String(s)) => clip_utf16(s.trim(), max),
        _ => String::new(),
    }
}

/// 状态取值（非法 / 缺失 → `pending`，与 TS `isStatus()` 的兜底一致）
fn status_of(item: &Value) -> &str {
    match item.get("status").and_then(Value::as_str) {
        Some(s) if VALID_STATUS.contains(&s) => s,
        _ => "pending",
    }
}

/// 把模型给的原始数组归一化成清单项。
///
/// - 非数组 → 空（由调用方区分「清空」与「非法」）
/// - 丢弃 `content` 为空的项
/// - `status` 非法 → `pending`
/// - `id` 缺失 / 重复 → 自动补 `t{n}`（保证按 id 匹配的唯一性）
pub(crate) fn sanitize_todos(raw: &Value) -> Vec<Value> {
    let Value::Array(items) = raw else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();

    for item in items {
        let Value::Object(map) = item else {
            continue;
        };
        let content = clip(map.get("content"), MAX_CONTENT_LEN);
        if content.is_empty() {
            continue;
        }

        let mut id = match map.get("id") {
            Some(Value::String(s)) => s.trim().to_string(),
            _ => String::new(),
        };
        if id.is_empty() || seen.contains(&id) {
            id = format!("t{}", out.len() + 1);
        }
        // 极端情况下 `t{n}` 也可能撞车：再兜一层
        while seen.contains(&id) {
            id.push('_');
        }
        seen.push(id.clone());

        let mut obj = Map::new();
        obj.insert("id".into(), json!(id));
        obj.insert("content".into(), json!(content));
        obj.insert("status".into(), json!(status_of(item)));
        let active_form = clip(map.get("activeForm"), MAX_CONTENT_LEN);
        if !active_form.is_empty() {
            obj.insert("activeForm".into(), json!(active_form));
        }
        let note = clip(map.get("note"), MAX_NOTE_LEN);
        if !note.is_empty() {
            obj.insert("note".into(), json!(note));
        }
        out.push(Value::Object(obj));
    }

    out
}

/// 清单统计（与 TS `computeStats` 同口径）
pub(crate) struct TodoStats {
    pub total: usize,
    pub completed: usize,
    pub in_progress: usize,
    pub pending: usize,
}

pub(crate) fn compute_stats(todos: &[Value]) -> TodoStats {
    let mut stats = TodoStats {
        total: todos.len(),
        completed: 0,
        in_progress: 0,
        pending: 0,
    };
    for item in todos {
        match status_of(item) {
            "completed" => stats.completed += 1,
            "in_progress" => stats.in_progress += 1,
            _ => stats.pending += 1,
        }
    }
    stats
}

/// 软规则校验 —— **只报警、不改数据**。
///
/// 「最多一个 in_progress」是给模型的约定，而不是要静默篡改模型写入的内容：
/// 数据一旦被悄悄改动，模型下一轮看到的清单就和它以为的不一样了。
pub(crate) fn validate_todos(todos: &[Value]) -> Vec<String> {
    let in_progress = todos
        .iter()
        .filter(|t| status_of(t) == "in_progress")
        .count();
    if in_progress > 1 {
        vec![format!(
            "{} items are in_progress (convention: at most 1 at a time)",
            in_progress
        )]
    } else {
        Vec::new()
    }
}

/// 超限检查（返回错误文本；`None` = 通过）
pub(crate) fn check_todo_limit(raw_count: usize) -> Option<String> {
    if raw_count > MAX_TODOS {
        return Some(format!(
            "Too many tasks ({}, max {}). Please merge them into coarser-grained tasks and retry.",
            raw_count, MAX_TODOS
        ));
    }
    None
}

/// 给模型的紧凑清单正文 —— 模型读的是这条 `content`，不是 `uiData`
pub(crate) fn render_todo_content(todos: &[Value], warnings: &[String]) -> String {
    let s = compute_stats(todos);
    if todos.is_empty() {
        return "[Todo list updated] The task list was cleared (there are no pending tasks)."
            .to_string();
    }

    let lines: Vec<String> = todos
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let mut line = format!(
                "{}. [{}] {}",
                i + 1,
                status_of(item),
                item.get("content").and_then(Value::as_str).unwrap_or("")
            );
            if let Some(note) = item.get("note").and_then(Value::as_str) {
                line.push_str(" — ");
                line.push_str(note);
            }
            line
        })
        .collect();

    let mut parts = vec![
        format!(
            "[Todo list updated] {} items — {} completed, {} in progress, {} pending",
            s.total, s.completed, s.in_progress, s.pending
        ),
        String::new(),
    ];
    parts.extend(lines);
    if !warnings.is_empty() {
        parts.push(String::new());
        parts.push(format!("⚠️ {}", warnings.join("; ")));
    }
    parts.push(String::new());
    parts.push(
        "Rules: at most one item may be in_progress; mark completed as soon as it is done."
            .to_string(),
    );
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_drops_empty_content_and_fixes_ids() {
        let raw = json!([
            { "content": "  写代码  " },
            { "content": "   " },
            { "id": "a", "content": "A", "status": "in_progress" },
            { "id": "a", "content": "B", "status": "bogus" },
            { "id": "t1", "content": "C" },
        ]);
        let todos = sanitize_todos(&raw);
        assert_eq!(todos.len(), 4, "只丢弃空 content 的那一项: {todos:?}");
        // 第一条缺 id → t1
        assert_eq!(todos[0]["id"], "t1");
        assert_eq!(todos[0]["content"], "写代码");
        assert_eq!(todos[0]["status"], "pending");
        assert_eq!(todos[1]["id"], "a");
        assert_eq!(todos[1]["status"], "in_progress");
        // 重复 id → 重新分配（前两项已占 t1 / a → 取 t3）
        assert_eq!(todos[2]["id"], "t3");
        assert_eq!(todos[2]["status"], "pending", "非法 status → pending");
        // 与已分配的 t1 撞车 → 继续取下一个序号
        assert_eq!(todos[3]["id"], "t4");
        assert!(todos[2].get("note").is_none());

        // 自动补号撞上已有 id → 加下划线兜底（while 分支）
        let clash = sanitize_todos(&json!([
            { "id": "t2", "content": "X" },
            { "content": "Y" },
        ]));
        assert_eq!(clash[1]["id"], "t2_");
    }

    #[test]
    fn sanitize_non_array_is_empty() {
        assert!(sanitize_todos(&json!(null)).is_empty());
        assert!(sanitize_todos(&json!("x")).is_empty());
        assert!(sanitize_todos(&json!([1, 2, "x"])).is_empty());
    }

    #[test]
    fn sanitize_clips_like_js_slice() {
        // 300 个 UTF-16 单位：150 个 emoji（每个 2 单位）→ 恰好占满
        let emoji = "😀".repeat(150);
        let raw = json!([{ "content": emoji }]);
        let todos = sanitize_todos(&raw);
        assert_eq!(
            todos[0]["content"].as_str().unwrap().chars().count(),
            150,
            "按 UTF-16 单位计 300 上限 = 150 个 emoji"
        );
        // 151 个 → 第 151 个被切掉（不能切在代理对中间）
        let raw2 = json!([{ "content": "😀".repeat(151) }]);
        let t2 = sanitize_todos(&raw2);
        assert_eq!(t2[0]["content"].as_str().unwrap().chars().count(), 150);
        // note 上限 120 单位
        let raw3 = json!([{ "content": "a", "note": "b".repeat(200) }]);
        assert_eq!(
            sanitize_todos(&raw3)[0]["note"].as_str().unwrap().len(),
            120
        );
    }

    #[test]
    fn stats_and_validation() {
        let todos = sanitize_todos(&json!([
            { "content": "a", "status": "in_progress" },
            { "content": "b", "status": "in_progress" },
            { "content": "c", "status": "completed" },
        ]));
        let s = compute_stats(&todos);
        assert_eq!((s.total, s.completed, s.in_progress, s.pending), (3, 1, 2, 0));
        let warnings = validate_todos(&todos);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].starts_with("2 items are in_progress"));

        // 只有一个 in_progress → 无告警
        let ok = sanitize_todos(&json!([{ "content": "a", "status": "in_progress" }]));
        assert!(validate_todos(&ok).is_empty());
    }

    #[test]
    fn limit_check_message() {
        assert!(check_todo_limit(MAX_TODOS).is_none());
        let err = check_todo_limit(MAX_TODOS + 1).unwrap();
        assert!(err.starts_with(&format!("Too many tasks ({}", MAX_TODOS + 1)));
        assert!(err.ends_with("retry."));
    }

    #[test]
    fn render_content_exact_shape() {
        let todos = sanitize_todos(&json!([
            { "id": "t1", "content": "写代码", "status": "completed", "note": "done" },
            { "id": "t2", "content": "跑测试", "status": "in_progress" },
        ]));
        let warnings = validate_todos(&todos);
        let text = render_todo_content(&todos, &warnings);
        assert_eq!(
            text,
            "[Todo list updated] 2 items — 1 completed, 1 in progress, 0 pending\n\
             \n\
             1. [completed] 写代码 — done\n\
             2. [in_progress] 跑测试\n\
             \n\
             Rules: at most one item may be in_progress; mark completed as soon as it is done."
        );

        // 清空
        assert_eq!(
            render_todo_content(&[], &[]),
            "[Todo list updated] The task list was cleared (there are no pending tasks)."
        );

        // 有告警 → 追加一行
        let many = sanitize_todos(&json!([
            { "content": "a", "status": "in_progress" },
            { "content": "b", "status": "in_progress" },
        ]));
        let text2 = render_todo_content(&many, &validate_todos(&many));
        assert!(text2.contains("\n\n⚠️ 2 items are in_progress"));
    }
}
