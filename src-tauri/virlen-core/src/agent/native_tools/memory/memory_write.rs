//! `memory_write` 工具（原生）— 写入一条长期记忆（`detail` 非空 → 详情落专用知识库）。

use crate::agent::memory::tools::{run_write, WriteRequest};
use crate::agent::native_tools::common::arg_str;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::Value;

use super::common::{deps, to_outcome};

pub(crate) async fn memory_write_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let summary = arg_str(args, "summary").unwrap_or_default();
    let kind = arg_str(args, "kind").unwrap_or_default();
    let level = arg_str(args, "level");
    let detail = arg_str(args, "detail");

    let out = run_write(
        &deps(ctx),
        WriteRequest {
            summary: &summary,
            kind: &kind,
            level: level.as_deref(),
            detail: detail.as_deref(),
        },
    )
    .await?;
    Ok(to_outcome(out))
}
