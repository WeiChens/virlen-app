//! `user_choice` 工具（原生）— 让 AI 向用户提供选择（单选 / 多选）。
//!
//! 本工具**没有自己的执行逻辑**：它就是一个「用户交互请求」。原生路径返回
//! [`NativeToolOutcome::Interaction`]，由 `tool_executor::handle_user_interaction`
//! 经 `agent:user-interaction-request` 交给 UI —— 与 TS 引擎的 `UserInteractionRequired`
//! 走**同一条通道**（前端 `services/tool-service/index.ts` 按 `type === 'user_choice'`
//! 分派到同一个弹窗处理器），因此两侧行为天然一致。
//!
//! ⚠️ 交互类型与载荷字段必须与 TS 侧
//! `src/infrastructure/tools/system/user-choice.ts` 一致（铁律 1）。

use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{Map, Value};

pub(crate) async fn user_choice_tool(
    _ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    // 与 TS `{ question: args.question, options: args.options, multi: args.multi ?? false }` 等价：
    // 缺失 / `null` 的字段**不下发**（JS 里 `undefined` 会被 JSON 序列化直接丢弃），
    // `multi` 缺省为 `false`（但显式传入的值原样透传 —— 不替模型做类型纠正）。
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
            skills: None,
            host: crate::host::default_host().as_ref(),
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
