//! `file_info` 工具（原生）— 返回文件/目录的存在性、类型、大小与访问/修改时间。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::{format_size, format_system_time};

pub(crate) async fn file_info_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "r", ctx.security)?;

    if !std::path::Path::new(&full_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("Error: path does not exist — {}", full_path),
            ui_data: None,
        });
    }

    let metadata = std::fs::metadata(&full_path)
        .map_err(|e| format!("Error: failed to get file info — {}", e))?;

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
        format!("  Type: {}", if is_dir { "📁 Directory" } else { "📄 File" }),
        format!("  Size: {}", format_size(size as usize)),
        if atime.is_empty() {
            String::new()
        } else {
            format!("  Accessed: {}", atime)
        },
        if mtime.is_empty() {
            String::new()
        } else {
            format!("  Modified: {}", mtime)
        },
    ];

    // UI 侧结构化元信息（时间戳毫秒，由组件按界面语言本地化）
    let atime_ms = metadata
        .accessed()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    Ok(NativeToolOutcome::Value {
        content: lines.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"),
        ui_data: Some(json!({
            "path": full_path,
            "isDirectory": is_dir,
            "sizeBytes": size,
            "atimeMs": atime_ms,
            "mtimeMs": mtime_ms,
        })),
    })
}
