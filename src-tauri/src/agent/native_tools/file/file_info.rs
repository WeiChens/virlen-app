//! `file_info` 工具（原生）— 返回文件/目录的存在性、类型、大小与访问/修改时间。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::Value;

use super::common::{format_size, format_system_time};

pub(crate) async fn file_info_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "r", ctx.security)?;

    if !std::path::Path::new(&full_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("错误：路径不存在 — {}", full_path),
            ui_data: None,
        });
    }

    let metadata = std::fs::metadata(&full_path)
        .map_err(|e| format!("错误：获取信息失败 — {}", e))?;

    let is_dir = metadata.is_dir();
    let size = metadata.len();
    let atime = metadata
        .accessed()
        .ok()
        .map(|t| format_system_time(t))
        .unwrap_or_default();
    let mtime = metadata
        .modified()
        .ok()
        .map(|t| format_system_time(t))
        .unwrap_or_default();

    let lines = vec![
        format!("📋 {}", full_path),
        format!("  类型: {}", if is_dir { "📁 目录" } else { "📄 文件" }),
        format!("  大小: {}", format_size(size as usize)),
        if atime.is_empty() {
            String::new()
        } else {
            format!("  访问时间: {}", atime)
        },
        if mtime.is_empty() {
            String::new()
        } else {
            format!("  修改时间: {}", mtime)
        },
    ];

    Ok(NativeToolOutcome::Value {
        content: lines.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"),
        ui_data: None,
    })
}
