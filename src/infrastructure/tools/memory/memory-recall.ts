/**
 * memory_recall — 按 id 读取一条记忆的详情正文（无详情 → 如实回「摘要即全文」）
 *
 * ⚠️ 已原生化：Rust 引擎走 `native_tools/memory/memory_recall.rs`（默认路径），本文件是回退路径；
 * 语义统一在 Rust `agent::memory::tools::run_recall`，这里只做转发。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { recallMemory } from '@/infrastructure/memoryRepo'

// 工具描述已收敛到权威源（机制 C）：src-tauri/virlen-core/src/agent/tool_defs/definitions.json

toolRegistry.register(
  'memory_recall',
  (async (args: Record<string, any>, _ctx: any): Promise<ToolResult> => {
    const out = await recallMemory(
      typeof args.memory_id === 'string' ? args.memory_id : '',
    )
    return { content: out.content, uiData: out.uiData }
  }) as ToolExecutor,
  t('读取记忆详情'),
)
