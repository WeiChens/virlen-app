//! `todo_write` 工具（原生）— 任务清单**全量替换**。
//!
//! 语义：模型每次必须传完整清单；空数组 = 清空清单（不做 merge/增量 —— 增量需要保存
//! 「上一版」状态，而状态只在消息历史里，工具执行器读不到，反而会引入一份影子状态）。
//!
//! 状态存放：本工具**不保存任何状态** —— 清单随 tool_result 消息的
//! `content`（给模型）+ `uiData`（给 UI）一起落库，UI 侧由 `pickCurrentTodos()`
//! 从消息里派生「唯一的那份清单」。
//!
//! ⚠️ 与 TS 侧 `src/infrastructure/tools/plan/todo-write.ts` **逐字对齐**（铁律 1）：
//! 三条校验错误的文本、`content` 渲染、`uiData` 结构都必须两侧一致。
//! 错误一律走 `NativeToolOutcome::Error`（content = 原文），与 JS 桥的
//! `BridgeToolResult::Error` 同形；**不要**用 `Err()`（那会被前缀成 `error: …`）。

use crate::agent::native_tools::plan::common::{
    check_todo_limit, compute_stats, render_todo_content, sanitize_todos, validate_todos,
};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

pub(crate) async fn todo_write_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let raw = args.get("todos");
    // 传了内容但不是数组 → 报错（`null` / 缺失等同「清空」，与 TS `args?.todos` 判定一致）
    if let Some(v) = raw {
        if !v.is_null() && !v.is_array() {
            return Ok(NativeToolOutcome::error(
                "Error: \"todos\" must be an array",
            ));
        }
    }

    let raw_count = raw
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);

    // 数量超限直接报错（不静默截断：残缺清单会让模型做出错误决策）
    if let Some(err) = check_todo_limit(raw_count) {
        return Ok(NativeToolOutcome::error(err));
    }

    let empty = Value::Null;
    let todos = sanitize_todos(raw.unwrap_or(&empty));
    // 传了内容但全部无效（缺 content）→ 报错，避免模型以为写进去了
    if raw_count > 0 && todos.is_empty() {
        return Ok(NativeToolOutcome::error(
            "Error: no valid task in \"todos\" (content must not be empty)",
        ));
    }

    let warnings = validate_todos(&todos);
    let stats = compute_stats(&todos);

    crate::telemetry::track(
        "todo.write",
        json!({
            "session_id": crate::telemetry::hash_id(ctx.session_id),
            "tool_call_id": ctx.tool_call_id,
            "total": stats.total,
            "completed": stats.completed,
            "in_progress": stats.in_progress,
            "pending": stats.pending,
            "warning_count": warnings.len(),
        }),
    );

    Ok(NativeToolOutcome::Value {
        content: render_todo_content(&todos, &warnings),
        ui_data: Some(json!({
            "type": "todo",
            "todos": todos,
            "stats": {
                "total": stats.total,
                "completed": stats.completed,
                "inProgress": stats.in_progress,
                "pending": stats.pending,
            },
            "source": "model",
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::bridge::AgentBridgeState;
    use crate::agent::cancellation::CancellationToken;
    use crate::agent::event_sink::TestEventSink;
    use crate::agent::native_tools::execute_native_tool;
    use crate::agent::native_tools::test_util::test_security_bare;
    use serde_json::json;

    async fn run(args: Value) -> NativeToolOutcome {
        let dir = std::env::temp_dir().join(format!("virlen_todo_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security_bare(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_todo",
            tool_call_id: "tc_todo",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: crate::agent::native_tools::noop_repo(),
            skills: None,
            host: crate::host::default_host().as_ref(),
        };
        let outcome = execute_native_tool(&ctx, "todo_write", &args)
            .await
            .expect("todo_write 不应返回 Err（模型侧错误必须走 Error 变体）");
        std::fs::remove_dir_all(&dir).ok();
        outcome
    }

    fn content_of(outcome: &NativeToolOutcome) -> String {
        match outcome {
            NativeToolOutcome::Value { content, .. } => content.clone(),
            NativeToolOutcome::Error { content, .. } => content.clone(),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[tokio::test]
    async fn writes_list_and_emits_ui_data() {
        let outcome = run(json!({
            "todos": [
                { "id": "t1", "content": "第一步", "status": "completed" },
                { "id": "t2", "content": "第二步", "status": "in_progress", "activeForm": "正在做第二步" },
                { "id": "t3", "content": "第三步" }
            ]
        }))
        .await;

        match &outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                assert!(content.starts_with("[Todo list updated] 3 items — 1 completed, 1 in progress, 1 pending"));
                assert!(content.contains("2. [in_progress] 第二步"));
                assert!(content.contains("Rules: at most one item may be in_progress"));
                let ui = ui_data.as_ref().expect("必须下发 uiData（UI 侧清单唯一来源）");
                assert_eq!(ui["type"], "todo");
                assert_eq!(ui["source"], "model");
                assert_eq!(ui["stats"]["total"], 3);
                assert_eq!(ui["stats"]["inProgress"], 1);
                assert_eq!(ui["todos"][1]["activeForm"], "正在做第二步");
                assert_eq!(ui["todos"][2]["status"], "pending");
            }
            other => panic!("expected Value, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn empty_array_clears_the_list() {
        let outcome = run(json!({ "todos": [] })).await;
        assert_eq!(
            content_of(&outcome),
            "[Todo list updated] The task list was cleared (there are no pending tasks)."
        );
        match outcome {
            NativeToolOutcome::Value { ui_data, .. } => {
                assert_eq!(ui_data.unwrap()["todos"].as_array().unwrap().len(), 0);
            }
            other => panic!("expected Value, got {other:?}"),
        }
    }

    /// 三条校验错误都必须走 Error（content = 原文），与 TS 侧抛出的 message 逐字一致
    #[tokio::test]
    async fn validation_errors_match_ts() {
        // 非数组
        let outcome = run(json!({ "todos": "not-an-array" })).await;
        assert!(matches!(outcome, NativeToolOutcome::Error { .. }));
        assert_eq!(content_of(&outcome), "Error: \"todos\" must be an array");

        // 全部无效
        let outcome = run(json!({ "todos": [{ "content": "  " }, { "note": "x" }] })).await;
        assert_eq!(
            content_of(&outcome),
            "Error: no valid task in \"todos\" (content must not be empty)"
        );

        // 超过 50 项
        let many: Vec<Value> = (0..51)
            .map(|i| json!({ "id": format!("t{}", i), "content": format!("任务{}", i) }))
            .collect();
        let outcome = run(json!({ "todos": many })).await;
        let text = content_of(&outcome);
        assert!(text.starts_with("Too many tasks (51, max 50)"), "got: {text}");
        assert!(text.ends_with("retry."));
    }

    /// 缺 `todos`（等同清空）与 `null` 都不报错
    #[tokio::test]
    async fn missing_or_null_todos_clears() {
        for args in [json!({}), json!({ "todos": null })] {
            let outcome = run(args).await;
            assert!(matches!(outcome, NativeToolOutcome::Value { .. }));
            assert!(content_of(&outcome).contains("was cleared"));
        }
    }

    /// 两个以上 in_progress 只**告警**，不改数据
    #[tokio::test]
    async fn multiple_in_progress_warns_without_mutating() {
        let outcome = run(json!({
            "todos": [
                { "content": "a", "status": "in_progress" },
                { "content": "b", "status": "in_progress" }
            ]
        }))
        .await;
        match outcome {
            NativeToolOutcome::Value { content, ui_data } => {
                assert!(content.contains("⚠️ 2 items are in_progress"));
                let ui = ui_data.unwrap();
                // 数据未被静默篡改
                assert_eq!(ui["stats"]["inProgress"], 2);
                assert_eq!(ui["todos"][1]["status"], "in_progress");
            }
            other => panic!("expected Value, got {other:?}"),
        }
    }
}
