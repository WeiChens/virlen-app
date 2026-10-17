//! 文档解析（`parse_document` 工具）的命令层：只做参数兜底 + 转交，解析在 `virlen_core::doc_parse`，
//! 版式与失败语义与原生工具同一条组装链（`parse_targets`）。
//! ⚠️ 路径安全由**前端**先做（`securityService.resolveSafePath`）；Rust 原生工具路径自己走 `resolve_safe_path`。
//! ⚠️ 新增命令必须登记到 `lib.rs` 的 `generate_handler![...]`，否则 `invoke` 静默 404。

use crate::host::TauriHost;
use tauri::AppHandle;
use virlen_core::agent::native_tools::{
    default_max_chars, ocr_options, parse_targets, ParseTarget,
};
use virlen_core::doc_parse::ParseOptions;

/// 解析结果：模型侧英文文本 + 界面结构化数据 + 是否全部失败。
/// `ok == false` 要当**失败**抛出（与原生工具 `NativeToolError` 同语义）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocumentResult {
    pub content: String,
    pub ui_data: serde_json::Value,
    pub ok: bool,
}

/// 解析一份或多份文档（TS 回退路径 / 浏览器 dev；默认引擎走原生工具）。
/// 参数即前端 `invoke` 的载荷字段，合结构体会同时改前端调用形状。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cmd_parse_document(
    app: AppHandle,
    path: Option<String>,
    paths: Option<Vec<String>>,
    sheet: Option<String>,
    max_chars: Option<usize>,
    offset: Option<usize>,
    out_txt_file: Option<String>,
    ocr_images: Option<bool>,
) -> Result<ParsedDocumentResult, String> {
    // 与原生工具同口径：`paths` 优先，空串条目丢掉
    let mut inputs: Vec<String> = paths
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .collect();
    let out_txt_file = out_txt_file.filter(|p| !p.trim().is_empty());
    if inputs.is_empty() {
        if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
            inputs.push(p);
        }
    }
    if inputs.is_empty() {
        return Err("Missing required parameter: \"path\" or \"paths\"".to_string());
    }

    let opts = ParseOptions {
        sheet: sheet.filter(|s| !s.trim().is_empty()),
        // 默认预览长度与原生工具同一份逻辑（传了 `outTxtFile` 时默认只回短预览）
        max_chars: max_chars
            .filter(|n| *n > 0)
            .unwrap_or_else(|| default_max_chars(out_txt_file.as_deref())),
        offset: offset.unwrap_or(0),
        // 全文开关由 `parse_targets` 按 `outTxtFile` 统一推导
        full_text: false,
        // OCR 三态语义与原生工具同一份实现；模型目录走 Tauri 宿主（前端没有「资源目录」这个概念）
        ocr: ocr_options(&TauriHost::new(app), ocr_images, None),
    };

    let targets: Vec<ParseTarget> = inputs.into_iter().map(ParseTarget::Path).collect();
    let agg = parse_targets(&targets, &opts, out_txt_file.as_deref(), None).await;
    Ok(ParsedDocumentResult {
        content: agg.content,
        ui_data: agg.ui_data,
        ok: !agg.failed,
    })
}
