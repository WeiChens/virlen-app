//! `search_text_in_files` 工具（原生）— 按文件内容（正则）搜索，输出带 32000 字符截断。

use crate::agent::native_tools::common::{arg_i64, arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub(crate) async fn search_text_in_files_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let query = arg_str(args, "query").unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"query\". Please provide a text or regex pattern to search for.".to_string(),
            ui_data: Some(json!({ "length": 0 })),
        });
    }

    let root = resolve_safe_path(&arg_str(args, "path").unwrap_or_else(|| ".".into()), "r", ctx.security)?;
    let max_results = arg_i64(args, "max_results").unwrap_or(30).clamp(1, 500) as usize;

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let flag = cancel_flag.clone();
    let root_c = root.clone();
    let q = query.clone();
    let task = tokio::task::spawn_blocking(move || {
        crate::search::search_text_in_files(&root_c, &q, max_results, &flag)
    });

    let results = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            cancel_flag.store(true, Ordering::SeqCst);
            return Ok(NativeToolOutcome::error(format!("[Search cancelled] Search for \"{}\" was cancelled.", query)));
        }
        r = task => r.map_err(|e| format!("Search failed: {}", e))?,
    };

    const MAX_CHARS: usize = 32000;
    let mut output = format!("🔍 {} match(es) for \"{}\":\n", results.len(), query);
    for r in &results {
        let line = format!("  📄 {}:{}  {}", r.path, r.line_number, r.line.trim());
        if output.len() + line.len() + 1 > MAX_CHARS {
            output.push_str(&format!("\n... (truncated, {} total matches)", results.len()));
            break;
        }
        output.push_str(&line);
        output.push('\n');
    }

    Ok(NativeToolOutcome::Value {
        content: output,
        ui_data: Some(json!({ "length": results.len() })),
    })
}
