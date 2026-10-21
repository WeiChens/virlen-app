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
use virlen_core::vision::{self, OcrCachedText, VisionAnalyzeResult};
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
        let img_bytes = decode_data_url(&data_url)?;
        let host = TauriHost::new(app);
        vision::analyze(&host, &img_bytes, false)
    })
    .await
}

/// 只做 OCR（图片预览用）：返回识别出的文本（没有文字 = 空串）。
///
/// 与 `vision_analyze` 的区别只有一件事：**只跑 OCR**。UI 组件检测 / 图标识别 / 物体检测
/// 都不做 —— 预览要的是「图上的字」，那三步既不必要又慢，还会把整棵组件树塞进结果。
/// 结果按内容指纹落盘缓存（`image-ocr-cache.json`），同一张图第二次打开不再推理；
/// `force = true` 是界面的「重新识别」，绕过缓存重算（空结果不写缓存，见 `vision` 模块头）。
#[tauri::command]
pub async fn vision_ocr(
    app: AppHandle,
    image_path: String,
    force: Option<bool>,
) -> Result<OcrCachedText, String> {
    blocking(move || {
        let host = TauriHost::new(app);
        vision::ocr_path_cached(&host, &image_path, force.unwrap_or(false))
    })
    .await
}

/// 只做 OCR 的 base64 版（消息里的图 / 剪贴板图没有本地路径）
#[tauri::command]
pub async fn vision_ocr_base64(
    app: AppHandle,
    data_url: String,
    force: Option<bool>,
) -> Result<OcrCachedText, String> {
    blocking(move || {
        let img_bytes = decode_data_url(&data_url)?;
        let host = TauriHost::new(app);
        vision::ocr_image_cached(&host, &img_bytes, force.unwrap_or(false))
    })
    .await
}

/// 提取 base64 部分并解码：去掉 `data:image/...;base64,` 前缀
fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let b64 = data_url
        .split(',')
        .nth(1)
        .ok_or_else(|| "Invalid data URL: missing comma separator".to_string())?;

    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Failed to decode base64: {}", e))
}
