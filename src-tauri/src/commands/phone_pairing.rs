//! 手机控制 —— 配对表持久化（M3-5）
//!
//! 只做「读 / 写一个 JSON 文件」；业务语义（票据 / 已绑定设备）全在 TS 侧
//! （`virlen-app/src/bridge/pairing.ts`）。存 `<data_dir>/phone-pairing.json`。
//!
//! 写入用**临时文件 + 原子 rename**：避免进程中途退出留下半截 JSON 导致手机全部掉线。
//!
//! ⚠️ M3 不做 OS 强安全存储（Keychain / DPAPI）；M4 再评估。

use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use virlen_core::host::HostEnv;

fn data_dir(app: &AppHandle) -> PathBuf {
    crate::host::TauriHost::new(app.clone()).data_dir()
}

fn file_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("phone-pairing.json")
}

/// 读取配对表 JSON；文件不存在时返回空串（前端据此视为「无配对记录」）。
#[tauri::command]
pub fn cmd_phone_pairing_load(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(file_path(&app)) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取配对表失败: {}", e)),
    }
}

/// 写入配对表 JSON（原子写：临时文件 + rename）。
#[tauri::command]
pub fn cmd_phone_pairing_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = file_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换失败: {}", e))?;
    Ok(())
}
