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
use super::host::HostEnv;
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
use crate::session_db::{NoopSessionRepo, NoopSettingsRepo, SessionRepo, SettingsRepo};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct AgentEngine {
    pub bridge: Arc<AgentBridgeState>,
    pub sink: Arc<dyn EventSink>,
    pub repo: Arc<dyn SessionRepo>,
    /// 宿主环境（资源 / 数据目录）：原生工具（`vision_analyze`）需要
    /// 「模型文件在哪」，而那是宿主才知道的信息（详见 `agent/host.rs`）
    pub host: Arc<dyn HostEnv>,
    /// 应用配置仓储（`app_settings` 表，与会话库**同一把连接**）。
    ///
    /// 显式注入（与 `repo` / `host` 同风格）：原生工具 `web_search` 需要读
    /// `searchProviders` / `defaultSearchProviderId` —— 不必让前端下发，CLI 也自然可用。
    pub settings: Arc<dyn SettingsRepo>,
    provider_factory: Arc<dyn ProviderFactory>,
    run_snapshots: Mutex<HashMap<String, RunSnapshot>>,
    active_cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl AgentEngine {
    /// 仅测试使用（生产走 with_deps）
    #[allow(dead_code)]
    pub fn new(bridge: Arc<AgentBridgeState>, sink: Arc<dyn EventSink>) -> Self {
        Self::with_deps(
            bridge.clone(),
            sink.clone(),
            Arc::new(NoopSessionRepo),
            Arc::new(DefaultProviderFactory {
                bridge,
                sink,
            }),
            crate::host::default_host().clone(),
            Arc::new(NoopSettingsRepo),
        )
    }

    /// 注入自定义 Provider 工厂（测试 / 定制用）
    #[allow(dead_code)]
    pub fn with_provider_factory(
        bridge: Arc<AgentBridgeState>,
        sink: Arc<dyn EventSink>,
        provider_factory: Arc<dyn ProviderFactory>,
    ) -> Self {
        Self::with_deps(
            bridge,
            sink,
            Arc::new(NoopSessionRepo),
            provider_factory,
            crate::host::default_host().clone(),
            Arc::new(NoopSettingsRepo),
        )
    }

    /// 注入完整依赖（生产：SQLite repo + 默认 Provider 工厂 + GUI 宿主）
    pub fn with_deps(
        bridge: Arc<AgentBridgeState>,
        sink: Arc<dyn EventSink>,
        repo: Arc<dyn SessionRepo>,
        provider_factory: Arc<dyn ProviderFactory>,
        host: Arc<dyn HostEnv>,
        // 应用配置仓储：与会话库共用同一把连接，原生工具（web_search）直读它
        settings: Arc<dyn SettingsRepo>,
    ) -> Self {
        Self {
            bridge,
            sink,
            repo,
            host,
            settings,
            provider_factory,
            run_snapshots: Mutex::new(HashMap::new()),
            active_cancels: Mutex::new(HashMap::new()),
        }
    }

    /// 发送消息并获取回复
    pub async fn send_message(&self, options: SendMessageOptions) -> Result<(), String> {
        let session_id = options.session_id.clone();
        let trace_id = options.trace_id.clone();
        if let Some(t) = &trace_id {
            crate::telemetry::set_session_trace(&session_id, t);
        }
        let cancel = CancellationToken::new();
        self.active_cancels
            .lock()
            .unwrap()
            .insert(session_id.clone(), cancel.clone());

        let started = crate::telemetry::now_ms();
        crate::telemetry::track(
            "rust.engine.start",
            json!({
                "session_id": crate::telemetry::hash_id(&session_id),
                "trace_id": trace_id.clone().unwrap_or_default(),
            }),
        );

        let result = self.send_message_inner(options, &cancel).await;

        self.active_cancels.lock().unwrap().remove(&session_id);
        clear_tool_call_history(&session_id);

        let mut finish = json!({
            "session_id": crate::telemetry::hash_id(&session_id),
            "trace_id": trace_id.clone().unwrap_or_default(),
            "duration_ms": crate::telemetry::now_ms() - started,
            "status": if result.is_ok() { "success" } else { "fail" },
        });
        if let Some(e) = result.as_ref().err() {
            if let Some(map) = finish.as_object_mut() {
                map.insert("error".into(), json!(e));
            }
        }
        crate::telemetry::track("rust.engine.finish", finish);
        crate::telemetry::clear_session_trace(&session_id);

        result
    }

    async fn send_message_inner(
        &self,
        options: SendMessageOptions,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let session_id = options.session_id.clone();
        let session = options.session.clone();

        // 0. 持久化（先落库再开始循环）：会话元数据 + 用户消息
        //    JS 卡住/崩溃不影响落库；写入失败不中断聊天（尽力而为）
        //    ⚠️ 会话时间（updated_at）由 JS 在用户点发送时写好、随 session 一起 upsert；
        //    这里的消息写入刻意不刷新它（AI 回复 / 工具结果同理，见 SessionRepo::append_messages）
        if let Err(e) = self.repo.upsert_session(&session).await {
            eprintln!("[session_db] upsert session 失败: {}", e);
        }
        if let Err(e) = self
            .repo
            .append_messages_if_alive(&session_id, &options.messages)
            .await
        {
            eprintln!("[session_db] 写入用户消息失败: {}", e);
        }

        // 1. 获取 provider
        let provider: Box<dyn Provider> = match &options.provider {
            Some(conn) => self.provider_factory.create(conn),
            None => return Err("Provider is not configured".to_string()),
        };
        // 用量记账需要知道「钱花在哪个 provider 上」（连接信息已随 options 传入，见 ProviderConnection）
        let (provider_type, provider_config_id) = match &options.provider {
            Some(conn) => (conn.provider_type.clone(), conn.provider_id.clone()),
            None => (String::new(), String::new()),
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
                repo: self.repo.as_ref(),
                host: self.host.as_ref(),
                settings: self.settings.as_ref(),
                provider_type: &provider_type,
                provider_config_id: &provider_config_id,
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
                    &provider_type,
                    &provider_config_id,
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
            self.repo.as_ref(),
            self.host.as_ref(),
            self.settings.as_ref(),
        )
        .await;

        // 恢复执行产生的 tool 结果已由 execute_tool_steps 在执行途中增量直落，无需重复写
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
        provider_type: &str,
        provider_config_id: &str,
        persist_closure: &(dyn Fn(&str, &Run) + Sync + Send),
        clear_closure: &(dyn Fn(&str) + Sync + Send),
    ) -> Result<bool, String> {
        let mut rounds = remaining_rounds;
        let mut round_index: i64 = 0;

        while rounds > 0 {
            rounds -= 1;
            round_index += 1;

            // 轮次边界：上一批工具的 tool_result 已合并、下一次 LLM 请求尚未发出。
            // 把「AI 回复期间用户已应用的任务清单变更」注入消息列表，让紧接着的这次
            // 请求就能看到（与 TS 引擎 `onRoundBoundary` 同一时机，铁律 1）。
            super::bridge::inject_round_boundary_messages(
                self.bridge.as_ref(),
                self.sink.as_ref(),
                self.repo.as_ref(),
                session_id,
                current_messages,
            )
            .await;

            let result = match execute_llm_round(ExecuteLlmRoundParams {
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
                repo: self.repo.as_ref(),
                host: self.host.as_ref(),
                settings: self.settings.as_ref(),
                provider_type,
                provider_config_id,
                round: round_index,
                persist_snapshot: Some(persist_closure),
                clear_snapshot: Some(clear_closure),
            })
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    // 兜底：用户取消不应当作错误传播（do_llm_round 已处理大部分取消）
                    if cancel.is_cancelled() {
                        return Ok(false);
                    }
                    return Err(e);
                }
            };

            if result.ctx.is_none() {
                // 最终纯文本回复 / 用户取消的部分回复：先落库再结束循环
                if let Err(e) = self
                    .repo
                    .append_messages_if_alive(&session_id, &[result.assistant_message])
                    .await
                {
                    eprintln!("[session_db] 写入最终回复失败: {}", e);
                }
                break; // 没有 tool calls，结束循环
            }

            // 本轮消息已由 execute_llm_round / tool_executor 在执行途中增量直落，无需重复写
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
mod tests;
