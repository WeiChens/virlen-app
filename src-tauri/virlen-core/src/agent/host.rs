//! 宿主环境抽象 — 引擎核心与「宿主」之间的**唯一**接口
//!
//! ## 为什么需要它
//!
//! 引擎核心（`agent/**`）必须保持**零 `tauri::` 依赖**（这是 headless / CLI 的前提）。
//! 但有两类信息引擎自己拿不到、只有宿主知道：
//!
//! 1. **只读资源在哪** —— 如 `quasivision_models`，打包后随安装目录走；
//! 2. **可写数据根在哪** —— 会话库 `virlen.db`、日志、后续的配置下沉。
//!
//! 于是把这两件事收敛成一个极小 trait，由宿主在**构造期注入**（`Arc<dyn HostEnv>`），
//! 与 `NativeToolCtx` 上的 `security` / `repo` / `skills` 是同一种显式注入风格。
//!
//! ## 约定（防止抽象面积蔓延）
//!
//! **只往里加「引擎自己拿不到的信息」。** 通知 / 托盘 / 窗口 / 剪贴板等纯 GUI 能力
//! 不进这里 —— 引擎不需要知道它们的存在；能由配置表达的东西也不进这里。
//!
//! ## 实现
//!
//! - GUI：`crate::host::TauriHost`（`app.path().resource_dir()` / `app_data_dir()`）
//! - CLI / 单测：`crate::host::CliHost`（环境变量 + 可执行文件位置）
//!
//! ⚠️ 本文件（以及 `crate::host` 之外的调用方）不得引入 `tauri::`。
//! 设计草案见 `docs/host-abstraction-draft.md`。

use std::path::PathBuf;

/// 宿主提供的最小环境能力。
pub trait HostEnv: Send + Sync {
    /// 只读资源的**候选根目录**（按优先级，由调用方逐个探测存在性）。
    ///
    /// 返回候选而非唯一答案：资源探测本来就是「多候选 + 看谁存在」，
    /// 把存在性判断留给调用方能**逐字保留**既有的错误文案（含 `Searched:` 列表）。
    ///
    /// - GUI：`[<src-tauri>/resources, <resource_dir>, <resource_dir>/resources]`
    /// - CLI：`[<src-tauri>/resources, $VIRLEN_RESOURCE_DIR, <exe_dir>/resources, <exe_dir>]`
    ///
    /// ⚠️ 两侧都以**编译期资源根**打头，是为了让开发期 / `cargo test` 与现状完全一致
    /// （现状 `resolve_models_dir` 就先探测编译期资源根，见 [`compile_time_resource_root`]）。
    fn resource_candidates(&self) -> Vec<PathBuf>;

    /// 可写数据根（会话库 `virlen.db` / 日志 / 后续的配置）。
    ///
    /// ⚠️ GUI 与 CLI **必须指向同一目录** —— 否则 CLI 读写的是另一个空库，
    /// 「同一份配置 / 同一份会话」这件事就不成立。
    ///
    /// - GUI：Tauri `app.path().app_data_dir()`（= `dirs::data_dir()/<bundle identifier>`）
    /// - CLI：`$VIRLEN_DATA_DIR` → `%APPDATA%/<identifier>`（Win）/
    ///   `~/Library/Application Support/<identifier>`（macOS）/
    ///   `$XDG_DATA_HOME/<identifier>`（Linux）
    ///
    /// ⚠️ 消费方是 `session_db::open_session_db`（库路径 = `data_dir()/virlen.db`）：
    /// GUI 与 CLI 指向同一目录，即共用同一份 `virlen.db`（同一份会话 + 同一份配置）。
    fn data_dir(&self) -> PathBuf;
}

/// 编译期资源根（`src-tauri/resources/`）—— 开发 / `cargo test` 下的第一候选。
///
/// 与 Tauri 无关：它来自 `CARGO_MANIFEST_DIR`，是**编译期常量**。
/// 分发包里该目录通常不存在，探测会自然跳过（保持现状行为）。
///
/// ⚠️ **为什么要 `..`**：本 crate 位于 `src-tauri/virlen-core`，而资源目录
/// （`quasivision_models/` 等）属于 **GUI package**（`src-tauri/resources`）。
/// 拆包前二者同目录，现在必须往上一级找 —— 否则 GUI 的模型探测会静默落到
/// 一个**不存在**的 `virlen-core/resources`，开发期直接找不到模型。
/// 这与「GUI / CLI 在开发期共用同一份源码资源」的既有约定一致。
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
