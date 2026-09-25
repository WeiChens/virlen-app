//! `virlen-cli` 入口（headless / CLI 形态）
//!
//! ⚠️ 这里**不能**加 `windows_subsystem = "windows"`（与 `virlen-app/src/main.rs` 相反）：
//! CLI 需要 stdout / stderr。
//!
//! 本文件只做转发 —— 实现全在 `virlen_core::cli` 里，因为 **bin 目标无法被单测引用**，
//! 逻辑留在 lib 才测得到。
//!
//! 本 package **只依赖 `virlen-core`**（不依赖 `virlen-app`）：因此这个二进制里没有
//! tauri / wry / tao / tray-icon / webview2-com —— 从源码到产物都脱离了 GUI 栈。
//!
//! `flavor = "current_thread"`：本 crate 的 tokio 只开了 `rt`（无 `rt-multi-thread`），
//! CLI 是「读一次写一次就退出」的短生命周期，单线程运行时足够。
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    let code = virlen_core::cli::run(&args, &mut out, &mut err).await;
    std::process::exit(code);
}
