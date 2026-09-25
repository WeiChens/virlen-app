use super::*;
use crate::agent::bridge::AgentBridgeState;
use crate::agent::event_sink::EventSink;
use crate::agent::provider::Provider;
use crate::agent::types::{
    ChatRequest, Goal, Session, SessionParams, StreamEvent, ToolDefinition, ToolParameters,
    ToolUseContent,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

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
    fn types(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|(_, v)| v["type"].as_str().unwrap_or("").to_string())
            .collect()
    }
    /// 记录到的 user-interaction-request 会话 id 列表
    fn interaction_session_ids(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == "agent:user-interaction-request")
            .map(|(_, v)| v["sessionId"].as_str().unwrap_or("").to_string())
            .collect()
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

/// Mock Provider — 第 1 次返回 tool_use，之后返回纯文本
struct MockProvider {
    calls: AtomicUsize,
}

struct MockProviderFactory;

impl ProviderFactory for MockProviderFactory {
    fn create(&self, _conn: &crate::agent::types::ProviderConnection) -> Box<dyn Provider> {
        Box::new(MockProvider {
            calls: AtomicUsize::new(0),
        })
    }
}

/// Mock Provider — 先输出部分文本，然后等待取消并返回 Err("cancelled")
struct MockCancelProvider;

#[async_trait]
impl Provider for MockCancelProvider {
    async fn chat(
        &self,
        _request: &ChatRequest,
        _cancel: &CancellationToken,
    ) -> Result<Message, String> {
        Ok(Message::default())
    }
    async fn chat_stream(
        &self,
        _request: &ChatRequest,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String> {
        on_event(StreamEvent::TextDelta("partial answer".into()));
        cancel.cancelled().await;
        Err("cancelled".into())
    }
}

struct MockCancelProviderFactory;

impl ProviderFactory for MockCancelProviderFactory {
    fn create(&self, _conn: &crate::agent::types::ProviderConnection) -> Box<dyn Provider> {
        Box::new(MockCancelProvider)
    }
}

#[async_trait]
impl Provider for MockProvider {
    async fn chat(
        &self,
        _request: &ChatRequest,
        _cancel: &CancellationToken,
    ) -> Result<Message, String> {
        Ok(Message::default())
    }
    async fn chat_stream(
        &self,
        _request: &ChatRequest,
        _cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            on_event(StreamEvent::ToolUse(ToolUseContent {
                type_: "tool_use".into(),
                id: "tc_1".into(),
                name: "mock_tool".into(),
                input: json!({}),
            }));
            on_event(StreamEvent::MessageStop {
                reasoning_content: None,
                usage: None,
            });
        } else {
            on_event(StreamEvent::TextDelta("final answer".into()));
            on_event(StreamEvent::MessageStop {
                reasoning_content: None,
                usage: None,
            });
        }
        Ok(())
    }
}

fn make_session() -> Session {
    Session {
        id: "s1".into(),
        title: "test".into(),
        messages: vec![],
        provider_config_id: "p1".into(),
        model_id: "mock-model".into(),
        system_prompt: "".into(),
        params: SessionParams {
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: 1000,
            stream: true,
            reasoning_effort: None,
        },
        created_at: 0,
        updated_at: 0,
        pinned: false,
        tags: vec![],
        workspace: None,
        agent_id: None,
        allowed_tools: None,
        skills: None,
        system_prompt_manually_edited: None,
    }
}

fn make_tool_defs() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: "mock_tool".into(),
        label: None,
        description: "mock".into(),
        parameters: ToolParameters {
            type_: "object".into(),
            properties: json!({}),
            required: vec![],
            one_of: None,
        },
    }]
}

#[tokio::test]
async fn normal_loop_tool_then_text() {
    let bridge = Arc::new(AgentBridgeState::default());
    let sink = Arc::new(AutoRespondSink::new(
        bridge.clone(),
        json!({ "__kind": "value", "value": "mock result" }),
    ));
    let engine = AgentEngine::with_provider_factory(
        bridge.clone(),
        sink.clone(),
        Arc::new(MockProviderFactory),
    );

    let session = make_session();
    let result = engine
        .send_message(SendMessageOptions {
            session: session.clone(),
            messages: vec![],
            provider: Some(crate::agent::types::ProviderConnection {
                provider_type: "openai".into(),
                provider_id: "p1".into(),
                api_key: "k".into(),
                base_url: "http://localhost".into(),
            }),
            tool_defs: make_tool_defs(),
            enable_tools: true,
            max_tokens: None,
            resume_from_snapshot: None,
            reasoning_effort: None,
            max_tool_rounds: 10,
            iteration_goal: None,
            max_iterations: 5,
            session_id: "s1".into(),
            security: None,
            trace_id: None,
        })
        .await;

    assert!(result.is_ok(), "send_message failed: {:?}", result.err());
    let types = sink.types();
    assert!(types.contains(&"assistant_message_created".to_string()));
    assert!(types.contains(&"tool_call".to_string()));
    assert!(types.contains(&"tool_result_created".to_string()));
    assert!(types.contains(&"stream_end".to_string()));
    // 应无快照残留
    assert!(engine.get_run_snapshot("s1").is_none());
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

#[tokio::test]
async fn tool_interaction_routes_session() {
    let bridge = Arc::new(AgentBridgeState::default());
    // 工具先返回 interaction，然后交互回执返回 value
    let sink = Arc::new(AutoRespondSink::new(
        bridge.clone(),
        json!({
            "__kind": "interaction",
            "interactionType": "user_choice",
            "interactionData": { "question": "choose", "options": ["A"] },
        }),
    ));
    let engine = AgentEngine::with_provider_factory(
        bridge.clone(),
        sink.clone(),
        Arc::new(MockProviderFactory),
    );

    let session = make_session();
    let result = engine
        .send_message(SendMessageOptions {
            session: session.clone(),
            messages: vec![],
            provider: Some(crate::agent::types::ProviderConnection {
                provider_type: "openai".into(),
                provider_id: "p1".into(),
                api_key: "k".into(),
                base_url: "http://localhost".into(),
            }),
            tool_defs: make_tool_defs(),
            enable_tools: true,
            max_tokens: None,
            resume_from_snapshot: None,
            reasoning_effort: None,
            max_tool_rounds: 10,
            iteration_goal: None,
            max_iterations: 5,
            session_id: "s1".into(),
            security: None,
            trace_id: None,
        })
        .await;

    assert!(result.is_ok(), "send_message failed: {:?}", result.err());
    // 用户交互请求必须携带正确的 sessionId，前端才能路由到对应 handler
    let sids = sink.interaction_session_ids();
    assert!(!sids.is_empty(), "应发出 user-interaction-request");
    assert_eq!(sids.first().map(String::as_str), Some("s1"));
    let types = sink.types();
    assert!(types.contains(&"tool_result_created".to_string()));
    assert!(types.contains(&"stream_end".to_string()));
}

#[tokio::test]
async fn cancel_is_not_error_and_keeps_partial() {
    let bridge = Arc::new(AgentBridgeState::default());
    let sink = Arc::new(AutoRespondSink::new(
        bridge.clone(),
        json!({ "__kind": "value", "value": "mock result" }),
    ));
    let engine = Arc::new(AgentEngine::with_provider_factory(
        bridge.clone(),
        sink.clone(),
        Arc::new(MockCancelProviderFactory),
    ));

    // 延迟取消：让 provider 先输出部分内容，再触发取消
    let engine2 = engine.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        engine2.cancel("s1");
    });

    let session = make_session();
    let result = engine
        .send_message(SendMessageOptions {
            session: session.clone(),
            messages: vec![],
            provider: Some(crate::agent::types::ProviderConnection {
                provider_type: "openai".into(),
                provider_id: "p1".into(),
                api_key: "k".into(),
                base_url: "http://localhost".into(),
            }),
            tool_defs: make_tool_defs(),
            enable_tools: true,
            max_tokens: None,
            resume_from_snapshot: None,
            reasoning_effort: None,
            max_tool_rounds: 10,
            iteration_goal: None,
            max_iterations: 5,
            session_id: "s1".into(),
            security: None,
            trace_id: None,
        })
        .await;

    // 用户取消不应当作错误（前端不应弹 error-banner）
    assert!(result.is_ok(), "取消不应当作错误: {:?}", result.err());
    // partial 消息应走正常 finalize 路径（streaming:false 已通知前端）
    let types = sink.types();
    assert!(
        types.contains(&"assistant_message_updated".to_string()),
        "partial 消息应 finalize: {:?}",
        types
    );
    assert!(
        types.contains(&"stream_end".to_string()),
        "取消后应正常结束: {:?}",
        types
    );
}

#[allow(dead_code)]
fn _goal_helper() -> Goal {
    Goal {
        description: "goal".into(),
    }
}
