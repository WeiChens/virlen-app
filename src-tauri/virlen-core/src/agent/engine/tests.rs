use super::*;
use crate::agent::bridge::AgentBridgeState;
use crate::agent::event_sink::EventSink;
use crate::agent::provider::Provider;
use crate::agent::types::{
    ChatRequest, Goal, Session, SessionParams, StreamEvent, ToolDefinition, ToolParameters,
    ToolStep, ToolStepStatus, ToolUseContent,
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

/// Mock Provider — 记录每次 `chat_stream` 收到的消息（断言引擎恢复时读回了哪些历史）
struct RecordingProvider {
    seen: Arc<Mutex<Vec<Message>>>,
}

struct RecordingProviderFactory {
    seen: Arc<Mutex<Vec<Message>>>,
}

impl ProviderFactory for RecordingProviderFactory {
    fn create(&self, _conn: &crate::agent::types::ProviderConnection) -> Box<dyn Provider> {
        Box::new(RecordingProvider {
            seen: self.seen.clone(),
        })
    }
}

#[async_trait]
impl Provider for RecordingProvider {
    async fn chat(
        &self,
        _request: &ChatRequest,
        _cancel: &CancellationToken,
    ) -> Result<Message, String> {
        Ok(Message::default())
    }
    async fn chat_stream(
        &self,
        request: &ChatRequest,
        _cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), String> {
        *self.seen.lock().unwrap() = request.messages.clone();
        on_event(StreamEvent::TextDelta("done".into()));
        on_event(StreamEvent::MessageStop {
            reasoning_content: None,
            usage: None,
        });
        Ok(())
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

/// Mock Provider — 跨多次 send 共享调用计数（第 1 次 tool_use，之后纯文本）
struct SharedMockProvider {
    calls: Arc<AtomicUsize>,
}

struct SharedMockProviderFactory {
    calls: Arc<AtomicUsize>,
}

impl ProviderFactory for SharedMockProviderFactory {
    fn create(&self, _conn: &crate::agent::types::ProviderConnection) -> Box<dyn Provider> {
        Box::new(SharedMockProvider {
            calls: self.calls.clone(),
        })
    }
}

#[async_trait]
impl Provider for SharedMockProvider {
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
                id: "tc_seq".into(),
                name: "mock_tool".into(),
                input: json!({}),
            }));
        } else {
            on_event(StreamEvent::TextDelta("done".into()));
        }
        on_event(StreamEvent::MessageStop {
            reasoning_content: None,
            usage: None,
        });
        Ok(())
    }
}

/// 交互回执按队列逐个下发（暂存 → 取消 等序列场景）
struct SeqInteractionSink {
    bridge: Arc<AgentBridgeState>,
    events: std::sync::Mutex<Vec<(String, Value)>>,
    tool_response: Value,
    interaction_responses: std::sync::Mutex<std::collections::VecDeque<Value>>,
}

impl EventSink for SeqInteractionSink {
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
            let resp = self.tool_response.clone();
            tokio::spawn(async move {
                crate::agent::bridge::handle_tool_response(&bridge, &rid, resp).await;
            });
        } else if event_name == "agent:user-interaction-request" {
            let rid = payload["requestId"].as_str().unwrap_or("").to_string();
            let bridge = self.bridge.clone();
            let resp = self
                .interaction_responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| json!({ "__kind": "value", "value": "ok" }));
            tokio::spawn(async move {
                crate::agent::bridge::handle_user_interaction_response(&bridge, &rid, resp).await;
            });
        }
        self.events
            .lock()
            .unwrap()
            .push((event_name.to_string(), payload));
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

/// 断点恢复时引擎应以**本地库为权威**读回历史消息，而不用前端经 IPC 传来的整份历史。
///
/// 对应修复：大历史（1000+ 条）下「继续时弹窗要等好几秒」——恢复不再把整份历史
/// 经 IPC 传入，改由引擎直接读 `SessionRepo`。
#[tokio::test]
async fn resume_reads_messages_from_repo() {
    use crate::session_db::tests::open_tmp;
    use crate::session_db::SessionRepo;

    let repo = open_tmp();
    // 独立 session id：避免与其他用例共用 "s1" 串到**进程级** StormBreaker（同一 tool+input 重复）
    let mut session = make_session();
    session.id = "s_resume_db".into();
    repo.upsert_session(&session).await.unwrap();
    repo.append_messages(
        "s_resume_db",
        &[
            Message {
                id: "seed_user".into(),
                role: "user".into(),
                content: json!("hi"),
                timestamp: 1,
                ..Default::default()
            },
            Message {
                id: "seed_asst".into(),
                role: "assistant".into(),
                content: json!("prev"),
                timestamp: 2,
                ..Default::default()
            },
        ],
    )
    .await
    .unwrap();

    let bridge = Arc::new(AgentBridgeState::default());
    let sink = Arc::new(AutoRespondSink::new(
        bridge.clone(),
        json!({ "__kind": "value", "value": "tool ok" }),
    ));
    let seen: Arc<Mutex<Vec<Message>>> = Arc::new(Mutex::new(Vec::new()));
    let engine = AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        Arc::new(repo),
        Arc::new(RecordingProviderFactory {
            seen: seen.clone(),
        }),
        crate::host::default_host().clone(),
        Arc::new(crate::session_db::NoopSettingsRepo),
    );

    // 快照里有一个待执行的 tool step；前端 **不传** 历史消息（修复后的行为）
    let snapshot = RunSnapshot {
        assistant_message_id: "seed_asst".into(),
        steps: vec![ToolStep {
            tool_call_id: "tc_resume".into(),
            tool_name: "mock_tool".into(),
            input: json!({}),
            status: ToolStepStatus::Pending,
            result: None,
            error: None,
            started_at: None,
            ui_data: None,
        }],
        round: 1,
        created_at: 0,
        paused: true,
    };

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
            resume_from_snapshot: Some(snapshot),
            reasoning_effort: None,
            max_tool_rounds: 10,
            iteration_goal: None,
            max_iterations: 5,
            session_id: "s_resume_db".into(),
            security: None,
            trace_id: None,
        })
        .await;
    assert!(result.is_ok(), "resume failed: {:?}", result.err());

    // 引擎发给 LLM 的消息里必须含库中的历史（证明它从库里读回了消息，而不是用空数组）
    let msgs = seen.lock().unwrap().clone();
    let ids: Vec<String> = msgs.iter().map(|m| m.id.clone()).collect();
    assert!(
        ids.contains(&"seed_user".to_string()),
        "恢复应读回库中历史消息，实际: {:?}",
        ids
    );
}

/// 恢复读回的是「**上下文**」而非整份历史：只有最后一个 `summary` 及其之后的消息进内存
/// （请求组装本就丢掉更早的历史），既省去旧历史的读取/反序列化，语义又与切片一致。
#[tokio::test]
async fn resume_reads_context_from_last_summary() {
    use crate::session_db::tests::open_tmp;
    use crate::session_db::SessionRepo;

    let repo = open_tmp();
    let mut session = make_session();
    // 独立 session id：避免与其他用例共用 "s1" 串到进程级 StormBreaker
    session.id = "s_resume_summary_db".into();
    repo.upsert_session(&session).await.unwrap();
    repo.append_messages(
        "s_resume_summary_db",
        &[
            Message {
                id: "old_user".into(),
                role: "user".into(),
                content: json!("old"),
                timestamp: 1,
                ..Default::default()
            },
            Message {
                id: "old_asst".into(),
                role: "assistant".into(),
                content: json!("old"),
                timestamp: 2,
                ..Default::default()
            },
            Message {
                id: "sum1".into(),
                role: "summary".into(),
                content: json!("summary body"),
                timestamp: 3,
                ..Default::default()
            },
            Message {
                id: "recent_user".into(),
                role: "user".into(),
                content: json!("recent"),
                timestamp: 4,
                ..Default::default()
            },
        ],
    )
    .await
    .unwrap();

    let bridge = Arc::new(AgentBridgeState::default());
    let sink = Arc::new(AutoRespondSink::new(
        bridge.clone(),
        json!({ "__kind": "value", "value": "tool ok" }),
    ));
    let seen: Arc<Mutex<Vec<Message>>> = Arc::new(Mutex::new(Vec::new()));
    let engine = AgentEngine::with_deps(
        bridge.clone(),
        sink.clone(),
        Arc::new(repo),
        Arc::new(RecordingProviderFactory {
            seen: seen.clone(),
        }),
        crate::host::default_host().clone(),
        Arc::new(crate::session_db::NoopSettingsRepo),
    );

    let snapshot = RunSnapshot {
        assistant_message_id: "old_asst".into(),
        steps: vec![ToolStep {
            tool_call_id: "tc_resume_sum".into(),
            tool_name: "mock_tool".into(),
            input: json!({}),
            status: ToolStepStatus::Pending,
            result: None,
            error: None,
            started_at: None,
            ui_data: None,
        }],
        round: 1,
        created_at: 0,
        paused: true,
    };

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
            resume_from_snapshot: Some(snapshot),
            reasoning_effort: None,
            max_tool_rounds: 10,
            iteration_goal: None,
            max_iterations: 5,
            session_id: "s_resume_summary_db".into(),
            security: None,
            trace_id: None,
        })
        .await;
    assert!(result.is_ok(), "resume failed: {:?}", result.err());

    let msgs = seen.lock().unwrap().clone();
    let ids: Vec<String> = msgs.iter().map(|m| m.id.clone()).collect();
    assert!(
        ids.contains(&"sum1".to_string()),
        "应读入最近的 summary，实际: {:?}",
        ids
    );
    assert!(
        ids.contains(&"recent_user".to_string()),
        "应读入 summary 之后的消息，实际: {:?}",
        ids
    );
    assert!(
        !ids.contains(&"old_user".to_string()),
        "不应读入 summary 之前的旧历史，实际: {:?}",
        ids
    );
    assert!(
        !ids.contains(&"old_asst".to_string()),
        "不应读入 summary 之前的旧历史，实际: {:?}",
        ids
    );
}

/// 「暂存 → 继续 → 取消」后，恢复已把所有待办步骤跑完：引擎**不能再留快照**。
///
/// 否则 `finishWorking` 会读到一个「残留快照」把会话误标成「已暂停」；
/// 且下次「继续」会按它把已完成的步骤重跑一遍 → 同一 tool_call_id 产出第二条 tool 结果
/// → 服务端 400（`tool must be a response to a preceding message with tool_calls`）。
#[tokio::test]
async fn resume_completing_steps_clears_snapshot() {
    let bridge = Arc::new(AgentBridgeState::default());
    let sink = Arc::new(SeqInteractionSink {
        bridge: bridge.clone(),
        events: std::sync::Mutex::new(Vec::new()),
        tool_response: json!({
            "__kind": "interaction",
            "interactionType": "user_choice",
            "interactionData": { "question": "q", "options": ["A", "B"] }
        }),
        interaction_responses: std::sync::Mutex::new(std::collections::VecDeque::from(vec![
            json!({ "__kind": "shelved" }),
            json!({ "__kind": "cancelled" }),
        ])),
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = AgentEngine::with_provider_factory(
        bridge.clone(),
        sink.clone(),
        Arc::new(SharedMockProviderFactory {
            calls: calls.clone(),
        }),
    );
    // 独立 session id：避免与其他用例共用 "s1" 串到**进程级** StormBreaker
    let mut session = make_session();
    session.id = "s_resume_seq".into();
    let opts = |resume: Option<RunSnapshot>| SendMessageOptions {
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
        resume_from_snapshot: resume,
        reasoning_effort: None,
        max_tool_rounds: 10,
        iteration_goal: None,
        max_iterations: 5,
        session_id: "s_resume_seq".into(),
        security: None,
        trace_id: None,
    };

    // ① 工具返回 user_choice 交互，用户「暂存」→ 留下快照
    engine.send_message(opts(None)).await.unwrap();
    let snap = engine.get_run_snapshot("s_resume_seq");
    assert!(snap.is_some(), "暂存后应留下快照");

    // ②「继续」→ 重跑未完成步骤；用户「取消」→ 该步骤拿到结果、本轮全部完成
    engine.send_message(opts(snap)).await.unwrap();
    assert!(
        engine.get_run_snapshot("s_resume_seq").is_none(),
        "恢复跑完所有待办步骤后不应残留快照（否则 UI 误显示已暂停，再次继续会重跑并触发 400）"
    );
}
