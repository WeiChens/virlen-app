//! `edit_file` 工具（原生）— 基于 `edits` 数组的精确替换（含 expected_hash 冲突检测）。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::file_ops;
use serde_json::{json, Value};

pub(crate) async fn edit_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let path = arg_str(args, "path").unwrap_or_default();
    let full_path = resolve_safe_path(&path, "w", ctx.security)?;
    let expected_hash = arg_str(args, "expected_hash").unwrap_or_default();

    // edits 是唯一入口：必填且不能为空数组
    let edits_arr = args
        .get("edits")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing required parameter: \"edits\" (array)".to_string())?;
    if edits_arr.is_empty() {
        return Err("\"edits\" must be a non-empty array".to_string());
    }

    // 解析 edits 数组
    let mut edits: Vec<file_ops::EditEntry> = Vec::with_capacity(edits_arr.len());
    for (i, e) in edits_arr.iter().enumerate() {
        let old_string = e.get("old_string")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let new_string = e.get("new_string")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let replace_count = e.get("replace_count")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(1);
        if old_string.is_empty() {
            return Err(format!("Edit #{}: old_string is required and cannot be empty", i + 1));
        }
        edits.push(file_ops::EditEntry {
            old_string,
            new_string,
            replace_count,
        });
    }

    let full_path_c = full_path.clone();
    let result = {
        tokio::task::spawn_blocking(move || {
            file_ops::edit_file_multi(&full_path_c, &edits, &expected_hash)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|msg| format!("Error: edit failed — {}", msg))?
    };

    // 构建 uiData：edits 数组，每个元素含上下文和行号（单/多编辑统一返回此结构）
    let ui_edits: Vec<Value> = result.edits.iter().map(|e| {
        let old_line_count = e.old_string_context.split('\n').count();
        let new_line_count = e.new_string_context.split('\n').count();
        json!({
            "oldStartLine": e.old_start_line,
            "oldEndLine": e.old_start_line + old_line_count - 1,
            "newEndLine": e.old_start_line + new_line_count - 1,
            "oldString": e.old_string_context,
            "newString": e.new_string_context,
            "replacedCount": e.replaced_count,
        })
    }).collect();

    let total_replaced: usize = result.edits.iter().map(|e| e.replaced_count).sum();
    let content = format!(
        "✅ File edited: {}\n  - Edits: {} block(s) ({} replacement(s) total)\n  - {} lines in file\n  - hash10: {}",
        full_path, result.edits.len(), total_replaced, result.line_count, result.hash10
    );

    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(json!({
            "fullPath": full_path,
            "hash10": result.hash10,
            "edits": ui_edits,
        })),
    })
}
