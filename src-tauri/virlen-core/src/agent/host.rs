//! 宿主环境抽象 — 引擎核心与「宿主」之间的唯一接口。
//!
//! 引擎核心（`agent/**`）须零 `tauri::`，但「只读资源在哪」「可写数据根在哪」只有宿主知道 —— 收敛成
//! 这个极小 trait，由宿主构造期注入（`Arc<dyn HostEnv>`）。
//!
//! 约定：只加「引擎自己拿不到的信息」；纯 GUI 能力（通知 / 托盘 / 窗口 / 剪贴板）与能由配置表达的
//! 东西不进这里。GUI 实现 `TauriHost`，CLI / 单测用 `CliHost`。⚠️ 本文件不得引入 `tauri::`。

use std::path::PathBuf;

/// 宿主提供的最小环境能力。
pub trait HostEnv: Send + Sync {
    /// 只读资源的候选根目录（按优先级，由调用方逐个探测存在性）—— 返回候选而非唯一答案，
    /// 好让调用方逐字保留既有错误文案（含 `Searched:` 列表）。两侧都以编译期资源根打头。
    /// - GUI：`[<src-tauri>/resources, <resource_dir>, <resource_dir>/resources]`
    /// - CLI：`[<src-tauri>/resources, $VIRLEN_RESOURCE_DIR, <exe_dir>/resources, <exe_dir>]`
    fn resource_candidates(&self) -> Vec<PathBuf>;

    /// 可写数据根（会话库 `virlen.db` / 日志 / 配置）。
    ///
    /// ⚠️ GUI 与 CLI 必须指向同一目录 —— 否则 CLI 读写的是另一个空库，「同一份配置 / 同一份会话」就不
    /// 成立。消费方是 `session_db::open_session_db`（库路径 = `data_dir()/virlen.db`）：
    /// GUI 用 Tauri `app.path().app_data_dir()`（= `dirs::data_dir()/<identifier>`）；CLI 用
    /// `$VIRLEN_DATA_DIR` → `%APPDATA%/<identifier>`（Win）/ `~/Library/Application Support/<identifier>`
    /// （macOS）/ `$XDG_DATA_HOME/<identifier>`（Linux）。
    fn data_dir(&self) -> PathBuf;
}

/// 编译期资源根（`src-tauri/resources/`）—— 开发 / `cargo test` 下的第一候选。
///
/// 与 Tauri 无关：来自 `CARGO_MANIFEST_DIR`，是编译期常量。分发包里该目录通常不存在，
/// 探测会自然跳过。
///
/// 为什么要 `..`：本 crate 位于 `src-tauri/virlen-core`，而资源目录（`quasivision_models/`
/// 等）属于 GUI package（`src-tauri/resources`）。拆包前二者同目录，现在必须往上一级找，
/// 否则 GUI 的模型探测会静默落到不存在的 `virlen-core/resources`，开发期找不到模型。
pub fn compile_time_resource_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("resources")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 编译期资源根必须真的指向 `src-tauri/resources`（否则 GUI 的模型探测顺序会静默改变）。
    #[test]
    fn compile_time_root_points_at_src_tauri_resources() {
        let root = compile_time_resource_root();
        assert!(root.ends_with("resources"), "root: {}", root.display());
        assert!(
            root.parent().map(|p| p.join("tauri.conf.json").exists()).unwrap_or(false),
            "编译期资源根应位于 src-tauri/ 下: {}",
            root.display()
        );
    }
}
