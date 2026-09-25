//! `virlen-cli` 入口（headless / CLI 形态）
//!
//! ⚠️ 这里**不能**加 `windows_subsystem = "windows"`（与 `src/main.rs` 相反）：
//! CLI 需要 stdout / stderr。
//!
//! 本文件只做转发 —— 实现全在 lib 的 `cli` 模块里（`ai_agent_app_lib::cli`），
//! 因为 **bin 目标无法被单测引用**，逻辑留在 lib 才测得到。
//!
//! `flavor = "current_thread"`：本 crate 的 tokio 只开了 `rt`（无 `rt-multi-thread`），
//! CLI 是「读一次写一次就退出」的短生命周期，单线程运行时足够。
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    let code = ai_agent_app_lib::cli::run(&args, &mut out, &mut err).await;
    std::process::exit(code);
}
