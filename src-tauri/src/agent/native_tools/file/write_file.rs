//! `write_file` 工具（原生）— 全量写入（覆写或创建），返回 hash10 与行/字节统计。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::file_ops;
use serde_json::{json, Value};

use super::common::format_size;

pub(crate) async fn write_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "w", ctx.security)?;
    let content = arg_str(args, "content").unwrap_or_default();

    let result = {
        let full_path_c = full_path.clone();
        let content_c = content.clone();
        tokio::task::spawn_blocking(move || file_ops::write_file(&full_path_c, &content_c))
            .await
            .map_err(|e| format!("Task join error: {}", e))?
            .map_err(|e| format!("Error: failed to write file — {}", e))?
    };

    let existed = result.existed;
    let return_content = if existed {
        format!("✅ File overwritten ({}): {}", format_size(result.byte_size), full_path)
    } else {
        format!("✅ File created ({}): {}", format_size(result.byte_size), full_path)
    };

    Ok(NativeToolOutcome::Value {
        content: format!("{}\n🔑 hash10: {}", return_content, result.hash10),
        ui_data: Some(json!({
            "hash10": result.hash10,
            "fullPath": full_path,
            "lineCount": result.line_count,
            "byteSize": result.byte_size,
        })),
    })
}
