//! 宿主实现 — `agent::host::HostEnv` 的 GUI / CLI 两份实现
//!
//! 这里是**唯一允许出现 `tauri::` 的宿主相关位置**；`agent/**` 保持零依赖。
//! 两处实现的差异只有「资源目录怎么找」「数据目录在哪」，不含任何业务逻辑。
//!
//! - [`TauriHost`]：GUI（Tauri `resource_dir()` / `app_data_dir()`）
//! - [`CliHost`]：headless / CLI / 单测（环境变量 + 可执行文件位置）

pub mod cli_host;
pub mod tauri_host;

pub use cli_host::CliHost;
pub use tauri_host::TauriHost;

use crate::agent::host::HostEnv;
use once_cell::sync::Lazy;
use std::sync::Arc;

/// 进程级默认宿主（CLI 语义）。
///
/// ⚠️ **只给「没有注入点」的边缘路径用**：如 TS 引擎的 `pty_run_command`，
/// 它不经过 `AgentEngine`，拿不到构造期注入的宿主。
/// 生产主路径（Agent 引擎 → `NativeToolCtx.host`）一律走显式注入，
/// 不用全局单例 —— 否则 CLI / GUI 的初始化顺序会变成隐式依赖，单测也无法并行。
pub fn default_host() -> &'static Arc<dyn HostEnv> {
    static HOST: Lazy<Arc<dyn HostEnv>> = Lazy::new(|| Arc::new(CliHost::from_env()));
    &HOST
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认宿主必须可重复取得（进程级单例），且 data_dir 非空。
    #[test]
    fn default_host_is_stable_and_usable() {
        let a = default_host();
        let b = default_host();
        assert!(std::sync::Arc::ptr_eq(a, b), "默认宿主应为进程级单例");
        assert!(!a.data_dir().as_os_str().is_empty());
        assert!(!a.resource_candidates().is_empty());
    }
}
