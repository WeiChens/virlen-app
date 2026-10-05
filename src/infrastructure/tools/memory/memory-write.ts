/**
 * memory_write — 写入一条长期记忆（`detail` 非空 → 详情落专用知识库，条目只留 link）
 *
 * ⚠️ 已原生化：Rust 引擎走 `native_tools/memory/memory_write.rs`（默认路径），本文件是回退路径；
 * 语义统一在 Rust `agent::memory::tools::run_write`，这里只做转发。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { writeMemory } from '@/infrastructure/memoryRepo'
import { securityService } from '@/services/security-service'

// 工具描述已收敛到权威源（机制 C）：src-tauri/virlen-core/src/agent/tool_defs/definitions.json

toolRegistry.register(
  'memory_write',
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    // 会话工作目录（已解析）：`kind = project` 时它成为这条记忆的作用域（与原生工具同口径 ——
    // 模型不必猜路径，也不会把别的项目写进来）
    const workspace = await securityService.getWorkspace(ctx.sessionId)
    const out = await writeMemory({
      summary: typeof args.summary === 'string' ? args.summary : '',
      kind: typeof args.kind === 'string' ? args.kind : '',
      level: typeof args.level === 'string' ? args.level : undefined,
      detail: typeof args.detail === 'string' ? args.detail : undefined,
      // 来源会话：溯源用（Rust 侧写进 `source_session_id`）
      sessionId: ctx?.sessionId,
      workspace: workspace || undefined,
    })
    return { content: out.content, uiData: out.uiData }
  }) as ToolExecutor,
  t('写入记忆'),
)
