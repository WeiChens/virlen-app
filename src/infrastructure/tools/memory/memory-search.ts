/**
 * memory_search — 检索长期记忆（关键词 / 子串，中文可命中）
 *
 * ⚠️ 已原生化：Rust 引擎走 `native_tools/memory/memory_search.rs`（默认路径），本文件是回退路径；
 * 语义（含参数校验文案）统一在 Rust `agent::memory::tools::run_search`，这里只做转发。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolContext, ToolExecutor, ToolResult } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { searchMemories } from '@/infrastructure/memoryRepo'
import { securityService } from '@/services/security-service'

// 工具描述已收敛到权威源（机制 C）：src-tauri/virlen-core/src/agent/tool_defs/definitions.json

toolRegistry.register(
  'memory_search',
  (async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
    // 会话工作目录（已解析）：与注入 / 原生工具同一套项目作用域
    const workspace = await securityService.getWorkspace(ctx.sessionId)
    const out = await searchMemories(
      typeof args.query === 'string' ? args.query : '',
      typeof args.level === 'string' ? args.level : undefined,
      typeof args.kind === 'string' ? args.kind : undefined,
      typeof args.limit === 'number' ? args.limit : undefined,
      workspace || undefined,
    )
    return { content: out.content, uiData: out.uiData }
  }) as ToolExecutor,
  t('检索记忆'),
)
