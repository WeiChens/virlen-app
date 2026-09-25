//! GUI 宿主实现（Tauri）—— `agent::host::HostEnv` 的图形界面版本
//!
//! 只做两件事：把 Tauri 的 `resource_dir()` / `app_data_dir()` 翻译成 [`HostEnv`]
//! 需要的形状。**不含任何业务逻辑**（模型探测的存在性判断在 `virlen_core::vision`）。

use virlen_core::agent::host::{compile_time_resource_root, HostEnv};
use std::path::PathBuf;
use tauri::Manager;

pub struct TauriHost {
    app: tauri::AppHandle,
}

impl TauriHost {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl HostEnv for TauriHost {
    fn resource_candidates(&self) -> Vec<PathBuf> {
        // 顺序必须与重构前的 `vision_service::resolve_models_dir` 完全一致：
        //   1. 编译期资源根（开发 / cargo test）
        //   2. resource_dir()/quasivision_models
        //   3. resource_dir()/resources/quasivision_models
        let mut out = vec![compile_time_resource_root()];
        if let Ok(res) = self.app.path().resource_dir() {
            out.push(res.clone());
            out.push(res.join("resources"));
        }
        // ⚠️ Tauri 的 resource_dir() 在 Windows 上可能返回带 `\\?\` 前缀的 verbatim
        // 路径（quasivision 内部按字符串拼 "subdir/file"，verbatim 下 "/" 不算分隔符）。
        // 剥前缀由调用方（`vision::models_dir`）统一处理，避免每份实现各写一遍。
        out
    }

    fn data_dir(&self) -> PathBuf {
        // 与重构前 `session_db::init_session_db` 的行为一致：取不到则回退当前目录
        // （库仍可用，只是落在 cwd 下），不 panic。
        self.app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}
