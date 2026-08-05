//! 事件出口 — 将引擎事件转发到前端
//!
//! - `agent:event` — 标准 AgentEvent（与 TS 引擎 onEvent 载荷一致）
//! - `agent:tool-request` / `agent:user-interaction-request` / `agent:provider-request`
//!   — 双向桥请求（工具执行、用户交互、Provider 流）

use super::types::AgentEvent;
use tauri::Emitter;

pub trait EventSink: Send + Sync {
    /// 发出标准 AgentEvent
    fn emit_agent_event(&self, session_id: &str, event: &AgentEvent);
    /// 发出原始命名事件（桥接协议）
    fn emit_raw(&self, event_name: &str, payload: serde_json::Value);
}

pub struct TauriEventSink {
    app: tauri::AppHandle,
}

impl TauriEventSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_agent_event(&self, session_id: &str, event: &AgentEvent) {
        let payload = serde_json::json!({
            "sessionId": session_id,
            "event": event,
        });
        let _ = self.app.emit("agent:event", payload);
    }

    fn emit_raw(&self, event_name: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event_name, payload);
    }
}

/// 测试用事件收集器
#[cfg(test)]
#[allow(dead_code)]
pub struct TestEventSink {
    pub events: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}

#[cfg(test)]
#[allow(dead_code)]
impl TestEventSink {
    pub fn new() -> Self {
        Self {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[cfg(test)]
impl EventSink for TestEventSink {
    fn emit_agent_event(&self, session_id: &str, event: &AgentEvent) {
        self.events
            .lock()
            .unwrap()
            .push((session_id.to_string(), serde_json::to_value(event).unwrap()));
    }

    fn emit_raw(&self, event_name: &str, payload: serde_json::Value) {
        self.events
            .lock()
            .unwrap()
            .push((event_name.to_string(), payload));
    }
}
