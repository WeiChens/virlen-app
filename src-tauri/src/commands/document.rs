//! 文档解析（`parse_document` 工具）的 **Tauri 命令层**（GUI 壳）
//!
//! 只做「参数兜底 + 转交」：解析在 `virlen_core::doc_parse`，模型侧文本 / `uiData` 的版式在
//! `virlen_core::agent::native_tools::file::parse_document::parse_targets`
//! （**与原生工具同一条组装链**，否则两条路径的版式与失败语义会静默分叉）。
//!
//! ⚠️ 路径安全由**前端**先做完（`securityService.resolveSafePath`，与 `read_file_with_hash`
//! 同一种约定：命令只认已经校验过的路径）。Rust 引擎的原生工具路径不经过这里，它自己走
//! `resolve_safe_path`（黑名单 > 白名单 > 工作目录；`outTxtFile` 走**写模式**）。
//! ⚠️ 新增命令必须登记到 `src/lib.rs` 的 `generate_handler![...]`（铁律 4），否则前端 invoke 静默 404。

use virlen_core::agent::native_tools::{default_max_chars, parse_targets, ParseTarget};
use virlen_core::doc_parse::ParseOptions;

/// 解析结果：模型侧文本（固定英文）+ 界面侧结构化数据 + 是否全部失败
///
/// `ok == false` 时前端执行器要把它当**失败**抛出（与原生工具 `NativeToolOutcome::Error` 同语义）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocumentResult {
    pub content: String,
    pub ui_data: serde_json::Value,
    pub ok: bool,
}

/// 解析一份或多份文档（TS 回退路径 / 浏览器 dev；默认引擎走原生工具，不经过这里）
#[tauri::command]
pub async fn cmd_parse_document(
    path: Option<String>,
    paths: Option<Vec<String>>,
    sheet: Option<String>,
    max_chars: Option<usize>,
    offset: Option<usize>,
    out_txt_file: Option<String>,
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
    };

    let targets: Vec<ParseTarget> = inputs.into_iter().map(ParseTarget::Path).collect();
    let agg = parse_targets(&targets, &opts, out_txt_file.as_deref()).await;
    Ok(ParsedDocumentResult {
        content: agg.content,
        ui_data: agg.ui_data,
        ok: !agg.failed,
    })
}
