//! 启动引导（**配置下沉 D3 / #E-S4**）：会话库的打开路径必须**只依赖 `HostEnv`**。
//!
//! 验收点：GUI 与 CLI 只要 `HostEnv::data_dir()` 相同，读写的就是同一份 `virlen.db`
//! —— 同一份会话 + 同一份配置（不再依赖 `tauri::AppHandle`）。

use crate::host::CliHost;
use crate::session_db::commands::open_session_db;
use serde_json::{json, Map, Value};

/// 临时数据根（模拟 `%APPDATA%/JianWeichen.virlen`）
fn tmp_data_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("virlen_bootstrap_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 库文件落在 `host.data_dir()` 下（路径不再由 `tauri::AppHandle` 决定）。
#[test]
fn db_path_comes_from_host_data_dir() {
    let dir = tmp_data_dir();
    let host = CliHost::new(vec![], dir.clone());
    // 后台任务（迁移 / 孤儿回收）在这里**不派发** → 用例确定、且不依赖 tokio 运行时
    let db = open_session_db(&host, &|_fut| {}).unwrap();

    assert!(dir.join("virlen.db").exists(), "库应落在 host.data_dir() 下");
    assert!(db.repo.is_available(), "SessionRepo 应为真实后端");
    assert!(db.settings.is_available(), "SettingsRepo 应为真实后端");

    std::fs::remove_dir_all(&dir).ok();
}

/// GUI 与 CLI 指向同一目录 → **同一份配置**（D3 的核心验收）
#[tokio::test]
async fn two_hosts_on_same_dir_share_one_config() {
    let dir = tmp_data_dir();

    let gui = CliHost::new(vec![], dir.clone());
    let a = open_session_db(&gui, &|_fut| {}).unwrap();
    let mut entries = Map::new();
    entries.insert("language".into(), Value::String("zh-CN".into()));
    a.settings.upsert(entries).await.unwrap();

    // 「另一个进程」（CLI）指向同一目录 → 读到 GUI 写的值
    let cli = CliHost::new(vec![], dir.clone());
    let b = open_session_db(&cli, &|_fut| {}).unwrap();
    assert_eq!(b.settings.get_all().await.unwrap()["language"], json!("zh-CN"));

    std::fs::remove_dir_all(&dir).ok();
}
