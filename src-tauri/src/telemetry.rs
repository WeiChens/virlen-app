//! GUI 侧埋点出口（Tauri）—— 实现全在 `virlen-core::telemetry`
//!
//! 本模块只做两件事：① 把 Tauri emit 注册成 core 的 `TelemetrySink`（core 内约百处 `track()` 调用点因此
//! 完全不用改）；② 提供前端就绪后主动拉取 panic 的命令（Tauri 事件不缓冲，setup 阶段 emit 会丢）。
//!
//! 这里同时重导出 core 的埋点工具函数，让 GUI 内部沿用既有的 `crate::telemetry::track(...)` 写法。

use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub use virlen_core::telemetry::{drain_panics, hash_id, now_ms, on_exit, track, TelemetrySink};

/// Tauri 埋点出口：`agent:telemetry` 事件
///
/// 载荷与重构前逐字一致（`event_name` / `props` / `event_time`），
/// 由前端 `src/utils/telemetry` 补齐公共字段、打码、写入本地缓冲。
struct TauriTelemetrySink {
    app: AppHandle,
}

impl TelemetrySink for TauriTelemetrySink {
    fn emit(&self, event_name: &str, props: Value) {
        let payload = serde_json::json!({
            "event_name": event_name,
            "props": props,
            "event_time": now_ms(),
        });
        let _ = self.app.emit("agent:telemetry", payload);
    }
}

/// 初始化：登记埋点出口 + panic 落盘路径 + 安装 panic hook。
/// 在 `run()` 的 setup 早期调用。
pub fn init(app: &AppHandle) {
    virlen_core::telemetry::set_sink(Arc::new(TauriTelemetrySink { app: app.clone() }));
    if let Ok(dir) = app.path().app_data_dir() {
        virlen_core::telemetry::init_panic_log(&dir);
    }
    virlen_core::telemetry::install_panic_hook();
}

/// 读取并清空历史 panic 落盘，返回各条 props 列表。
///
/// 由前端在「`agent:telemetry` 监听注册完成且埋点开启」后调用。
#[tauri::command]
pub fn telemetry_drain_panics() -> Vec<Value> {
    drain_panics()
}
