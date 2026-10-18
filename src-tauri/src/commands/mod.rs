//! 全部 Tauri 命令（GUI 壳）：只做参数兜底 + 转交，业务语义全在 `virlen-core`。
//! 集中于此是因为 core 不得出现 `tauri::`；按域分文件，与 core 模块名一一对应。
//! ⚠️ 新增命令后必须登记到 `lib.rs` 的 `generate_handler![...]`（铁律 4）。

pub mod agent;
pub mod document;
pub mod git;
pub mod memory;
pub mod phone_audit;
pub mod phone_device;
pub mod phone_pairing;
pub mod preview;
pub mod rag;
pub mod service;
pub mod session_db;
