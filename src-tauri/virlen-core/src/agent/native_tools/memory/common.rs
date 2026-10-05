//! memory — 分类内公共：从工具上下文组装记忆操作依赖、结果转换。

use crate::agent::memory::tools::{MemoryToolDeps, MemoryToolOutput};
use crate::agent::native_tools::{NativeToolCtx, NativeToolOutcome};

/// 从工具上下文取出记忆操作依赖。
///
/// - `repo`：记忆仓储（库打不开时是 `NoopMemoryRepo` → 工具如实回「本地存储不可用」）；
/// - `rag`：RAG 服务未初始化（无库环境 / 浏览器 dev）→ `None`，工具降级为
///   「详情落不了库 / 读不到详情」，**不影响**记忆条目本身；
/// - `session_id`：写入时记进 `source_session_id`，让每条记忆都能溯源到会话。
pub(super) fn deps<'a>(ctx: &'a NativeToolCtx<'_>) -> MemoryToolDeps<'a> {
    MemoryToolDeps {
        repo: ctx.memory,
        settings: ctx.settings,
        rag: crate::rag::get_service().ok(),
        session_id: ctx.session_id,
        now_ms: crate::telemetry::now_ms(),
    }
}

/// 工具结果 → 统一出口（记忆工具的失败都是「业务级结论」，因此一律走 `Value`：
/// 与 `search_knowledge_base` 同款 —— 模型看到 `No memories found` 才知道下一步该换关键词）
pub(super) fn to_outcome(out: MemoryToolOutput) -> NativeToolOutcome {
    NativeToolOutcome::Value {
        content: out.content,
        ui_data: Some(out.ui_data),
    }
}
