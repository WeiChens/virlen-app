//! 宿主实现 — [`HostEnv`] 的 **CLI / 无 GUI** 版本
//!
//! 与 `virlen-app` 的 `TauriHost` 只差「资源目录怎么找」「数据目录在哪」，不含任何业务逻辑。
//! 两者都在构造期显式注入（`Arc<dyn HostEnv>`），没有隐式全局依赖。
//!
//! ⚠️ 本模块（`virlen-core`）不得出现 `tauri::` —— GUI 的 `TauriHost` 住在
//! `virlen-app/src/host/tauri_host.rs`。

pub mod cli_host;

pub use cli_host::CliHost;

/// 供 core 内部使用的宿主 trait 重导出（定义在 `agent::host`，因为引擎是主要消费方）
pub use crate::agent::host::{compile_time_resource_root, HostEnv};

use once_cell::sync::Lazy;
use std::sync::Arc;

/// 进程级默认宿主（CLI 语义）。
///
/// ⚠️ 只给「没有注入点」的边缘路径用：如 GUI 侧的 `pty_run_command`，它不经过 `AgentEngine`，
/// 拿不到构造期注入的宿主。生产主路径（Agent 引擎 → `NativeToolCtx.host`）一律走显式注入，
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
