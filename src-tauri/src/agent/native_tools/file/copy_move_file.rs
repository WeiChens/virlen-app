//! `copy_move_file` 工具（原生）— 移动（rename，跨设备自动降级 copy+remove）或复制文件。
//! 目录仅支持 move 模式。

use crate::agent::native_tools::common::{arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};

use super::common::ensure_parent_dir;

pub(crate) async fn copy_move_file_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let source = arg_str(args, "source").unwrap_or_default();
    let dest = arg_str(args, "destination").unwrap_or_default();
    let mode = arg_str(args, "mode").unwrap_or_else(|| "move".to_string());

    let source_path = resolve_safe_path(&source, "r", ctx.security)?;
    let dest_path = resolve_safe_path(&dest, "w", ctx.security)?;

    if !std::path::Path::new(&source_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("错误：源路径不存在 — {}", source_path),
            ui_data: None,
        });
    }
    if std::path::Path::new(&dest_path).exists() {
        return Ok(NativeToolOutcome::Value {
            content: format!("错误：目标路径已存在 — {}，请先删除或选择其他路径", dest_path),
            ui_data: None,
        });
    }

    let is_dir = std::fs::metadata(&source_path)
        .map(|m| m.is_dir())
        .unwrap_or(false);

    if mode == "move" {
        match std::fs::rename(&source_path, &dest_path) {
            Ok(_) => {}
            Err(e) => {
                // rename 跨设备会失败，此时尝试 copy+remove（仅文件）
                let cross_device = matches!(
                    e.raw_os_error(),
                    Some(18) | Some(17) // Unix EXDEV / Windows ERROR_NOT_SAME_DEVICE
                );
                if cross_device && !is_dir {
                    ensure_parent_dir(&dest_path)?;
                    std::fs::copy(&source_path, &dest_path)
                        .map_err(|e| format!("错误：移动失败 — {}", e))?;
                    std::fs::remove_file(&source_path)
                        .map_err(|e| format!("错误：移动失败（清理源文件） — {}", e))?;
                } else {
                    return Err(format!("错误：移动失败 — {}", e));
                }
            }
        }
        let type_str = if is_dir { "目录" } else { "文件" };
        Ok(NativeToolOutcome::Value {
            content: format!("✅ 已移动{}: {}\n   → {}", type_str, source_path, dest_path),
            ui_data: Some(json!({
                "mode": "move",
                "source": source_path,
                "destination": dest_path,
                "isDirectory": is_dir,
            })),
        })
    } else {
        if is_dir {
            return Ok(NativeToolOutcome::Value {
                content: "错误：暂不支持复制目录，请使用 move 模式移动目录，或逐个复制目录内的文件".to_string(),
                ui_data: None,
            });
        }
        ensure_parent_dir(&dest_path)?;
        std::fs::copy(&source_path, &dest_path)
            .map_err(|e| format!("错误：复制失败 — {}", e))?;
        Ok(NativeToolOutcome::Value {
            content: format!("✅ 已复制文件: {}\n   → {}", source_path, dest_path),
            ui_data: Some(json!({
                "mode": "copy",
                "source": source_path,
                "destination": dest_path,
                "isDirectory": false,
            })),
        })
    }
}
