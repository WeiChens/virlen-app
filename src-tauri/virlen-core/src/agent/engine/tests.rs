use super::*;
use crate::agent::bridge::AgentBridgeState;
use crate::agent::event_sink::EventSink;
use crate::agent::types::Goal;
use serde_json::{json, Value};

/// 自动回执事件收集器 — 收到 tool-request 立即用固定结果回复
struct AutoRespondSink {
    bridge: Arc<AgentBridgeState>,
    events: std::sync::Mutex<Vec<(String, Value)>>,
    response: Value,
    interaction_response: Value,
}

impl AutoRespondSink {
    fn new(bridge: Arc<AgentBridgeState>, response: Value) -> Self {
        Self {
            bridge,
            events: std::sync::Mutex::new(Vec::new()),
            response,
            interaction_response: json!({ "__kind": "value", "value": "ok" }),
        }
    }
}

impl EventSink for AutoRespondSink {
    fn emit_agent_event(&self, _session_id: &str, event: &AgentEvent) {
        self.events
            .lock()
            .unwrap()
            .push(("event".into(), serde_json::to_value(event).unwrap()));
    }
    fn emit_raw(&self, event_name: &str, payload: Value) {
        if event_name == "agent:tool-request" {
            let rid = payload["requestId"].as_str().unwrap_or("").to_string();
            let bridge = self.bridge.clone();
            let resp = self.response.clone();
            tokio::spawn(async move {
                crate::agent::bridge::handle_tool_response(
                    &bridge,
                    &rid,
                    resp,
                )
                .await;
            });
        } else if event_name == "agent:user-interaction-request" {
            let rid = payload["requestId"].as_str().unwrap_or("").to_string();
            let bridge = self.bridge.clone();
            let resp = self.interaction_response.clone();
            tokio::spawn(async move {
                crate::agent::bridge::handle_user_interaction_response(
                    &bridge,
                    &rid,
                    resp,
                )
                .await;
            });
        }
        self.events
            .lock()
            .unwrap()
            .push((event_name.to_string(), payload));
    }
}

#[tokio::test]
async fn cancel_prevents_snapshot_leak() {
    let bridge = Arc::new(AgentBridgeState::default());
    let sink = Arc::new(AutoRespondSink::new(
        bridge.clone(),
        json!({ "__kind": "value", "value": "mock result" }),
    ));
    let engine = AgentEngine::new(bridge.clone(), sink.clone());

    engine.cancel("s1");
    // 取消不存在的会话不应 panic
    assert!(engine.get_run_snapshot("s1").is_none());
}

#[test]
fn snapshot_roundtrip_through_engine() {
    let bridge = Arc::new(AgentBridgeState::default());
    let sink = Arc::new(AutoRespondSink::new(bridge.clone(), json!({})));
    let engine = AgentEngine::new(bridge.clone(), sink.clone());

    let run = Run {
        id: "run_x".into(),
        session_id: "s1".into(),
        assistant_message_id: "am1".into(),
        steps: vec![],
        created_at: 0,
        paused: false,
        round: 2,
    };
    engine.persist_snapshot("s1", &run);
    let snap = engine.get_run_snapshot("s1").unwrap();
    assert_eq!(snap.round, 2);
    engine.clear_run_snapshot("s1");
    assert!(engine.get_run_snapshot("s1").is_none());
}

#[allow(dead_code)]
fn _goal_helper() -> Goal {
    Goal {
        description: "goal".into(),
    }
}
