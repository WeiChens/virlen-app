//! quasivision 视觉服务的 **Tauri 命令壳**
//!
//! 真正的实现（模型目录定位 / 进程级懒加载 / 推理 pipeline）在 `crate::vision` ——
//! 那里**不含 `tauri::`**，因此 GUI 命令壳与原生工具
//! （`native_tools/vision/vision_analyze.rs`）共用同一段实现，不会出现两份模型探测逻辑。
//!
//! 本文件只负责两件事：
//!   1. 把 IPC 入参（文件路径 / base64 data URL）翻译成字节；
//!   2. 把 `crate::vision` 的结果原样回传。
//!
//! 命令：
//!   - `vision_analyze`        → 从文件路径读取图片分析
//!   - `vision_analyze_base64` → 从 base64 data URL 分析（粘贴/拖拽截图无需落盘）

use crate::host::TauriHost;
use crate::vision::{self, VisionAnalyzeResult};
use tauri::AppHandle;

// ═══════════════════════════════════════════════════════════════════════════
// 命令 1：从文件路径读取图片分析
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn vision_analyze(
    app: AppHandle,
    image_path: String,
) -> Result<VisionAnalyzeResult, String> {
    let host = TauriHost::new(app);
    vision::analyze_path(&host, &image_path)
}

// ═══════════════════════════════════════════════════════════════════════════
// 命令 2：从 base64 data URL 分析（粘贴/拖拽截图无需落盘）
// ═══════════════════════════════════════════════════════════════════════════

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
