//! GUI 宿主实现 — `HostEnv` 的 **Tauri** 版本
//!
//! trait 本体（`HostEnv`）与 CLI 实现（`CliHost`）在 `virlen-core::host`；
//! 这里是**唯一允许出现 `tauri::` 的宿主实现**（GUI 的 `resource_dir()` / `app_data_dir()`）。
//! 两者都只回答「资源目录怎么找」「数据目录在哪」，不含任何业务逻辑。

pub mod tauri_host;

pub use tauri_host::TauriHost;
