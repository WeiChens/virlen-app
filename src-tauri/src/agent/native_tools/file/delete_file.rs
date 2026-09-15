//! `delete_file` 工具（原生）— 删除文件/目录（移至系统回收站），支持单个 `path` 或 `paths` 数组。

use crate::agent::native_tools::common::{arg_str, arg_str_array, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::Value;

pub(crate) async fn delete_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    // 兼容单个 path 与多个 paths；过滤空字符串
    let mut raw_paths = arg_str_array(args, "paths");
    if raw_paths.is_empty() {
        if let Some(p) = arg_str(args, "path") {
            if !p.trim().is_empty() {
                raw_paths.push(p);
            }
        }
    }

    if raw_paths.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "错误：未提供要删除的路径（请使用 \"paths\" 数组，或单个 \"path\" 字符串）".to_string(),
            ui_data: None,
        });
    }

    // 先解析安全路径，单个路径解析失败不影响其他路径
    let mut full_paths: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for p in &raw_paths {
        match resolve_safe_path(p, "w", ctx.security) {
            Ok(fp) => full_paths.push(fp),
            Err(e) => errors.push(format!("{} — {}", p, e)),
        }
    }

    let mut deleted: Vec<String> = Vec::new();

    for full_path in &full_paths {
        if !std::path::Path::new(full_path).exists() {
            errors.push(format!("路径不存在 — {}", full_path));
            continue;
        }

        let full_path_c = full_path.clone();
        match tokio::task::spawn_blocking(move || trash::delete(&full_path_c)).await {
            Ok(Ok(_)) => deleted.push(full_path.clone()),
            Ok(Err(e)) => errors.push(format!("{} — {}", full_path, e)),
            Err(e) => errors.push(format!("{} — Task join error: {}", full_path, e)),
        }
    }

    let mut parts: Vec<String> = Vec::new();
    if deleted.len() == 1 {
        parts.push(format!("🗑️ 已移至回收站: {}", deleted[0]));
    } else if deleted.len() > 1 {
        let list = deleted
            .iter()
            .map(|p| format!("  - {}", p))
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!("🗑️ 已移至回收站 {} 项:\n{}", deleted.len(), list));
    }
    if !errors.is_empty() {
        let list = errors
            .iter()
            .map(|e| format!("  - {}", e))
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!("⚠️ 有 {} 项删除失败:\n{}", errors.len(), list));
    }

    Ok(NativeToolOutcome::Value {
        content: parts.join("\n"),
        ui_data: None,
    })
}
