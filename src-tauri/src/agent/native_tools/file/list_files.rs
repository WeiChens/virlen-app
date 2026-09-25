//! `list_files` 工具（原生）— 目录树列举（可递归 / 含隐藏项），输出树形文本 + items uiData。

use crate::agent::native_tools::common::{arg_bool, arg_i64, arg_str, resolve_safe_path};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::common::format_size;

fn build_tree_rec(entries: &[crate::search::DirEntry], idx: &mut usize) -> Vec<TreeNode> {
    use crate::search::DirEntryType;
    let mut nodes = Vec::new();
    while *idx < entries.len() {
        match entries[*idx].r#type {
            DirEntryType::EnterDir => {
                let name = entries[*idx].name.clone();
                *idx += 1;
                let children = build_tree_rec(entries, idx);
                nodes.push(TreeNode {
                    name,
                    is_dir: true,
                    size: None,
                    children,
                });
            }
            DirEntryType::LeaveDir => {
                *idx += 1;
                return nodes;
            }
            _ => {
                nodes.push(TreeNode {
                    name: entries[*idx].name.clone(),
                    is_dir: entries[*idx].r#type == DirEntryType::Dir,
                    size: entries[*idx].size,
                    children: vec![],
                });
                *idx += 1;
            }
        }
    }
    nodes
}

struct TreeNode {
    name: String,
    is_dir: bool,
    size: Option<u64>,
    children: Vec<TreeNode>,
}

fn render_tree(
    nodes: &[TreeNode],
    prefix: &str,
    skip_dirs: &[String],
    lines: &mut Vec<String>,
    count: &mut usize,
    max: usize,
) {
    for (i, node) in nodes.iter().enumerate() {
        if *count >= max {
            break;
        }
        let is_last = i == nodes.len() - 1;
        let connector = if is_last { "└── " } else { "├── " };
        let next_prefix = format!("{}{}", prefix, if is_last { "    " } else { "│   " });
        let size_str = if !node.is_dir {
            if let Some(sz) = node.size {
                format!("  ({})", format_size(sz as usize))
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let skip_mark = if node.is_dir && skip_dirs.contains(&node.name) {
            "  # elided"
        } else {
            ""
        };
        lines.push(format!(
            "{}{}{}{}{}{}",
            prefix,
            connector,
            node.name,
            if node.is_dir { "/" } else { "" },
            size_str,
            skip_mark
        ));
        *count += 1;
        if !node.children.is_empty() {
            render_tree(&node.children, &next_prefix, skip_dirs, lines, count, max);
        }
    }
}

fn tree_to_json(nodes: &[TreeNode], skip_dirs: &[String]) -> Vec<Value> {
    nodes
        .iter()
        .map(|n| {
            let mut obj = serde_json::Map::new();
            obj.insert("name".to_string(), Value::String(n.name.clone()));
            obj.insert("isDir".to_string(), Value::Bool(n.is_dir));
            if let Some(sz) = n.size {
                obj.insert("size".to_string(), json!(sz));
            }
            if n.is_dir && skip_dirs.contains(&n.name) {
                obj.insert("elided".to_string(), Value::Bool(true));
            }
            if !n.children.is_empty() {
                obj.insert(
                    "children".to_string(),
                    Value::Array(tree_to_json(&n.children, skip_dirs)),
                );
            }
            Value::Object(obj)
        })
        .collect()
}

pub(crate) async fn list_files_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    use crate::search::DirEntryType;
    let dir_path = arg_str(args, "path").unwrap_or_else(|| ".".into());
    let recursive = arg_bool(args, "recursive").unwrap_or(false);
    let include_hidden = arg_bool(args, "includeHidden").unwrap_or(false);
    let max_depth = arg_i64(args, "maxDepth").unwrap_or(5).max(0) as usize;

    let raw_dir = resolve_safe_path(&dir_path, "r", ctx.security)?;
    let skip_dirs = ctx.security.skip_dirs.clone();

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let flag = cancel_flag.clone();
    let raw_dir_c = raw_dir.clone();
    let skip_c = skip_dirs.clone();
    let task = tokio::task::spawn_blocking(move || {
        crate::search::list_directory(
            &raw_dir_c,
            recursive,
            include_hidden,
            max_depth,
            &skip_c,
            &flag,
        )
    });

    let entries = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            cancel_flag.store(true, Ordering::SeqCst);
            return Ok(NativeToolOutcome::error("[Search cancelled] Directory listing was cancelled."));
        }
        r = task => r.map_err(|e| format!("Directory listing failed: {}", e))?,
    };

    if entries.is_empty() {
        return Ok(NativeToolOutcome::Value {
            content: "(empty directory)".to_string(),
            ui_data: Some(json!({
                "count": 0,
                "items": [],
                "rootPath": raw_dir,
                "nodes": [],
                "totalItems": 0,
                "maxItems": MAX_ITEMS,
                "truncated": false,
            })),
        });
    }

    // 构建相对路径条目（uiData）
    let mut path_stack: Vec<String> = Vec::new();
    let mut items: Vec<Value> = Vec::new();
    for e in &entries {
        match e.r#type {
            DirEntryType::EnterDir => {
                path_stack.push(e.name.clone());
                items.push(json!({ "path": path_stack.join("/"), "isDir": true }));
            }
            DirEntryType::LeaveDir => {
                path_stack.pop();
            }
            _ => {
                let full = if path_stack.is_empty() {
                    e.name.clone()
                } else {
                    format!("{}/{}", path_stack.join("/"), e.name)
                };
                items.push(json!({ "path": full, "isDir": e.r#type == DirEntryType::Dir }));
            }
        }
    }

    const MAX_ITEMS: usize = 600;
    let total_items = items.len();
    let truncated = total_items > MAX_ITEMS;
    items.truncate(MAX_ITEMS);

    let tree = {
        let mut idx = 0;
        build_tree_rec(&entries, &mut idx)
    };

    let mut lines: Vec<String> = vec![raw_dir.clone()];
    let mut count = 0usize;
    render_tree(&tree, "", &skip_dirs, &mut lines, &mut count, MAX_ITEMS);

    let summary = if truncated {
        format!("\n\n⚠️ Too many files; showing only the first {} of {} item(s)", MAX_ITEMS, total_items)
    } else {
        format!("\n\n{} item(s) total", total_items)
    };

    let nodes_json = tree_to_json(&tree, &skip_dirs);

    Ok(NativeToolOutcome::Value {
        content: lines.join("\n") + &summary,
        ui_data: Some(json!({
            "count": items.len(),
            "items": items,
            "rootPath": raw_dir,
            "nodes": nodes_json,
            "totalItems": total_items,
            "maxItems": MAX_ITEMS,
            "truncated": truncated,
        })),
    })
}
