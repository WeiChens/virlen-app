//! quasivision 视觉服务的 Tauri 命令壳。
//!
//! 实现（模型目录定位 / 懒加载 / 推理）在 `virlen_core::vision`（不含 `tauri::`），
//! 故与原生工具 `native_tools/vision/vision_analyze.rs` 共用同一段实现。
//! 本文件只把入参（文件路径 / base64 data URL）翻译成字节，再把结果回传。
//!
//! ⚠️ 推理是 CPU 密集的同步调用，必须走 [`blocking`] 挪出异步运行时：直接写在 `async fn` 里会占住
//! tokio worker，期间所有任务排在同一线程后面 —— 连「停止」按钮要发的 `agent_cancel` 都得等，
//! 观感就是「点了没反应」（与 §11.51 同源）。

use crate::host::TauriHost;
use virlen_core::vision::{self, VisionAnalyzeResult};
use tauri::AppHandle;

/// 把同步推理挪到阻塞线程池，并统一 join 错误文案
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// 从文件路径读取图片分析
#[tauri::command]
pub async fn vision_analyze(
    app: AppHandle,
    image_path: String,
) -> Result<VisionAnalyzeResult, String> {
    blocking(move || {
        let host = TauriHost::new(app);
        vision::analyze_path(&host, &image_path)
    })
    .await
}

/// 从 base64 data URL 分析（粘贴/拖拽截图无需落盘）
#[tauri::command]
pub async fn vision_analyze_base64(
    app: AppHandle,
    data_url: String,
) -> Result<VisionAnalyzeResult, String> {
    blocking(move || {
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
    })
    .await
}
