/**
 * list_mcp_resources — 列出已连接的 MCP 服务器声明的资源
 *
 * ⚠️ 只有 Rust 原生实现（`virlen-core/src/agent/native_tools/mcp/`）：资源清单必须来自
 * 服务器自己的 `resources/list`，前端没有任何第二份可查。工具描述在权威源
 * src-tauri/virlen-core/src/agent/tool_defs/definitions.json（机制 C）。
 */
import { toolRegistry } from '@/domain/tools'
import type { ToolExecutor } from '@/domain/tools/types'
import { t } from '@/ui/i18n'
import { nativeOnly } from '../native-only'

toolRegistry.register(
  'list_mcp_resources',
  nativeOnly('list_mcp_resources') as ToolExecutor,
  t('列出 MCP 资源'),
)
