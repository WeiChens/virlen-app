//! `search_files_by_name` 工具（原生）— 按文件名搜索（纯文本 / 正则 / glob），带取消支持。

use crate::agent::native_tools::common::{arg_bool, arg_i64, arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::common::glob_to_regex;

pub(crate) async fn search_files_by_name_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let query = arg_str(args, "query").unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "Missing required parameter: \"query\". Please provide a filename pattern to search for.".to_string(),
            ui_data: Some(json!({ "length": 0, "items": [] })),
        });
    }

    let root = resolve_safe_path(&arg_str(args, "path").unwrap_or_else(|| ".".into()), "r", ctx.security)?;
    let use_regex = arg_bool(args, "use_regex").unwrap_or(false);
    let glob = arg_bool(args, "glob").unwrap_or(false);
    let max_results = arg_i64(args, "max_results").unwrap_or(30).clamp(1, 500) as usize;

    let mut effective_query = query.clone();
    let mut effective_use_regex = use_regex;
    if glob {
        effective_query = glob_to_regex(&query);
        effective_use_regex = true;
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let flag = cancel_flag.clone();
    let root_c = root.clone();
    let q = effective_query.clone();
    let task = tokio::task::spawn_blocking(move || {
        // include_hidden=true + 空剪枝清单 = **保持工具原有行为**：
        // 模型可以用显式路径 / glob 表达「就要搜 node_modules」，「默认剪掉依赖目录」
        // 是侧边栏搜索框的取舍（无表达手段），不能拿来削弱工具能力。
        crate::search::search_files_by_name(&root_c, &q, effective_use_regex, max_results, &flag, true, &[], &[])
    });

    let results = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            cancel_flag.store(true, Ordering::SeqCst);
            return Ok(NativeToolOutcome::Error(format!("[Search cancelled] Search for \"{}\" was cancelled.", query)));
        }
        r = task => r.map_err(|e| format!("Search failed: {}", e))?,
    };

    let results: Vec<String> = results.into_iter().map(|r| r.path).collect();

    if results.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: format!("No files matching \"{}\" found in {}.", query, arg_str(args, "path").unwrap_or_else(|| ".".into())),
            ui_data: Some(json!({ "length": 0, "items": [] })),
        });
    }

    let content = format!(
        "🔍 {} file(s) matching \"{}\":\n{}",
        results.len(),
        query,
        results.iter().map(|p| format!("  📄 {}", p)).collect::<Vec<_>>().join("\n")
    );

    Ok(NativeToolOutcome::Value {
        content,
        ui_data: Some(json!({ "length": results.len(), "items": results })),
    })
}
