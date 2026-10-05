//! `memory_search` 工具（原生）— 检索长期记忆（FTS5 trigram；短查询回退 LIKE）。

use crate::agent::memory::tools::run_search;
use crate::agent::native_tools::common::{arg_i64, arg_str};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};
use serde_json::Value;

use super::common::{deps, to_outcome};

pub(crate) async fn memory_search_tool(
    ctx: &NativeToolCtx<'_>,
    args: &Value,
) -> Result<NativeToolOutcome, String> {
    let query = arg_str(args, "query").unwrap_or_default();
    let level = arg_str(args, "level");
    let kind = arg_str(args, "kind");
    let limit = arg_i64(args, "limit");

    let out = run_search(
        &deps(ctx),
        &query,
        level.as_deref(),
        kind.as_deref(),
        limit,
    )
    .await?;
    Ok(to_outcome(out))
}
