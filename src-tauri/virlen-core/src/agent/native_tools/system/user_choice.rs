//! `user_choice` 工具（原生）— 让 AI 向用户提供选择（单选 / 多选）。
//!
//! 没有自身执行逻辑：只返回 [`NativeToolOutcome::Interaction`]，经 `agent:user-interaction-request`
//! 交给 UI（与前端 `UserInteractionRequired` 同一通道，故两侧行为天然一致）。
//! ⚠️ 交互类型与载荷字段必须与 TS `system/user-choice.ts` 一致（铁律 1）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{Map, Value};

pub(crate) async fn user_choice_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    // 等价 TS `{ question, options, multi: args.multi ?? false }`：缺失 / null 字段不下发
    // （JS 的 undefined 序列化即丢弃），multi 缺省 false 但显式值原样透传。
    let mut data = Map::new();
    if let Some(q) = args.get("question") {
        if !q.is_null() {
            data.insert("question".into(), q.clone());
        }
    }
    if let Some(o) = args.get("options") {
        if !o.is_null() {
            data.insert("options".into(), o.clone());
        }
    }
    let multi = match args.get("multi") {
        None | Some(Value::Null) => Value::Bool(false),
        Some(v) => v.clone(),
    };
    data.insert("multi".into(), multi);

    Ok(NativeToolOutcome::Interaction {
        interaction_type: "user_choice".to_string(),
        interaction_data: Value::Object(data),
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
        let dir = std::env::temp_dir().join(format!("virlen_choice_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sec = test_security_bare(&dir.to_string_lossy());
        let sink = TestEventSink::new();
        let bridge = AgentBridgeState::default();
        let cancel = CancellationToken::new();
        let ctx = NativeToolCtx {
            session_id: "s_choice",
            tool_call_id: "tc_choice",
            cancel: &cancel,
            sink: &sink,
            bridge: &bridge,
            security: &sec,
            repo: crate::agent::native_tools::noop_repo(),
            memory: crate::agent::native_tools::noop_memory(),
            skills: None,
            host: crate::host::default_host().as_ref(),
            settings: crate::agent::native_tools::noop_settings(),
        };
        let outcome = execute_native_tool(&ctx, "user_choice", &args)
            .await
            .expect("user_choice 不应返回 Err");
        std::fs::remove_dir_all(&dir).ok();
        outcome
    }

    fn interaction(outcome: NativeToolOutcome) -> (String, Value) {
        match outcome {
            NativeToolOutcome::Interaction {
                interaction_type,
                interaction_data,
            } => (interaction_type, interaction_data),
            other => panic!("expected Interaction, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_user_choice_interaction() {
        let (type_, data) = interaction(
            run(json!({
                "question": "选哪个？",
                "options": ["A", "B"],
            }))
            .await,
        );
        assert_eq!(type_, "user_choice");
        assert_eq!(data["question"], "选哪个？");
        assert_eq!(data["options"], json!(["A", "B"]));
        // TS `args.multi ?? false`
        assert_eq!(data["multi"], json!(false));
    }

    #[tokio::test]
    async fn multi_passthrough_and_missing_fields() {
        let (type_, data) = interaction(
            run(json!({
                "question": "多选",
                "options": ["A"],
                "multi": true,
            }))
            .await,
        );
        assert_eq!(type_, "user_choice");
        assert_eq!(data["multi"], json!(true));

        // 缺 question / null options → 不下发该字段（与 JS 丢弃 undefined 等价）
        let (_, data) = interaction(run(json!({ "question": null, "options": null })).await);
        assert!(data.get("question").is_none(), "data: {data}");
        assert!(data.get("options").is_none(), "data: {data}");
        assert_eq!(data["multi"], json!(false));
    }

    /// 显式传入的非布尔 `multi` 原样透传（不替模型纠正类型）
    #[tokio::test]
    async fn multi_value_is_passed_through_as_is() {
        let (_, data) = interaction(run(json!({ "question": "q", "multi": "yes" })).await);
        assert_eq!(data["multi"], json!("yes"));
    }
}
