//! Agent 引擎核心类 — 编排 Provider、Tool、Session 的交互
//!
//! 移植自 `src/domain/engine/engine.ts`。
//! - Provider 由前端传入连接信息，Rust 侧构造（原生 OpenAI/Anthropic 或 JS 桥）
//! - 工具执行通过 JS 桥（工具本体仍在 JS）
//! - 事件通过 EventSink 发往前端
//! - 快照保存在内存 Map（页面刷新后不可恢复，与 TS 行为一致）

use super::bridge::AgentBridgeState;
use super::cancellation::CancellationToken;
use super::event_sink::EventSink;
use super::iteration::{run_iteration, RunIterationParams};
use super::llm_loop::{execute_llm_round, ExecuteLlmRoundParams};
use super::provider::{
    DefaultProviderFactory, Provider, ProviderFactory,
};
use super::run_state::{run_to_snapshot, snapshot_to_run};
use super::storm_breaker::{clear_all_tool_call_histories, clear_tool_call_history};
use super::tool_executor::execute_tool_steps;
use super::types::{
    AgentEvent, Message, NativeToolSecurity, Run, RunSnapshot, SendMessageOptions, Session,
    ToolDefinition,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct AgentEngine {
    pub bridge: Arc<AgentBridgeState>,
    pub sink: Arc<dyn EventSink>,
    provider_factory: Arc<dyn ProviderFactory>,
    run_snapshots: Mutex<HashMap<String, RunSnapshot>>,
    active_cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl AgentEngine {
    pub fn new(bridge: Arc<AgentBridgeState>, sink: Arc<dyn EventSink>) -> Self {
        Self::with_provider_factory(
            bridge.clone(),
            sink.clone(),
            Arc::new(DefaultProviderFactory {
                bridge,
                sink,
            }),
        )
    }

    /// 注入自定义 Provider 工厂（测试 / 定制用）
    pub fn with_provider_factory(
        bridge: Arc<AgentBridgeState>,
        sink: Arc<dyn EventSink>,
        provider_factory: Arc<dyn ProviderFactory>,
    ) -> Self {
        Self {
            bridge,
            sink,
            provider_factory,
            run_snapshots: Mutex::new(HashMap::new()),
            active_cancels: Mutex::new(HashMap::new()),
        }
    }

    /// 发送消息并获取回复
    pub async fn send_message(&self, options: SendMessageOptions) -> Result<(), String> {
        let session_id = options.session_id.clone();
        let cancel = CancellationToken::new();
        self.active_cancels
            .lock()
            .unwrap()
            .insert(session_id.clone(), cancel.clone());

        let result = self.send_message_inner(options, &cancel).await;

        self.active_cancels.lock().unwrap().remove(&session_id);
        clear_tool_call_history(&session_id);
        result
    }

    async fn send_message_inner(
        &self,
        options: SendMessageOptions,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let session_id = options.session_id.clone();
        let session = options.session.clone();

        // 1. 获取 provider
        let provider: Box<dyn Provider> = match &options.provider {
            Some(conn) => self.provider_factory.create(conn),
            None => return Err("Provider 未配置".to_string()),
        };

        // 2. 解析可用工具列表
        let tool_defs: Vec<ToolDefinition> = if options.enable_tools {
            options.tool_defs.clone()
        } else {
            Vec::new()
        };

        // 3. 维护内存中的消息列表，随 tool 循环增长
        let mut current_messages = options.messages.clone();
        let mut remaining_rounds = options.max_tool_rounds;

        let skills = session.skills.clone();

        // 4. 断点恢复：直接跳到执行未完成的 tool steps
        if let Some(snapshot) = &options.resume_from_snapshot {
            let resumed = self
                .resume_run(
                    snapshot,
                    &session_id,
                    cancel,
                    &session,
                    skills.clone(),
                    options.security.clone(),
                    &current_messages,
                    options.max_tool_rounds,
                )
                .await;
            match resumed {
                None => return Ok(()), // 恢复未完成（再次暂停）
                Some((messages, rounds)) => {
                    current_messages = messages;
                    remaining_rounds = rounds;
                }
            }
        }

        // 5. tool call 主循环（迭代模式或普通模式）
        let completed: bool;
        if let Some(goal) = &options.iteration_goal {
            let persist_closure = |sid: &str, run: &Run| self.persist_snapshot(sid, run);
            let clear_closure = |sid: &str| self.clear_snapshot(sid);
            let result = run_iteration(RunIterationParams {
                goal: &super::types::Goal {
                    description: goal.clone(),
                },
                session: &session,
                provider: provider.as_ref(),
                tool_defs: &tool_defs,
                current_messages: &current_messages,
                session_id: &session_id,
                cancel,
                sink: self.sink.as_ref(),
                bridge: self.bridge.as_ref(),
                skills: skills.clone(),
                security: options.security.clone(),
                effective_max_tokens: options.max_tokens.unwrap_or(session.params.max_tokens),
                reasoning_effort: options.reasoning_effort.clone(),
                max_iterations: options.max_iterations,
                persist_snapshot: Some(&persist_closure),
                clear_snapshot: Some(&clear_closure),
            })
            .await?;
            completed = result.0;
        } else {
            let persist_closure = |sid: &str, run: &Run| self.persist_snapshot(sid, run);
            let clear_closure = |sid: &str| self.clear_snapshot(sid);
            completed = self
                .execute_tool_loop(
                    &session,
                    provider.as_ref(),
                    &tool_defs,
                    &mut current_messages,
                    remaining_rounds,
                    &session_id,
                    cancel,
                    skills,
                    options.security.clone(),
                    options.max_tokens.unwrap_or(session.params.max_tokens),
                    options.reasoning_effort.clone(),
                    &persist_closure,
                    &clear_closure,
                )
                .await?;
        }

        if completed {
            self.sink.emit_agent_event(
                &session_id,
                &AgentEvent::new("stream_end", json!({})),
            );
        }
        Ok(())
    }

    /// 断点恢复：从 snapshot 重建 run，执行未完成的 tool steps
    async fn resume_run(
        &self,
        snapshot: &RunSnapshot,
        session_id: &str,
        cancel: &CancellationToken,
        _session: &Session,
        skills: Option<Vec<String>>,
        security: Option<NativeToolSecurity>,
        current_messages: &[Message],
        max_tool_rounds: i64,
    ) -> Option<(Vec<Message>, i64)> {
        let mut run = snapshot_to_run(snapshot, session_id);
        let (completed, tool_result_messages) = execute_tool_steps(
            &mut run,
            cancel,
            self.sink.as_ref(),
            self.bridge.as_ref(),
            skills,
            security,
            Some(&|r: &Run| {
                let snap = run_to_snapshot(r);
                if let Ok(mut map) = self.run_snapshots.lock() {
                    map.insert(session_id.to_string(), snap);
                }
            }),
        )
        .await;

        let mut messages = current_messages.to_vec();
        messages.extend(tool_result_messages);

        if !completed {
            return None;
        }

        let remaining = max_tool_rounds - snapshot.round.max(1);
        Some((messages, remaining))
    }

    /// Tool call 主循环：LLM 调用 → 工具执行 → 结果合并
    #[allow(clippy::too_many_arguments)]
    async fn execute_tool_loop(
        &self,
        session: &Session,
        provider: &dyn Provider,
        tool_defs: &[ToolDefinition],
        current_messages: &mut Vec<Message>,
        remaining_rounds: i64,
        session_id: &str,
        cancel: &CancellationToken,
        skills: Option<Vec<String>>,
        security: Option<NativeToolSecurity>,
        effective_max_tokens: i64,
        reasoning_effort: Option<String>,
        persist_closure: &(dyn Fn(&str, &Run) + Sync + Send),
        clear_closure: &(dyn Fn(&str) + Sync + Send),
    ) -> Result<bool, String> {
        let mut rounds = remaining_rounds;

        while rounds > 0 {
            rounds -= 1;
            let result = execute_llm_round(ExecuteLlmRoundParams {
                session,
                provider,
                tool_defs,
                messages: current_messages,
                session_id,
                cancel,
                sink: self.sink.as_ref(),
                bridge: self.bridge.as_ref(),
                skills: skills.clone(),
                security: security.clone(),
                effective_max_tokens,
                reasoning_effort: reasoning_effort.clone(),
                persist_snapshot: Some(persist_closure),
                clear_snapshot: Some(clear_closure),
            })
            .await?;

            if result.ctx.is_none() {
                break; // 没有 tool calls，结束循环
            }

            current_messages.push(result.assistant_message);
            current_messages.extend(result.tool_result_messages);

            if result.paused {
                return Ok(false); // 被暂停
            }
        }

        Ok(true)
    }

    // ==================== Snapshot 管理 ====================

    pub fn get_run_snapshot(&self, session_id: &str) -> Option<RunSnapshot> {
        self.run_snapshots.lock().unwrap().get(session_id).cloned()
    }

    pub fn clear_run_snapshot(&self, session_id: &str) {
        self.run_snapshots.lock().unwrap().remove(session_id);
    }

    /// 将 run 快照保存到内存 Map
    pub fn persist_snapshot(&self, session_id: &str, run: &Run) {
        let snap = run_to_snapshot(run);
        if let Ok(mut map) = self.run_snapshots.lock() {
            map.insert(session_id.to_string(), snap);
        }
    }

    /// 清除 run 快照
    pub fn clear_snapshot(&self, session_id: &str) {
        self.run_snapshots.lock().unwrap().remove(session_id);
    }

    // ==================== 生命周期 ====================

    /// 取消当前请求
    pub fn cancel(&self, session_id: &str) {
        self.run_snapshots.lock().unwrap().remove(session_id);
        clear_tool_call_history(session_id);
        if let Some(token) = self.active_cancels.lock().unwrap().get(session_id) {
            token.cancel();
        }
    }

    /// 销毁引擎
    pub fn dispose(&self) {
        for (_, token) in self.active_cancels.lock().unwrap().iter() {
            token.cancel();
        }
        self.active_cancels.lock().unwrap().clear();
        clear_all_tool_call_histories();
    }
}

#[cfg(test)]
mod tests {
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

    #[allow(dead_code)]
    fn _goal_helper() -> Goal {
        Goal {
            description: "goal".into(),
        }
    }
}
