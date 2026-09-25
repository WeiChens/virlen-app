//! `read_file` 工具（原生）— 读取单个文件或 `paths` 批量读取，带行范围与 uiData。

use crate::agent::native_tools::common::{arg_i64, arg_str, arg_str_array, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use crate::file_ops;
use serde_json::{json, Value};

use super::common::format_size;

/// 读取单个文件并返回格式化内容 + uiData（供 read_file_tool 复用）
async fn read_single_file(
    ctx: &NativeToolCtx<'_>,
    path: &str,
    max_lines: usize,
    start_line: usize,
) -> Result<(String, Value), String> {
    let full_path = resolve_safe_path(path, "r", ctx.security)?;
    let full_path_c = full_path.clone();
    let result = tokio::task::spawn_blocking(move || file_ops::read_file(&full_path_c))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Error: failed to read file — {}", e))?;

    let lines: Vec<&str> = result.content.split('\n').collect();
    let total_lines = lines.len();
    let start_idx = (start_line - 1).min(total_lines);
    let end_idx = (start_idx + max_lines).min(total_lines);
    let slice = &lines[start_idx..end_idx];

    let display_start = start_idx + 1;
    let display_end = end_idx;

    let mut header = vec![
        format!("📄 {}", full_path),
        format!("📝 {} lines / {}", total_lines, format_size(result.byte_size)),
        format!("🔑 hash10: {}", result.hash10),
        format!("🔢 Showing: lines {}-{} (total {} lines)", display_start, display_end, total_lines),
    ];
    if start_idx > 0 {
        header.push(format!("💡 Tip: use start_line={} to read more", display_end + 1));
    }
    if display_end < total_lines {
        header.push(format!(
            "💡 Tip: content truncated, {} lines remaining. Use start_line={} to read more",
            total_lines - display_end,
            display_end + 1
        ));
    }

    let displayed = slice.join("\n");
    let content = format!("{}\n\n{}", header.join("\n"), displayed);
    let ui_data = json!({
        "content": displayed,
        "hash10": result.hash10,
        "line_count": result.line_count,
        "byte_size": result.byte_size,
        "fullPath": full_path,
        "startLine": display_start,
        "endLine": display_end,
    });
    Ok((content, ui_data))
}

pub(crate) async fn read_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    // 与 JS `+(max_lines) || 2000` 一致：缺失或 <=0 时取 2000
    let max_lines = match arg_i64(args, "max_lines") {
        Some(n) if n > 0 => n as usize,
        _ => 2000,
    };
    let start_line = arg_i64(args, "start_line").unwrap_or(1).max(1) as usize;

    // 支持 paths 数组（批量读取多个文件）
    let paths = arg_str_array(args, "paths");
    if !paths.is_empty() {
        let mut contents: Vec<String> = Vec::new();
        let mut ui_files: Vec<Value> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        for p in &paths {
            match read_single_file(ctx, p, max_lines, start_line).await {
                Ok((content, ui_data)) => {
                    contents.push(content);
                    ui_files.push(ui_data);
                }
                Err(e) => {
                    errors.push(format!("{} — {}", p, e));
                }
            }
        }

        // 组装结果
        let mut parts: Vec<String> = Vec::new();
        if contents.is_empty() && !errors.is_empty() {
            // 全部失败
            return Ok(NativeToolOutcome::error(errors.join("\n")));
        }
        // 文件之间用分隔线隔开
        for (i, c) in contents.iter().enumerate() {
            if i > 0 {
                parts.push("\n---".to_string());
            }
            parts.push(c.clone());
        }
        if !errors.is_empty() {
            parts.push(format!(
                "\n\n⚠️ Failed to read {} file(s):\n{}",
                errors.len(),
                errors.iter().map(|e| format!("  - {}", e)).collect::<Vec<_>>().join("\n")
            ));
        }

        let ui_data = if ui_files.len() == 1 {
            // 单文件 → 保持原有 uiData 结构（向后兼容）
            ui_files.into_iter().next().unwrap()
        } else {
            // 多文件 → uiData.files 数组
            json!({ "files": ui_files })
        };

        return Ok(NativeToolOutcome::Value {
            content: parts.join("\n"),
            ui_data: Some(ui_data),
        });
    }

    // 单文件路径（向后兼容）
    let path = arg_str(args, "path").unwrap_or_default();
    if path.is_empty() {
        return Err("Missing required parameter: \"path\" or \"paths\"".to_string());
    }
    let (content, ui_data) = read_single_file(ctx, &path, max_lines, start_line).await?;
    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(ui_data),
    })
}
