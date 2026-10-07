//! memory — 分类内公共：从工具上下文组装记忆操作依赖、结果转换。

use crate::agent::memory::tools::{MemoryToolDeps, MemoryToolOutput};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};

/// 从工具上下文取出记忆操作依赖：`repo`（库打不开时 Noop → 工具如实回
/// 「本地存储不可用」）、`rag`（未初始化 → `None`，仅降级「详情落不了库」，不影响记忆条目）、
/// `session_id`（溯源）、`workspace`（给项目记忆定作用域 / 筛掉别的项目）。
pub(super) fn deps<'a>(ctx: &'a NativeToolCtx<'_>) -> MemoryToolDeps<'a> {
    MemoryToolDeps {
        repo: ctx.memory,
        settings: ctx.settings,
        rag: crate::rag::get_service().ok(),
        session_id: ctx.session_id,
        workspace: &ctx.security.workspace,
        now_ms: crate::telemetry::now_ms(),
    }
}

/// 工具结果 → 统一出口。记忆工具的失败都是「业务级结论」，一律走 `Value`（模型看到
/// `No memories found` 才知道换关键词）。
pub(super) fn to_outcome(out: MemoryToolOutput) -> NativeToolOutcome {
    NativeToolOutcome::Value {
        content: out.content,
        ui_data: Some(out.ui_data),
    }
}
