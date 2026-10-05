//! `memory_recall` 工具（原生）— 按 id 取一条记忆的详情正文（无详情 → 如实回「摘要即全文」）。

use crate::agent::memory::tools::run_recall;
use crate::agent::native_tools::common::arg_str;
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::Value;

use super::common::{deps, to_outcome};

pub(crate) async fn memory_recall_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let memory_id = arg_str(args, "memory_id").unwrap_or_default();
    let out = run_recall(&deps(ctx), &memory_id).await?;
    Ok(to_outcome(out))
}
