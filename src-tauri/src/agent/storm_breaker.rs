//! StormBreaker — 工具调用风暴防护
//!
//! 移植自 `src/domain/engine/storm-breaker.ts`。
//! 检测相同 (name, args) 在滑动窗口中出现 ≥ 阈值次时拦截。
//! 状态为内存级，按 session 维度存储。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

const WINDOW_SIZE: usize = 6;
const THRESHOLD: usize = 3;

struct CallRecord {
    signature: String,
    #[allow(dead_code)]
    timestamp: i64,
}

fn history() -> &'static Mutex<HashMap<String, Vec<CallRecord>>> {
    static HISTORY: OnceLock<Mutex<HashMap<String, Vec<CallRecord>>>> = OnceLock::new();
    HISTORY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 检查指定会话的工具调用是否触发风暴阈值。
/// 每次调用都会将当前调用记录写入滑动窗口。
/// 返回 true = 命中风暴模式，应拦截此次调用。
pub fn check_tool_call_storm(
    session_id: &str,
    tool_name: &str,
    input: &serde_json::Value,
) -> bool {
    let signature = format!(
        "{}({})",
        tool_name,
        serde_json::to_string(input).unwrap_or_default()
    );
    let now = chrono::Utc::now().timestamp_millis();

    let mut map = history().lock().unwrap();
    let records = map.entry(session_id.to_string()).or_default();

    records.push(CallRecord {
        signature: signature.clone(),
        timestamp: now,
    });

    // 只保留最近 WINDOW_SIZE 条
    if records.len() > WINDOW_SIZE {
        let start = records.len() - WINDOW_SIZE;
        records.drain(..start);
    }

    let count = records
        .iter()
        .filter(|r| r.signature == signature)
        .count();
    count >= THRESHOLD
}

/// 清除指定会话的调用历史（会话结束时调用）
pub fn clear_tool_call_history(session_id: &str) {
    history().lock().unwrap().remove(session_id);
}

/// 清除所有会话的调用历史（引擎销毁时调用）
pub fn clear_all_tool_call_histories() {
    history().lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SID: AtomicUsize = AtomicUsize::new(0);

    fn fresh_session() -> String {
        format!("s_test_{}", SID.fetch_add(1, Ordering::SeqCst))
    }

    #[test]
    fn below_threshold_allowed() {
        let sid = fresh_session();
        let input = serde_json::json!({ "a": 1 });
        assert!(!check_tool_call_storm(&sid, "tool_a", &input));
        assert!(!check_tool_call_storm(&sid, "tool_a", &input));
    }

    #[test]
    fn above_threshold_blocked() {
        let sid = fresh_session();
        let input = serde_json::json!({ "a": 1 });
        assert!(!check_tool_call_storm(&sid, "tool_a", &input));
        assert!(!check_tool_call_storm(&sid, "tool_a", &input));
        assert!(check_tool_call_storm(&sid, "tool_a", &input));
    }

    #[test]
    fn different_args_not_storm() {
        let sid = fresh_session();
        assert!(!check_tool_call_storm(&sid, "tool_a", &serde_json::json!({ "a": 1 })));
        assert!(!check_tool_call_storm(&sid, "tool_a", &serde_json::json!({ "a": 2 })));
        assert!(!check_tool_call_storm(&sid, "tool_a", &serde_json::json!({ "a": 3 })));
    }

    #[test]
    fn per_session_isolation() {
        let sid = fresh_session();
        let sid2 = fresh_session();
        let input = serde_json::json!({ "a": 1 });
        check_tool_call_storm(&sid, "tool_a", &input);
        check_tool_call_storm(&sid, "tool_a", &input);
        assert!(check_tool_call_storm(&sid, "tool_a", &input));
        // 另一个 session 不受影响
        assert!(!check_tool_call_storm(&sid2, "tool_a", &input));
    }

    #[test]
    fn window_slides_after_clear() {
        let sid = fresh_session();
        let input = serde_json::json!({ "a": 1 });
        for _ in 0..6 {
            check_tool_call_storm(&sid, "tool_a", &input);
        }
        clear_tool_call_history(&sid);
        assert!(!check_tool_call_storm(&sid, "tool_a", &input));
    }
}
