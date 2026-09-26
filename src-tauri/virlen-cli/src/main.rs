//! `virlen-cli` 入口（headless / CLI 形态）
//!
//! 这里不能加 `windows_subsystem = "windows"`（与 `virlen-app/src/main.rs` 相反）：CLI 需要
//! stdout / stderr。本文件只做转发 —— 实现全在本 crate 的 lib 里，因为 bin 目标无法被单测引用。
//!
//! 本 package 只依赖 `virlen-core`：这个二进制里没有 tauri / wry / tao / tray-icon / webview2-com，从
//! 源码到产物都脱离了 GUI 栈。`flavor = "current_thread"`：本 crate 的 tokio 只开了 `rt`，CLI 是「读一
//! 次写一次就退出」的短生命周期，单线程运行时足够。
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    let code = virlen_cli::run(&args, &mut out, &mut err).await;
    std::process::exit(code);
}
