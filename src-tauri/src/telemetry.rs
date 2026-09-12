//! Rust 侧埋点出口（§5.13 / §12.13）
//!
//! 复用现有 Tauri 事件桥：Rust 侧事件经 `agent:telemetry` 事件回传前端，
//! 由前端 `src/utils/telemetry` 统一补齐公共字段、打码、写入本地缓冲
//! （前端 `track()` 在开关关闭时 no-op，因此 Rust 侧无需感知开关）。
//!
//! 约定：
//! - event_name / props 与 docs/埋点上报数据设计.md §5.13 / §12.13 对齐；
//!   props 只是「事件私有字段」，公共字段由前端补齐。
//! - `session_id` 一律使用 `hash_id`（与前端 `hashText` 完全一致，SHA 前 16 位语义），
//!   保证与前端事件可关联且不泄漏原始 ID。
//! - panic 经 panic hook：实时回传 + 落盘（app_data_dir/telemetry_panics.log）；
//!   崩溃后下次启动由前端调用 `telemetry_drain_panics` 拉取回放（Rust setup 阶段
//!   emit 会早于前端监听注册而丢失，故不在此处回放）；正常退出时清理落盘文件。
//! - 未初始化 / 发送失败一律静默，绝不 panic。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// 全局 AppHandle（启动时登记一次）
static APP: OnceLock<AppHandle> = OnceLock::new();
/// panic 落盘文件路径（启动时登记一次）
static PANIC_LOG: OnceLock<PathBuf> = OnceLock::new();

/// 初始化：登记 AppHandle + panic 落盘路径 + 安装 panic hook + 回放历史 panic。
/// 在 `run()` 的 setup 早期调用。
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = PANIC_LOG.set(dir.join("telemetry_panics.log"));
    }
    install_panic_hook();
}

/// 应用正常退出：清理 panic 落盘文件（本会话 panic 已实时回传进本地缓冲）。
pub fn on_exit() {
    if let Some(path) = PANIC_LOG.get() {
        let _ = std::fs::remove_file(path);
    }
}

/// 上报一条 Rust 侧事件（非阻塞；未初始化/失败静默）。
pub fn track(event_name: &str, props: Value) {
    if let Some(app) = APP.get() {
        emit_event(app, event_name, props);
    }
}

/// 稳定短哈希（FNV-1a 双轮 → 16 位十六进制），与前端 `hashText` 逐位一致。
pub fn hash_id(input: &str) -> String {
    let mut h1: u32 = 0x811c_9dc5;
    let mut h2: u32 = 0x0100_0193;
    for c in input.encode_utf16() {
        let c = c as u32;
        h1 = (h1 ^ c).wrapping_mul(16_777_619);
        h2 = h2.wrapping_add(c).wrapping_mul(2_246_822_519);
    }
    format!("{:08x}{:08x}", h1, h2)
}

/// 当前时间（毫秒）
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ==================== 会话级链路上下文 ====================
// 与前端 `utils/telemetry` 的 sessionTraces 对齐：chat-service 在发送时生成 trace_id
// 并经 options.trace_id 传入，引擎登记后工具执行（含 Rust 侧 tool_executor）读取，
// 避免 trace_id 在多层调用间逐层透传。

static SESSION_TRACES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn session_traces() -> &'static Mutex<HashMap<String, String>> {
    SESSION_TRACES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 登记会话当前链路 ID（空串忽略）
pub fn set_session_trace(session_id: &str, trace_id: &str) {
    if session_id.is_empty() || trace_id.is_empty() {
        return;
    }
    if let Ok(mut m) = session_traces().lock() {
        m.insert(session_id.to_string(), trace_id.to_string());
    }
}

/// 读取会话当前链路 ID
pub fn get_session_trace(session_id: &str) -> Option<String> {
    session_traces()
        .lock()
        .ok()
        .and_then(|m| m.get(session_id).cloned())
}

/// 清除会话链路 ID
pub fn clear_session_trace(session_id: &str) {
    if let Ok(mut m) = session_traces().lock() {
        m.remove(session_id);
    }
}

// ==================== 内部实现 ====================

fn emit_event(app: &AppHandle, event_name: &str, props: Value) {
    let payload = json!({
        "event_name": event_name,
        "props": props,
        "event_time": now_ms(),
    });
    let _ = app.emit("agent:telemetry", payload);
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 保留默认 stderr 输出，避免影响现有排障习惯
        default_hook(info);
        // 钩子内部任何异常都不得再 panic（否则 double panic → abort）
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "panic".to_string()
            };
            let location = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_default();
            let backtrace = std::backtrace::Backtrace::force_capture().to_string();
            let props = json!({
                "message": message,
                "location": location,
                "backtrace": backtrace,
            });
            // 实时回传（进入前端本地缓冲）
            if let Some(app) = APP.get() {
                emit_event(app, "rust.panic", props.clone());
            }
            // 落盘兜底（崩溃场景下次启动回放）
            append_panic_log(&props);
        }));
    }));
}

fn append_panic_log(props: &Value) {
    let Some(path) = PANIC_LOG.get() else { return };
    let line = serde_json::to_string(props).unwrap_or_else(|_| "{}".to_string());
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{}", line);
    }
}

fn drain_panics() -> Vec<Value> {
    let Some(path) = PANIC_LOG.get() else {
        return Vec::new();
    };
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let _ = std::fs::remove_file(path);
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(line).ok()
            }
        })
        .collect()
}

/// 读取并清空历史 panic 落盘，返回各条 props 列表。
///
/// 由前端在「`agent:telemetry` 监听注册完成且埋点开启」后调用：Rust `setup` 阶段
/// emit 的事件会早于前端监听注册而丢失（Tauri 事件不缓冲），故改由前端就绪后主动拉取。
#[tauri::command]
pub fn telemetry_drain_panics() -> Vec<Value> {
    drain_panics()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_trace_set_get_clear() {
        let sid = "s_test_trace_registry";
        assert_eq!(get_session_trace(sid), None);
        set_session_trace(sid, "t-abc123");
        assert_eq!(get_session_trace(sid).as_deref(), Some("t-abc123"));
        // 空 trace 忽略，不覆盖已有值
        set_session_trace(sid, "");
        assert_eq!(get_session_trace(sid).as_deref(), Some("t-abc123"));
        // 空 session_id 忽略
        set_session_trace("", "t-x");
        assert_eq!(get_session_trace(""), None);
        clear_session_trace(sid);
        assert_eq!(get_session_trace(sid), None);
    }

    #[test]
    fn hash_id_is_16_hex() {
        // 与前端 hashText 同为 16 位十六进制（FNV-1a 双轮）
        let h = hash_id("session-x");
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(h, hash_id("session-x"));
    }
}
