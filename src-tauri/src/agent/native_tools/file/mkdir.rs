//! `mkdir` 工具（原生）— 创建目录，支持 `path` 或 `paths`、recursive 开关；已存在的计入 existed。

use crate::agent::native_tools::common::{arg_bool, arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

pub(crate) async fn mkdir_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let recursive = arg_bool(args, "recursive").unwrap_or(true);

    // 兼容单个 path 与多个 paths
    let mut raw_paths: Vec<String> = Vec::new();
    if let Some(arr) = args.get("paths").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(s) = v.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    raw_paths.push(s.to_string());
                }
            }
        }
    }
    if raw_paths.is_empty() {
        if let Some(p) = arg_str(args, "path") {
            let p = p.trim();
            if !p.is_empty() {
                raw_paths.push(p.to_string());
            }
        }
    }

    if raw_paths.is_empty() {
        return Err("错误：请提供 \"path\" 或 \"paths\" 参数".to_string());
    }

    let mut created: Vec<String> = Vec::new();
    let mut existed: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for raw in &raw_paths {
        let full_path = resolve_safe_path(raw, "w", ctx.security)?;
        let path = std::path::Path::new(&full_path);

        if path.exists() {
            existed.push(full_path);
            continue;
        }

        let result = if recursive {
            std::fs::create_dir_all(path)
        } else {
            std::fs::create_dir(path)
        };

        match result {
            Ok(()) => created.push(full_path),
            Err(e) => errors.push(format!("{} — {}", full_path, e)),
        }
    }

    let mut parts: Vec<String> = Vec::new();
    if !created.is_empty() {
        if created.len() == 1 {
            parts.push(format!("📁 已创建目录: {}", created[0]));
        } else {
            parts.push(format!(
                "📁 已创建 {} 个目录:\n{}",
                created.len(),
                created.iter().map(|p| format!("  - {}", p)).collect::<Vec<_>>().join("\n")
            ));
        }
    }
    if !existed.is_empty() {
        if existed.len() == 1 {
            parts.push(format!("ℹ️ 目录已存在: {}", existed[0]));
        } else {
            parts.push(format!(
                "ℹ️ 已存在 {} 个目录:\n{}",
                existed.len(),
                existed.iter().map(|p| format!("  - {}", p)).collect::<Vec<_>>().join("\n")
            ));
        }
    }
    if !errors.is_empty() {
        parts.push(format!(
            "⚠️ 有 {} 个目录创建失败:\n{}",
            errors.len(),
            errors.iter().map(|e| format!("  - {}", e)).collect::<Vec<_>>().join("\n")
        ));
    }

    if created.is_empty() && existed.is_empty() && !errors.is_empty() {
        return Err(errors.join("\n"));
    }

    Ok(NativeToolOutcome::Value {
        content: parts.join("\n"),
        ui_data: Some(json!({
            "created": created,
            "existed": existed,
            "errors": errors,
        })),
    })
}
