//! quasivision 视觉服务的 Tauri 命令壳。
//!
//! 实现（模型目录定位 / 懒加载 / 推理）在 `virlen_core::vision`（不含 `tauri::`），
//! 故与原生工具 `native_tools/vision/vision_analyze.rs` 共用同一段实现。
//! 本文件只把入参（文件路径 / base64 data URL）翻译成字节，再把结果回传。

use crate::host::TauriHost;
use virlen_core::vision::{self, VisionAnalyzeResult};
use tauri::AppHandle;

/// 从文件路径读取图片分析
#[tauri::command]
pub async fn vision_analyze(
    app: AppHandle,
    image_path: String,
) -> Result<VisionAnalyzeResult, String> {
    let host = TauriHost::new(app);
    vision::analyze_path(&host, &image_path)
}

/// 从 base64 data URL 分析（粘贴/拖拽截图无需落盘）
#[tauri::command]
pub async fn vision_analyze_base64(
    app: AppHandle,
    data_url: String,
) -> Result<VisionAnalyzeResult, String> {
    // 提取 base64 部分：去掉 "data:image/...;base64," 前缀
    let b64 = data_url
        .split(',')
        .nth(1)
        .ok_or_else(|| "Invalid data URL: missing comma separator".to_string())?;

    use base64::Engine as _;
    let img_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let host = TauriHost::new(app);
    vision::analyze(&host, &img_bytes, false)
}
