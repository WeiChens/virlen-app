//! 手机控制 —— 电脑设备身份持久化（M6，见 docs/phone-control-bridge.md §30.1）
//!
//! 只做「读 / 写一个 JSON 文件」；**key 的生成在 TS 侧**（`virlen-remote` 的 `newDeviceKey`，
//! 与手机端用的是同一份实现 —— 生成规则写两份必然分叉）。存 `<data_dir>/phone-identity.json`。
//!
//! 这个文件就是「重新获取还是同一个」的落点：手机端记的是这里产出的 `deviceKey`，
//! 房间号也由它派生。文件丢失 = 电脑端换了身份（已配对的手机需要重新扫码）。
//!
//! 写入用**临时文件 + 原子 rename**：避免进程中途退出留下半截 JSON 导致身份变化。

use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use virlen_core::host::HostEnv;

fn data_dir(app: &AppHandle) -> PathBuf {
    crate::host::TauriHost::new(app.clone()).data_dir()
}

fn file_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("phone-identity.json")
}

/// 读取设备身份 JSON；文件不存在时返回空串（前端据此视为「首次运行」并生成新 key）。
#[tauri::command]
pub fn cmd_phone_identity_load(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(file_path(&app)) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取设备身份失败: {}", e)),
    }
}

/// 写入设备身份 JSON（原子写：临时文件 + rename）。
#[tauri::command]
pub fn cmd_phone_identity_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = file_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换失败: {}", e))?;
    Ok(())
}
