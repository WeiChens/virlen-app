//! `virlen-cli` 入口（headless）。不加 `windows_subsystem = "windows"`（CLI 需要 stdout / stderr），
//! 只做转发（实现全在 lib 里，因 bin 目标无法被单测引用）。
//!
//! 本 package 只依赖 `virlen-core`，二进制里没有 tauri / wry / tao 等，完全脱离 GUI 栈。
//! `flavor = "current_thread"`：tokio 只开 `rt`，CLI 短生命周期，单线程足够。
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    let code = virlen_cli::run(&args, &mut out, &mut err).await;
    std::process::exit(code);
}
